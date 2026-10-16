// Music through Home Assistant (MUSIC_BACKEND=ha): HA is the single gate, Music Assistant owns the queue and
// the yamaha_netbridge integration owns the amp (power-on, volume cap, inputs, DLNA). The panel keeps its own
// library views (Jellyfin lists, mixes, search: same item ids MA plays as jellyfin://<kind>/<id>) and hands the
// chosen tracks to HA's script.music_play_items; everything it shows about playback comes from script.music_state.
// The scripts live in homeserver-cloud: stacks/homeassistant/.../packages_media_platform/music_platform.yaml.
import { HomeError, fetchStates, ha, service } from "./home.server";
import { panelConfigNow } from "./panel-config.server";
import type { HaState } from "./home.server";
import { AMP, FAVOURITES_LIST_ID, RADIO_LISTS, isAmpSource } from "./media";
import type {
  AmpSource,
  MediaAction,
  MediaSnapshot,
  MusicTrack,
  PlaySelection,
  PowerOnStatus,
  PowerOnStep,
  QueueList,
  QueueProgress,
  RadioListsResult,
  RadioPosition,
  RadioStationView,
} from "./media";

/** yamaha_netbridge's media_player (fixed id, see music_platform.yaml). */
export const BRIDGE = "media_player.r_n500";
export const MA_PLAYERS = ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"] as const;

/** Panel config (HA) when it is managed there, else the MUSIC_BACKEND env as before. */
export const musicBackend = (): "ha" | "app" => {
  const cfg = panelConfigNow();
  if (cfg?.source === "ha") return cfg.config.media.music_backend;
  return (process.env["MUSIC_BACKEND"] ?? "").trim().toLowerCase() === "ha" ? "ha" : "app";
};
export const haBackend = () => musicBackend() === "ha";

// ---- script.music_state contract ----
export type HaTrack = {
  title: string | null;
  id: string | null;
  uri: string | null;
  albumId: string | null;
  artist: string | null;
  album: string | null;
  artUrl: string | null;
  durationMs: number | null;
};
export type HaMusicState = {
  ok: boolean;
  amp: {
    available: boolean;
    on: boolean;
    state: string;
    playing: boolean;
    source: string | null;
    volumeDb: number | null;
    muted: boolean;
  };
  powerOn: { running: boolean; step: string | null; error: string | null };
  nowPlaying: {
    kind: "queue" | "radio" | "none";
    title: string | null;
    artist: string | null;
    album: string | null;
    station: string | null;
    artUrl: string | null;
  };
  queue: {
    title: string;
    status: "playing" | "paused" | "stopped";
    stall: string | null;
    index: number;
    count: number;
    positionMs: number;
    durationMs: number | null;
    track: HaTrack | null;
    next: HaTrack[];
  } | null;
  radio: { station: string } | null;
  player: string;
  output: string;
};

export async function haScript<T>(
  name: string,
  data: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const r = await ha<{ service_response?: T }>(
    "POST",
    `/api/services/script/${name}?return_response`,
    data,
    timeoutMs,
  );
  if (r.service_response === undefined || r.service_response === null)
    throw new HomeError(`script.${name} gave no answer`);
  return r.service_response;
}

// ---- Pure mappings (unit tested) ----
const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Catalogue station by its (MA library) name. */
export function stationByName(name: string | null | undefined) {
  if (!name) return undefined;
  const n = normName(name);
  return RADIO_LISTS.flatMap((l) => l.stations).find((s) => normName(s.name) === n);
}
/** Dial position of a station name (first band that has it). */
export function positionOf(name: string | null | undefined): RadioPosition | null {
  if (!name) return null;
  const n = normName(name);
  for (const l of RADIO_LISTS) {
    const i = l.stations.findIndex((s) => normName(s.name) === n);
    if (i >= 0) return { list: l.id, index: i };
  }
  return null;
}

/** Jellyfin item ids are 32 hex characters; MA's own library ids (library://track/123) are not. */
export const isJellyfinId = (v: string | null | undefined): v is string =>
  typeof v === "string" && /^[0-9a-f]{32}$/i.test(v);
/** Art for /media/img?item=…: a Jellyfin id when there is one, else MA's image proxy URL as an "ma:" token. */
export function artToken(ids: (string | null | undefined)[], image: string | null | undefined) {
  const jf = ids.find(isJellyfinId);
  if (jf) return jf;
  return image ? `ma:${Buffer.from(image, "utf8").toString("base64url")}` : null;
}

export const toMusicTrack = (t: HaTrack): MusicTrack => ({
  id: t.id ?? t.uri ?? t.title ?? "",
  title: t.title ?? "",
  artist: t.artist,
  album: t.album,
  albumId: t.albumId,
  durationMs: t.durationMs ?? 0,
  container: null,
  artItemId: artToken([t.albumId, t.id], t.artUrl),
});

export function queueFromHa(s: HaMusicState): QueueProgress | null {
  const q = s.queue;
  if (!q) return null;
  const track = q.track ? toMusicTrack(q.track) : null;
  return {
    title: q.title,
    index: q.index,
    count: q.count,
    track,
    positionMs: q.positionMs,
    durationMs: q.durationMs ?? track?.durationMs ?? 0,
    status: q.status,
    prevTrack: null,
    nextTracks: q.next.map(toMusicTrack),
    stall: q.stall === "renderer stopped" ? q.stall : null,
  };
}

/** The bridge's power-on steps on the panel's PowerOnStep scale. */
const STEP: Record<string, PowerOnStep> = {
  supply: "plug",
  reach: "wait",
  boot: "wait",
  power: "turn_on",
  volume: "source",
  done: "done",
  failed: "failed",
};
export function powerOnFromHa(
  s: HaMusicState,
  now: number,
  startedAt: number | null,
): PowerOnStatus | null {
  const step = s.powerOn.step ? STEP[s.powerOn.step] : undefined;
  if (!step || s.powerOn.step === "idle") return null;
  const started = startedAt ?? now;
  return {
    running: s.powerOn.running,
    step,
    startedAt: started,
    updatedAt: now,
    elapsedMs: now - started,
    source: null,
    ...(s.powerOn.error ? { error: s.powerOn.error } : {}),
  };
}

/** AirPlay is "the music path" for the panel just like SERVER (DLNA): both are Music Assistant playing. */
export const panelSource = (src: string | null): AmpSource | null =>
  src === "AirPlay" ? "SERVER" : isAmpSource(src) ? src : null;

/**
 * Project the bridge entity onto the entity ids the panel's snapshot builder reads (AMP.player / volume /
 * DLNA), so the panel keeps exactly its UI rules (screens by source, screensaver, footer slots).
 */
export function projectStates(states: Map<string, HaState>, s: HaMusicState): Map<string, HaState> {
  const out = new Map(states);
  const b = states.get(BRIDGE);
  const busy = MA_PLAYERS.map((id) => states.get(id)).find(
    (p) => p && ["playing", "buffering"].includes(p.state),
  );
  const bridgeState = b?.state ?? (s.amp.available ? (s.amp.on ? "on" : "off") : "unavailable");
  out.set(AMP.player, {
    entity_id: AMP.player,
    state: busy && bridgeState !== "off" ? "playing" : bridgeState,
    attributes: {
      ...(b?.attributes ?? {}),
      source: panelSource(s.amp.source),
      is_volume_muted: s.amp.muted,
      media_title: s.nowPlaying.title,
      media_artist: s.nowPlaying.artist,
      media_album_name: s.nowPlaying.album,
    } as HaState["attributes"],
  });
  out.set(AMP.volumeDb, {
    entity_id: AMP.volumeDb,
    state: s.amp.volumeDb === null ? "unknown" : String(s.amp.volumeDb),
    attributes: {},
  });
  out.set(AMP.dlna, {
    entity_id: AMP.dlna,
    state: busy ? "playing" : "idle",
    attributes: {},
  });
  return out;
}

/** Radio now playing (MA radio over AirPlay): the snapshot builder only knows NET RADIO, so patch it. */
export function withRadio(snap: MediaSnapshot, s: HaMusicState): MediaSnapshot {
  if (s.nowPlaying.kind !== "radio" || !snap.amp.on) return snap;
  const st = stationByName(s.nowPlaying.station);
  return {
    ...snap,
    nowPlaying: {
      kind: "radio",
      title:
        s.nowPlaying.title && s.nowPlaying.title !== s.nowPlaying.station
          ? s.nowPlaying.title
          : null,
      artist: null,
      album: null,
      station: s.nowPlaying.station,
      artItemId: null,
      stationId: st?.id ?? null,
      preset: null,
    },
    radio: positionOf(s.nowPlaying.station) ?? snap.radio,
  };
}

// ---- Full queue: the kindle_panel HA integration (MA's whole queue + play_index), else the list we sent ----
export type PanelQueueItem = {
  index: number;
  id: string | null;
  jellyfin_id?: string | null;
  image?: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_id: string | null;
  duration: number | null;
};
export type PanelQueue = {
  queue_id: string | null;
  name: string | null;
  total: number;
  current_index: number | null;
  items: PanelQueueItem[];
};
export const panelItemTrack = (i: PanelQueueItem): MusicTrack => ({
  id: i.jellyfin_id ?? i.id ?? String(i.index),
  title: i.title ?? "",
  artist: i.artist,
  album: i.album,
  albumId: i.album_id,
  durationMs: (i.duration ?? 0) * 1000,
  container: null,
  artItemId: artToken([i.album_id, i.jellyfin_id], i.image),
});
/** The list as the panel shows it: from the full MA queue when kindle_panel answers, else from what we sent
 *  (MA plays it in the order we sent, shuffle off, so its queue index equals our list index). */
export function queueListFrom(
  s: HaMusicState,
  full: PanelQueue | null,
  sent: { title: string; tracks: MusicTrack[] } | null,
): QueueList | null {
  const q = queueFromHa(s);
  if (!q) return null;
  if (full && full.items.length)
    return {
      title: full.name ?? q.title,
      index: full.current_index ?? q.index,
      status: q.status,
      tracks: full.items.map(panelItemTrack),
    };
  // MA plays what we sent in our order (shuffle off) but reports its own library ids: match by position + title.
  const norm = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();
  if (
    sent &&
    q.count === sent.tracks.length &&
    norm(sent.tracks[q.index]?.title) === norm(q.track?.title)
  )
    return { title: sent.title, index: q.index, status: q.status, tracks: sent.tracks };
  // Started elsewhere (voice, MA's UI) and no kindle_panel: the window MA reports.
  const tracks = [q.track, ...(q.nextTracks ?? [])].filter((t): t is MusicTrack => t !== null);
  return { title: q.title, index: 0, status: q.status, tracks };
}

let sentQueue: { title: string; tracks: MusicTrack[] } | null = null;
/** kindle_panel missing (HA answers 400 for an unknown service): do not ask again for a minute. */
let panelMissingUntil = 0;
async function panelQueue(player: string): Promise<PanelQueue | null> {
  if (Date.now() < panelMissingUntil) return null;
  try {
    const r = await ha<{ service_response?: PanelQueue }>(
      "POST",
      "/api/services/kindle_panel/get_queue?return_response",
      { entity_id: player, offset: 0, limit: 500 },
      15_000,
    );
    return r.service_response ?? null;
  } catch {
    panelMissingUntil = Date.now() + 60_000;
    return null;
  }
}

// ---- Runtime ----
let lastState: { at: number; value: HaMusicState } | null = null;
let powerStartedAt: number | null = null;
let lastRadio: RadioPosition | null = null;

export async function readMusicState(maxAgeMs = 0): Promise<HaMusicState> {
  if (lastState && Date.now() - lastState.at <= maxAgeMs) return lastState.value;
  const value = await haScript<HaMusicState>("music_state");
  lastState = { at: Date.now(), value };
  if (value.powerOn.running) powerStartedAt ??= Date.now();
  else powerStartedAt = null;
  return value;
}

export async function readMediaSnapshotHa(
  build: (
    states: Map<string, HaState>,
    extra: {
      queue?: QueueProgress | null;
      radio?: RadioPosition | null;
      powerOn?: PowerOnStatus | null;
    },
  ) => MediaSnapshot,
): Promise<MediaSnapshot> {
  const [states, s] = await Promise.all([fetchStates(), readMusicState()]);
  const snap = build(projectStates(states, s), {
    queue: queueFromHa(s),
    radio: lastRadio,
    powerOn: powerOnFromHa(s, Date.now(), powerStartedAt),
  });
  return withRadio(snap, s);
}

export async function getQueueProgressHa(): Promise<QueueProgress | null> {
  return queueFromHa(await readMusicState(1500));
}
export async function getQueueListHa(): Promise<QueueList | null> {
  const s = await readMusicState(1500);
  if (!s.queue) return null;
  return queueListFrom(s, await panelQueue(s.player), sentQueue);
}

/** Playlist screen: play item `index` of the list it shows (= MA's queue index, see queueListFrom). */
async function queueJumpHa(index: number) {
  const s = await readMusicState(0);
  try {
    if (Date.now() >= panelMissingUntil) {
      await service("kindle_panel", "play_index", { entity_id: s.player, index });
      lastState = null;
      return;
    }
  } catch {
    panelMissingUntil = Date.now() + 60_000;
  }
  // No kindle_panel: step there from where MA is (exact when the list is the one we sent).
  const cur = s.queue?.index ?? 0;
  const delta = Math.max(-50, Math.min(50, index - cur));
  for (let i = 0; i < Math.abs(delta); i++) await control(delta > 0 ? "next" : "previous");
}

type PlayAnswer = { ok: boolean; error?: string; status?: string };
/** The panel picks the tracks (its mixes, an album in order, an artist shuffle) and MA plays exactly those. */
export async function playSelectionHa(
  sel: PlaySelection,
  tracksFor: (sel: PlaySelection) => Promise<{ title: string; tracks: MusicTrack[] }>,
): Promise<QueueProgress | null> {
  const { title, tracks } = await tracksFor(sel);
  if (!tracks.length) throw new HomeError("Nothing to play");
  const r = await haScript<PlayAnswer>(
    "music_play_items",
    { media_ids: tracks.map((t) => `jellyfin://track/${t.id}`), media_type: "track", title },
    30_000,
  );
  if (!r.ok) throw new HomeError(r.error ?? "Music Assistant refused");
  if (r.status === "powering_on") powerStartedAt = Date.now();
  lastState = null;
  sentQueue = { title, tracks };
  // A just-started queue: show it at once (MA needs a moment to report it).
  return {
    title,
    index: 0,
    count: tracks.length,
    track: tracks[0] ?? null,
    positionMs: 0,
    durationMs: tracks[0]?.durationMs ?? 0,
    status: "playing",
    prevTrack: null,
    nextTracks: tracks.slice(1, 4),
    stall: null,
  };
}

/** Catalogue bands + MA's favourite radios as the favourites band. */
export async function readRadioListsHa(): Promise<RadioListsResult> {
  let favourites: RadioStationView[] = [];
  let error: string | undefined;
  try {
    const r = await haScript<{ ok: boolean; stations: { name: string; image: string | null }[] }>(
      "music_radio_favourites",
    );
    favourites = r.stations.map((f) => {
      const cat = stationByName(f.name);
      return cat
        ? { ...cat, ytunerId: null, favourite: true }
        : {
            id: `ma:${normName(f.name).replace(/ /g, "-")}`,
            name: f.name,
            url: "",
            codec: "",
            bitrate: 0,
            fm: null,
            logo: f.image,
            ytunerId: null,
            favourite: true,
          };
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const favNames = new Set(favourites.map((f) => normName(f.name)));
  return {
    configured: true,
    ...(error === undefined ? {} : { error }),
    lists: [
      { id: FAVOURITES_LIST_ID, stations: favourites },
      ...RADIO_LISTS.map((l) => ({
        id: l.id,
        stations: l.stations.map((s) => ({
          ...s,
          ytunerId: null,
          favourite: favNames.has(normName(s.name)),
        })),
      })),
    ],
    current: lastRadio,
  };
}

async function stationAt(list: string, index: number): Promise<string> {
  if (list === FAVOURITES_LIST_ID) {
    const r = await readRadioListsHa();
    const st = r.lists[0]?.stations[index];
    if (!st) throw new HomeError("No such station");
    return st.name;
  }
  const st = RADIO_LISTS.find((l) => l.id === list)?.stations[index];
  if (!st) throw new HomeError("No such station");
  return st.name;
}

export async function tuneRadioHa(list: string, index: number): Promise<RadioPosition> {
  const name = await stationAt(list, index);
  const r = await haScript<PlayAnswer>("play_radio", { station: name }, 30_000);
  if (!r.ok) throw new HomeError(r.error ?? "Music Assistant refused");
  if (r.status === "powering_on") powerStartedAt = Date.now();
  lastRadio = { list, index };
  lastState = null;
  return lastRadio;
}

async function radioStepHa(delta: 1 | -1) {
  const cur = lastRadio ?? { list: RADIO_LISTS[0]?.id ?? "local", index: -1 };
  const size =
    cur.list === FAVOURITES_LIST_ID
      ? ((await readRadioListsHa()).lists[0]?.stations.length ?? 0)
      : (RADIO_LISTS.find((l) => l.id === cur.list)?.stations.length ?? 0);
  if (!size) throw new HomeError("No stations");
  await tuneRadioHa(cur.list, (cur.index + delta + size) % size);
}

const control = (op: string) =>
  haScript<{ ok: boolean; error?: string }>("music_control", { op }, 30_000).then((r) => {
    lastState = null;
    if (!r.ok) throw new HomeError(r.error ?? "Music Assistant refused");
  });

export async function startPowerOnHa(): Promise<PowerOnStatus> {
  powerStartedAt = Date.now();
  // The bridge's turn_on blocks until the amp is up (25–60 s from deep standby): fire and forget.
  void service("media_player", "turn_on", { entity_id: BRIDGE }).catch(() => undefined);
  return {
    running: true,
    step: "wait",
    startedAt: powerStartedAt,
    updatedAt: powerStartedAt,
    elapsedMs: 0,
    source: null,
  };
}
export async function powerOnStatusHa(): Promise<PowerOnStatus | null> {
  const s = await readMusicState(1500).catch(() => null);
  return s ? powerOnFromHa(s, Date.now(), powerStartedAt) : null;
}

/** Actions the HA backend handles itself; everything else (plug, TV, movie, FM, all_off) stays as it was. */
export async function performMediaActionHa(
  a: MediaAction,
  legacy: (a: MediaAction) => Promise<void>,
): Promise<void> {
  switch (a.type) {
    case "amp.power":
      if (a.on) await startPowerOnHa();
      else await control("amp_off");
      return;
    case "amp.source":
      await service("media_player", "select_source", { entity_id: BRIDGE, source: a.source });
      return;
    case "amp.volume.step":
      await service("yamaha_netbridge", "step_volume_db", {
        entity_id: BRIDGE,
        delta_db: a.delta * AMP.volumeStepDb,
      });
      return;
    case "amp.volume.db":
      await service("yamaha_netbridge", "set_volume_db", { entity_id: BRIDGE, volume_db: a.db });
      return;
    case "amp.volume.set":
      await service("media_player", "volume_set", { entity_id: BRIDGE, volume_level: a.level });
      return;
    case "amp.reload":
      return; // the bridge keeps its own connection healthy
    case "radio.step":
      await radioStepHa(a.delta);
      return;
    case "radio.playback":
      if (a.op === "stop") await control("stop");
      else if (lastRadio) await tuneRadioHa(lastRadio.list, lastRadio.index);
      else await control("resume");
      return;
    case "radio.favourite":
      throw new HomeError("Favourites are kept in Music Assistant");
    case "queue": {
      const op = {
        next: "next",
        prev: "previous",
        pause: "pause",
        resume: "resume",
        stop: "stop",
      } as const;
      if (a.op === "toggle") {
        const s = await readMusicState(1500);
        await control(s.queue?.status === "playing" ? "pause" : "resume");
      } else await control(op[a.op]);
      return;
    }
    case "queue.jump":
      await queueJumpHa(a.index);
      return;
    case "all_off":
      await control("stop").catch(() => undefined);
      await legacy(a);
      return;
    default:
      await legacy(a);
  }
}
