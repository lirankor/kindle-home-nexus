// /api/voice/* — the voice bridge for Home Assistant Assist (rest_command + rest sensor, see docs/KINDLE-APP.md
// in the homeserver-cloud repo). Bearer VOICE_TOKEN (env; unset = 503). Thin and additive: validate, call the
// same media.server functions the Kindle screens use (queue, power-on job, radio tuning), answer compact JSON.
//   GET  /api/voice/state                       now playing, amp, queue summary (polled by HA every 20 s)
//   GET  /api/voice/search?q=&kind=&limit=      artists (+ their albums), albums, tracks, playlists (+ the mix a query names)
//   GET  /api/voice/list?kind=artist|album|mix|radio&sort=name|random&limit=&offset=[&artist=<id>]   plain lists for pickers
// Music source (bus task 031): MUSIC_BACKEND=ha reads Music Assistant through kindle_panel's library_list / library_search
// (ids = MA uris such as library://album/143, `art` = MA image proxy URLs); the legacy app backend reads Jellyfin.
//   POST /api/voice/play   {query|id, kind?, shuffle?, wait?}   power the amp on if needed, then play
//   POST /api/voice/action {op}                 pause|resume|next|previous|stop|volume_up|volume_down|mute|unmute|amp_off|amp_on
//   POST /api/voice/radio  {station, wait?}     fuzzy-match a catalog station and tune NET RADIO
//   GET  /api/voice/art?station=<id>[&width=]  the station's art as a colour PNG: its logo when that is a real image,
//                                              else a cover-forge placeholder (no token: catalog ids only, the port is
//                                              loopback-bound; HA's image entity fetches it server-side)
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { haConfigured, service } from "@/lib/home.server";
import { haBackend } from "@/lib/media-ha.server";
import { maArtistAlbums, maCandidates, maListData, maMixPlaylists } from "@/lib/voice-ma.server";
import { ensurePanelConfig } from "@/lib/panel-config.server";
import { AMP, MIX_IDS, RADIO_LISTS, findStation } from "@/lib/media";
import type { AmpSource, MediaAction, MediaSnapshot, QueueProgress } from "@/lib/media";
import {
  maMixFor,
  matchScore,
  matchStation,
  mixFor,
  norm,
  pickBest,
  queueSummary,
  stationIdAt,
  stationName,
  stripFiller,
} from "@/lib/voice-match";
import type { Candidate, VoiceKind } from "@/lib/voice-match";
import {
  POWER_ON_TIMEOUT_MS,
  amp,
  ampConfigured,
  dedupeShuffle,
  getQueueProgress,
  jellyfin,
  jellyfinConfigured,
  mediaErrorMessage,
  performMediaAction,
  playSelection,
  powerOnDone,
  powerOnStatus,
  readMediaSnapshot,
  readRadioLists,
  startPowerOn,
  stationArtPng,
  stationArtSource,
  startQueue,
  tuneRadio,
} from "@/lib/media.server";

// ---- Plumbing ----
const env = (name: string) => (process.env[name] ?? "").trim();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, ...extra }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The UI polls the power-on job every 2 s; the job itself gives up after POWER_ON_TIMEOUT_MS. */
const POWER_POLL_MS = 2000;
const vlog = (msg: string) => console.log(`[voice] ${new Date().toISOString()} ${msg}`);
/** Where HA reaches this app (the compose line publishes :3000 as 127.0.0.1:8791). */
const artBase = () => env("VOICE_ART_BASE").replace(/\/+$/, "") || "http://127.0.0.1:8791";
/** A catalog station's art for HA: the catalogue logo URL and our colour PNG proxy (HA's image entity). artUrl
 *  is only set once the art route has actually resolved a picture (a real logo, else a cover-forge cover), so HA
 *  never gets a URL that 404s; artSource says which it is. */
async function stationArt(stationId: string | null | undefined) {
  const st = stationId ? findStation(stationId) : undefined;
  const artSource = st ? await stationArtSource(st.id).catch(() => null) : null;
  return {
    stationId: st?.id ?? null,
    logo: st?.logo ?? null,
    artSource,
    artUrl:
      st && artSource ? `${artBase()}/api/voice/art?station=${encodeURIComponent(st.id)}` : null,
  };
}

function authorized(request: Request): boolean {
  const token = env("VOICE_TOKEN");
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const given = h.toLowerCase().startsWith("bearer ")
    ? h.slice(7).trim()
    : (request.headers.get("x-voice-token") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function stateView(s: MediaSnapshot | null, queue: QueueProgress | null, error?: string) {
  const nowArt = s ? await stationArt(s.nowPlaying.stationId) : null;
  const radioArt = s?.radio ? await stationArt(stationIdAt(s.radio)) : null;
  return {
    ok: !error,
    ...(error === undefined ? {} : { error }),
    amp: s
      ? {
          available: s.amp.available,
          on: s.amp.on,
          state: s.amp.state,
          playing: s.amp.playing,
          source: s.amp.source,
          volumeDb: s.amp.volumeDb,
          muted: s.amp.muted,
          plugOn: s.plugOn,
        }
      : null,
    powerOn: s?.powerOn
      ? {
          running: s.powerOn.running,
          step: s.powerOn.step,
          elapsedMs: s.powerOn.elapsedMs,
          ...(s.powerOn.error === undefined ? {} : { error: s.powerOn.error }),
        }
      : null,
    nowPlaying: s
      ? {
          kind: s.nowPlaying.kind,
          title: s.nowPlaying.title,
          artist: s.nowPlaying.artist,
          album: s.nowPlaying.album,
          station: s.nowPlaying.station,
          ...nowArt,
        }
      : null,
    queue: queueSummary(queue),
    radio: s?.radio ? { ...s.radio, station: stationName(s.radio), ...radioArt } : null,
    updatedAt: new Date().toISOString(),
  };
}
async function currentState(error?: string) {
  let snapshot: MediaSnapshot | null = null;
  let err = error;
  if (haConfigured())
    try {
      snapshot = await readMediaSnapshot();
    } catch (e) {
      err ??= mediaErrorMessage(e);
    }
  else err ??= "HA not configured";
  return stateView(snapshot, snapshot?.queue ?? (await getQueueProgress()), err);
}

// ---- Search ----
// (zod schemas are built per request on purpose: the UI tests import the route tree, and zod cannot be
//  evaluated at module load under vitest-jsdom — see app-routing.test.tsx, which already fails for that reason.)
const searchSchema = () =>
  z.object({
    q: z.string().trim().min(1).max(80),
    kind: z.enum(["artist", "album", "track", "playlist", "any"]).default("any"),
    limit: z.coerce.number().int().min(1).max(25).default(10),
  });
/** Jellyfin's searchTerm matches word starts, so "the eagles" would miss "Eagles": search without the article. */
const term = (q: string) => norm(q) || q.trim();
async function candidates(rawQuery: string, kind: VoiceKind | "auto", limit: number) {
  const query = stripFiller(rawQuery) || rawQuery;
  if (haBackend()) return maCandidates(query, kind, limit);
  const t = term(query);
  const want = (k: VoiceKind) => kind === "auto" || kind === k;
  const [artists, albums, tracks, playlists] = await Promise.all([
    want("artist") ? jellyfin.searchAlbumArtists(t, limit) : [],
    want("album") ? jellyfin.searchAlbums(t, limit) : [],
    want("track") ? jellyfin.searchTracks(t, limit) : [],
    want("playlist") ? jellyfin.searchPlaylists(t, limit) : [],
  ]);
  const out: Candidate[] = [
    ...artists.map((a) => ({
      kind: "artist" as const,
      id: a.id,
      title: a.title,
      score: matchScore(a.title, query),
    })),
    ...albums.map((a) => ({
      kind: "album" as const,
      id: a.id,
      title: a.title,
      artist: a.detail.split(" · ")[0] || null,
      score: matchScore(a.title, query),
    })),
    ...tracks.map((tr) => ({
      kind: "track" as const,
      id: tr.id,
      title: tr.title,
      artist: tr.artist,
      album: tr.album,
      score: matchScore(tr.title, query),
    })),
    ...playlists.map((p) => ({
      kind: "playlist" as const,
      id: p.id,
      title: p.title,
      score: matchScore(p.title, query),
    })),
  ];
  return out;
}
async function search(params: URLSearchParams) {
  const parsed = searchSchema().safeParse(Object.fromEntries(params));
  if (!parsed.success) return fail("bad query: q, kind?, limit?");
  const ma = haBackend();
  if (!ma && !jellyfinConfigured()) return fail("Jellyfin not configured", 503);
  const { q, kind, limit } = parsed.data;
  let cands: Candidate[];
  try {
    cands = await candidates(q, kind === "any" ? "auto" : kind, limit);
  } catch (e) {
    return fail(mediaErrorMessage(e), 502);
  }
  const by = (k: VoiceKind) =>
    cands
      .filter((c) => c.kind === k)
      .sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  const artists = by("artist").slice(0, kind === "any" ? 3 : limit);
  const top = artists[0];
  // An artist that clearly matches gets their discography (year + track count) so "play the second one" works.
  const albumsOf =
    top && top.score >= 60
      ? ma
        ? await maArtistAlbums(top.id).catch(() => [])
        : (await jellyfin.artistAlbums(top.id)).map((a) => ({
            id: a.id,
            title: a.title,
            year: a.year ?? null,
            tracks: a.trackCount ?? null,
          }))
      : [];
  // MA only: `art` (MA image proxy URL, HA fetches it) and the nightly mix a query names ("80s", "jazz mix")
  const art = (c: Candidate) => (ma ? { art: c.art ?? null } : {});
  const mixName = ma && (kind === "any" || kind === "playlist") ? maMixFor(q) : null;
  const mix = mixName
    ? ((await maMixPlaylists().catch(() => [])).find((m) => m.mix === mixName.id) ?? null)
    : null;
  return json({
    ok: true,
    query: q,
    kind,
    artists: artists.map((a) => ({
      id: a.id,
      name: a.title,
      ...art(a),
      ...(a.id === top?.id && albumsOf.length ? { albums: albumsOf } : {}),
    })),
    albums: by("album")
      .slice(0, limit)
      .map((a) => ({
        id: a.id,
        title: a.title,
        artist: a.artist ?? null,
        ...(ma ? { year: a.year ?? null } : {}),
        ...art(a),
      })),
    tracks: by("track")
      .slice(0, kind === "any" ? 5 : limit)
      .map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist ?? null,
        album: t.album ?? null,
        ...art(t),
      })),
    playlists: by("playlist")
      .slice(0, limit)
      .map((p) => ({ id: p.id, title: p.title, ...art(p) })),
    ...(ma ? { mix } : {}),
  });
}

// ---- List (the HA Music dashboard's dropdown pickers need plain lists, not a search) ----
const listSchema = () =>
  z.object({
    kind: z.enum(["artist", "album", "mix", "radio"]),
    sort: z.enum(["name", "random"]).default("name"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    /** kind=album only: the discography of this album artist (an MA artist uri such as library://artist/998; a
     *  Jellyfin id on the legacy app backend) instead of the whole library. */
    artist: z
      .string()
      .regex(/^([A-Za-z0-9_-]{1,64}|[a-z0-9_-]{1,64}:\/\/artist\/[A-Za-z0-9_.%-]{1,200})$/)
      .optional(),
  });
async function list(params: URLSearchParams) {
  const parsed = listSchema().safeParse(Object.fromEntries(params));
  if (!parsed.success)
    return fail("bad query: kind=artist|album|mix|radio, sort?, limit?, offset?, artist?");
  const { kind, sort, limit, offset, artist } = parsed.data;
  if (kind === "radio") {
    // The Kindle's bands in its order: favourites (YTuner bookmarks, runtime) then the catalog lists.
    const r = await readRadioLists();
    return json({
      ok: true,
      kind,
      ...(r.error === undefined ? {} : { error: r.error }),
      lists: r.lists.map((l) => ({
        id: l.id,
        stations: l.stations.map((s) => ({ id: s.id, name: s.name, favourite: s.favourite })),
      })),
    });
  }
  if (haBackend()) {
    try {
      return await maList(kind, sort, limit, offset, artist);
    } catch (e) {
      return fail(mediaErrorMessage(e), 502);
    }
  }
  if (kind === "mix") return fail("kind=mix needs Music Assistant (MUSIC_BACKEND=ha)", 409);
  if (!jellyfinConfigured()) return fail("Jellyfin not configured", 503);
  if (kind === "album" && artist) {
    const albums = await jellyfin.artistAlbums(artist); // oldest first, with year + track count
    return json({
      ok: true,
      kind,
      artist,
      total: albums.length,
      offset: 0,
      items: albums.map((a) => ({
        id: a.id,
        title: a.title,
        year: a.year ?? null,
        tracks: a.trackCount ?? null,
      })),
    });
  }
  const page =
    kind === "artist"
      ? await jellyfin.listAlbumArtists(limit, offset, sort === "random")
      : await jellyfin.listAlbums(limit, offset, sort === "random");
  return json({ ok: true, kind, sort, offset, total: page.total, items: page.items });
}

/** The pickers' lists from Music Assistant (bus task 031), see voice-ma.server.ts. */
async function maList(
  kind: "artist" | "album" | "mix",
  sort: "name" | "random",
  limit: number,
  offset: number,
  artist: string | undefined,
) {
  const r = await maListData(kind, sort, limit, offset, artist);
  return "error" in r ? fail(r.error, 400) : json(r);
}

// ---- Amp power (idempotent: an amp that is on is never plug-cycled; a running job is joined) ----
/** true / false, or null when nobody can tell (the amp's HTTP API stalls for a few seconds after a DLNA
 *  resume or an input switch, and HA's yamaha_ynca link drops with it — seen 2026-10-14). */
async function ampIsOn(): Promise<boolean | null> {
  if (ampConfigured()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const live = await amp.basicStatus().catch(() => null);
      if (live) return live.power;
      await sleep(1500);
    }
  }
  const snap = haConfigured() ? await readMediaSnapshot().catch(() => null) : null;
  if (!snap) return null;
  if (snap.amp.available) return snap.amp.on;
  return snap.plugOn ? null : false; // plug off = certainly off; plug on + amp silent = unknown
}
/** Wait for the power-on routine's own outcome (its promise; the polling loop is the fallback after a
 *  restart), bounded by the routine's timeout plus the boot poll and command retries it may add. */
async function waitPowerOn(): Promise<"on" | "failed"> {
  const until = Date.now() + POWER_ON_TIMEOUT_MS + 120_000;
  const settled = await Promise.race([
    powerOnDone(),
    sleep(until - Date.now()).then(() => "timeout" as const),
  ]);
  if (settled !== "timeout") return settled?.step === "done" ? "on" : "failed";
  while (Date.now() < until + 15_000) {
    const s = powerOnStatus();
    if (!s || !s.running) return s?.step === "done" ? "on" : "failed";
    await sleep(POWER_POLL_MS);
  }
  return "failed";
}
/** "on" (nothing to do) | "powering_on" (job started/joined, caller may wait) | "failed". */
async function ensureAmpOn(
  source: AmpSource,
  wait: boolean,
): Promise<"on" | "powering_on" | "failed"> {
  const on = await ampIsOn();
  // Unknown: do not touch the plug; the command itself will report "Amp unreachable" if it really is.
  if (on !== false) return "on";
  if (!haConfigured()) return "failed";
  await startPowerOn(source);
  if (!wait) return "powering_on";
  return waitPowerOn();
}

// ---- Play ----
const playSchema = () =>
  z
    .object({
      query: z.string().trim().min(1).max(80).optional(),
      id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional(),
      kind: z.enum(["auto", "artist", "album", "track", "playlist", "mix"]).default("auto"),
      shuffle: z.boolean().default(false),
      /** true: block until the amp is up and the music started (up to the UI's 4 min); false: answer at once. */
      wait: z.boolean().default(false),
    })
    .refine((b) => b.query !== undefined || b.id !== undefined, {
      message: "query or id required",
    });
async function startChosen(c: Candidate, shuffle: boolean): Promise<QueueProgress> {
  if (c.kind === "playlist" || (c.kind === "album" && shuffle)) {
    const tracks =
      c.kind === "playlist"
        ? await jellyfin.playlistTracks(c.id)
        : await jellyfin.albumTracks(c.id);
    const ordered = shuffle ? dedupeShuffle(tracks, tracks.length) : tracks;
    return startQueue(c.title, ordered.map(jellyfin.toQueueTrack), 0);
  }
  return playSelection({ kind: c.kind, id: c.id }); // artist = shuffled, track = instant mix, album = in order
}
async function resolvePlay(
  b: z.infer<ReturnType<typeof playSchema>>,
): Promise<Candidate | { error: string; suggestions: Candidate[] }> {
  if (b.id !== undefined && b.kind !== "auto")
    return { kind: b.kind, id: b.id, title: b.id, score: 100 };
  const query = stripFiller(b.query ?? "") || (b.query ?? "");
  if (b.kind === "mix" || (b.kind === "auto" && b.id === undefined && mixFor(query))) {
    const id = mixFor(query);
    if (!id)
      return {
        error: `no mix called "${query}"`,
        suggestions: MIX_IDS.map((m) => ({ kind: "mix", id: m, title: m, score: 0 })),
      };
    return { kind: "mix", id, title: id, score: 100 };
  }
  const cands = await candidates(query, b.kind, 5);
  const best = pickBest(cands);
  if (!best)
    return { error: `nothing in the library matches "${query}"`, suggestions: cands.slice(0, 5) };
  return best;
}
async function play(body: unknown) {
  const parsed = playSchema().safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "bad body");
  if (!jellyfinConfigured()) return fail("Jellyfin not configured", 503);
  const chosen = await resolvePlay(parsed.data);
  if ("error" in chosen)
    return fail(chosen.error, 404, {
      suggestions: chosen.suggestions.map(({ score: _s, ...c }) => c),
    });
  const { score: _score, ...picked } = chosen;
  const power = await ensureAmpOn("SERVER", parsed.data.wait);
  vlog(
    `play ${picked.kind} "${picked.title}" (${picked.id}) shuffle=${parsed.data.shuffle} amp=${power}`,
  );
  if (power === "failed")
    return fail(powerOnStatus()?.error ?? "Amp did not come up", 502, { chosen: picked });
  if (power === "powering_on") {
    // Same as the Kindle's playAfterPowerOn: the queue starts once the amp answers (60–90 s after the plug).
    void waitPowerOn()
      .then((r) => (r === "on" ? startChosen(chosen, parsed.data.shuffle) : null))
      .then((q) =>
        vlog(`deferred play "${picked.title}": ${q ? `${q.count} tracks` : "amp did not come up"}`),
      )
      .catch((e) => vlog(`deferred play "${picked.title}" failed: ${mediaErrorMessage(e)}`));
    return json({ ok: true, status: "powering_on", etaSec: 90, chosen: picked, queue: null });
  }
  try {
    const queue = await startChosen(chosen, parsed.data.shuffle);
    if (picked.title === picked.id) picked.title = queue.title; // played by id: the queue knows the name
    return json({ ok: true, status: "playing", chosen: picked, queue: queueSummary(queue) });
  } catch (e) {
    return fail(mediaErrorMessage(e), 502, { chosen: picked });
  }
}

// ---- Transport / amp actions, routed like the Kindle footer (queue when a queue plays, NET RADIO otherwise) ----
const OPS = [
  "pause",
  "resume",
  "next",
  "previous",
  "stop",
  "volume_up",
  "volume_down",
  "mute",
  "unmute",
  "amp_off",
  "amp_on",
] as const;
const actionSchema = () => z.object({ op: z.enum(OPS) });
async function action(body: unknown) {
  const parsed = actionSchema().safeParse(body);
  if (!parsed.success) return fail(`op must be one of ${OPS.join("|")}`);
  const { op } = parsed.data;
  if (op === "amp_on") {
    if (!haConfigured()) return fail("HA not configured", 503);
    const already = (await ampIsOn()) !== false;
    const status = already ? null : await startPowerOn();
    return json({
      ok: true,
      op,
      status: already ? "on" : "powering_on",
      powerOn: status,
      state: await currentState(),
    });
  }
  const snap = haConfigured() ? await readMediaSnapshot().catch(() => null) : null;
  const onRadio =
    !!snap && snap.amp.on && snap.amp.source === "NET RADIO" && snap.queue?.status !== "playing";
  const action: MediaAction | null =
    op === "pause"
      ? onRadio
        ? { type: "radio.playback", op: "stop" }
        : { type: "queue", op: "pause" }
      : op === "resume"
        ? onRadio
          ? { type: "radio.playback", op: "play" }
          : { type: "queue", op: "resume" }
        : op === "stop"
          ? onRadio
            ? { type: "radio.playback", op: "stop" }
            : { type: "queue", op: "stop" }
          : op === "next"
            ? onRadio
              ? { type: "radio.step", delta: 1 }
              : { type: "queue", op: "next" }
            : op === "previous"
              ? onRadio
                ? { type: "radio.step", delta: -1 }
                : { type: "queue", op: "prev" }
              : op === "volume_up"
                ? { type: "amp.volume.step", delta: 1 }
                : op === "volume_down"
                  ? { type: "amp.volume.step", delta: -1 }
                  : op === "amp_off"
                    ? { type: "amp.power", on: false }
                    : null;
  try {
    if (action) await performMediaAction(action);
    else {
      // mute has no XML command in the app; HA's yamaha_ynca does it (fails while that link is down after a power cut).
      if (!haConfigured()) return fail("HA not configured", 503);
      await service("media_player", "volume_mute", {
        entity_id: AMP.player,
        is_volume_muted: op === "mute",
      });
    }
  } catch (e) {
    return fail(mediaErrorMessage(e), 502, { op, routed: action?.type ?? "ha.volume_mute" });
  }
  vlog(`action ${op} -> ${action ? JSON.stringify(action) : "ha.volume_mute"}`);
  if (action?.type !== "queue") await sleep(400); // let HA / the amp publish the new state (as runMediaAction does)
  return json({
    ok: true,
    op,
    routed: action ?? { type: "ha.volume_mute" },
    state: await currentState(),
  });
}

// ---- Radio ----
/** Stop a playing Jellyfin queue (the DLNA stream would fight the input switch), then tune; one retry because the
 *  amp's HTTP API goes silent for a few seconds right after a SERVER -> NET RADIO switch (seen 2026-10-14). */
async function tuneStation(hit: { list: string; index: number }) {
  const queue = await getQueueProgress();
  if (queue?.status === "playing")
    await performMediaAction({ type: "queue", op: "stop" }).catch(() => undefined);
  try {
    return await tuneRadio(hit.list, hit.index);
  } catch (e) {
    if (mediaErrorMessage(e) !== "Amp unreachable") throw e;
    await sleep(4000);
    return tuneRadio(hit.list, hit.index);
  }
}
const radioSchema = () =>
  z.object({
    station: z.string().trim().min(1).max(60),
    wait: z.boolean().default(false),
  });
async function radio(body: unknown) {
  const parsed = radioSchema().safeParse(body);
  if (!parsed.success) return fail("station required");
  const hit = matchStation(parsed.data.station);
  if (!hit)
    return fail(`no station like "${parsed.data.station}"`, 404, {
      stations: RADIO_LISTS.map((l) => ({ list: l.id, names: l.stations.map((s) => s.name) })),
    });
  const station = {
    list: hit.list,
    index: hit.index,
    name: hit.name,
    ...(await stationArt(stationIdAt(hit))),
  };
  const power = await ensureAmpOn("NET RADIO", parsed.data.wait);
  vlog(`radio "${hit.name}" (${hit.list}#${hit.index}, score ${hit.score}) amp=${power}`);
  if (power === "failed")
    return fail(powerOnStatus()?.error ?? "Amp did not come up", 502, { station });
  if (power === "powering_on") {
    void waitPowerOn()
      .then((r) => (r === "on" ? tuneStation(hit) : null))
      .then((p) => vlog(`deferred radio "${hit.name}": ${p ? "tuned" : "amp did not come up"}`))
      .catch((e) => vlog(`deferred radio "${hit.name}" failed: ${mediaErrorMessage(e)}`));
    return json({ ok: true, status: "powering_on", etaSec: 90, station });
  }
  try {
    await tuneStation(hit);
    return json({ ok: true, status: "tuned", station });
  } catch (e) {
    return fail(mediaErrorMessage(e), 502, { station });
  }
}

// ---- Station art (colour PNG for Home Assistant; the Kindle gets the same picture in grayscale via /media/img) ----
async function art(params: URLSearchParams) {
  const station = params.get("station") ?? "";
  if (!findStation(station)) return fail("unknown station", 404);
  const width = Math.max(64, Math.min(800, Number(params.get("width")) || 512));
  const png = await stationArtPng(station, width).catch(() => null);
  if (!png) return fail("no art for this station", 404);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}

// ---- Route ----
const readBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};
const sub = (request: Request) =>
  new URL(request.url).pathname.replace(/^\/api\/voice\/?/, "").replace(/\/+$/, "");

export const Route = createFileRoute("/api/voice/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Art is token-less on purpose: HA's template image entity cannot send headers, the port is loopback-only and
        // the route only ever serves a catalog station's own logo.
        if (sub(request) === "art") return art(new URL(request.url).searchParams);
        // The bridge (same network namespace) reads the battery-saver schedule from the panel config; token-less
        // like art: the app port is loopback-only and this is four numbers and a time zone.
        if (sub(request) === "panel-schedule") {
          const cfg = await ensurePanelConfig();
          return json({ source: cfg.source, schedule: cfg.config.schedule });
        }
        if (!env("VOICE_TOKEN")) return fail("voice API disabled (VOICE_TOKEN unset)", 503);
        if (!authorized(request)) return fail("unauthorized", 401);
        await ensurePanelConfig().catch(() => null); // the station list comes from HA with the config
        switch (sub(request)) {
          case "state":
            return json(await currentState());
          case "search":
            return search(new URL(request.url).searchParams);
          case "list":
            return list(new URL(request.url).searchParams);
          default:
            return fail("not found", 404);
        }
      },
      POST: async ({ request }) => {
        if (!env("VOICE_TOKEN")) return fail("voice API disabled (VOICE_TOKEN unset)", 503);
        if (!authorized(request)) return fail("unauthorized", 401);
        await ensurePanelConfig().catch(() => null); // the station list comes from HA with the config
        // MUSIC_BACKEND=ha: Music Assistant owns playback and HA's scripts are the way in. The panel's own queue and
        // direct amp control must stay idle, so the write half of this API is closed (search/list/state stay open).
        if (haBackend())
          return fail(
            "music is played through Home Assistant (MUSIC_BACKEND=ha): use script.play_music etc.",
            409,
          );
        const body = await readBody(request);
        switch (sub(request)) {
          case "play":
            return play(body);
          case "action":
            return action(body);
          case "radio":
            return radio(body);
          default:
            return fail("not found", 404);
        }
      },
    },
  },
});
