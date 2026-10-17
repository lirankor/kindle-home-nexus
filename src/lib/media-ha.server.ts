// Music through Home Assistant (MUSIC_BACKEND=ha): HA is the single gate, Music Assistant owns the queue and
// the yamaha_netbridge integration owns the amp (power-on, volume cap, inputs, DLNA). The panel keeps its own
// library views (Jellyfin lists, mixes, search: same item ids MA plays as jellyfin://<kind>/<id>) and hands the
// chosen tracks to HA's script.music_play_items; everything it shows about playback comes from script.music_state.
// The scripts live in homeserver-cloud: stacks/homeassistant/.../packages_media_platform/music_platform.yaml.
import { HomeError, fetchStates, ha, service } from "./home.server";
import { nodeViews } from "./media-nodes.server";
import { panelConfigNow, setMusicOutput } from "./panel-config.server";
import type { HaState } from "./home.server";
import {
  AMP,
  FAVOURITES_LIST_ID,
  MEDIA_NODES,
  OUTPUT_KEYS,
  RADIO_LISTS,
  isAmpSource,
} from "./media";
import type { OutputView } from "./media";
import type { MediaNode } from "./panel-config";
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

/** One panel, one output (bus task 014): the Music Assistant player (or MA group) chosen in the panel's output
 *  picker, and the receiver node that plays it (its `players` list names it): that receiver is turned on before
 *  playback, takes volume / mute and gets its DLNA/AirPlay select set to match. No receiver: no wake step, volume on
 *  the player itself. */
export type MusicOutput = {
  player: string;
  powerDevice: string | null;
  streamOutput: string | null;
  /** The MA players whose activity counts as "this output plays" (the receiver's, or just the player). */
  players: string[];
};
export function musicOutputFrom(
  player: string | null | undefined,
  nodes: MediaNode[],
): MusicOutput | null {
  if (!player) return null;
  const rx = nodes.find((n) => n.type === "receiver" && n.players?.includes(player));
  return {
    player,
    powerDevice: rx?.power_device ?? null,
    streamOutput: rx?.stream_output ?? null,
    players: rx?.players?.length ? [...rx.players] : [player],
  };
}
/** The panel's output; null while none is chosen (then HA's house default answers and the picker opens). */
export const musicOutput = (): MusicOutput | null => {
  const l = panelConfigNow();
  return l?.musicOutputValid ? musicOutputFrom(l.musicOutput, MEDIA_NODES) : null;
};
/** The fields every music script takes ("" = none; left out = HA's house default). */
export const outputFields = (o: MusicOutput | null = musicOutput()): Record<string, string> =>
  o
    ? { player: o.player, power_device: o.powerDevice ?? "", stream_output: o.streamOutput ?? "" }
    : {};
/** The select option that matches an MA player: the option named in its entity id (dlna / airplay). */
export const streamOptionFor = (player: string, options: string[]) =>
  options.find((o) => player.toLowerCase().includes(o.toLowerCase())) ?? null;
/** What the picker shows. */
export function outputView(): OutputView | null {
  const l = panelConfigNow();
  if (!l || l.source !== "ha") return null;
  const outputs = l.outputs ?? [];
  const entity = l.musicOutput ?? null;
  return {
    entity,
    name: outputs.find((o) => o.entity_id === entity)?.name ?? entity,
    valid: !!l.musicOutputValid,
    outputs,
    keys: [...OUTPUT_KEYS],
  };
}

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
  /** The MA player in use. */
  player: string;
  /** The output asked for (the panel's, else HA's house default). */
  outputPlayer?: string;
  /** The receiver reported as `amp` (null: the player itself). */
  powerDevice?: string | null;
  /** The receiver's stream select (dlna / airplay), null without one. */
  output: string | null;
};
/** The entity the amp keys (power, volume, mute) act on: the output's receiver, else the player itself. */
export const ampEntityOf = (s: Pick<HaMusicState, "player" | "powerDevice">) =>
  s.powerDevice ?? s.player;

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

/** The panel's own power-on attempt (Q13). A wake through the bridge can finish within ~3 s, before the bridge's step
 *  ever reaches a snapshot, so from the key press the panel shows "Turning on…" itself until the amp reports on
 *  (→ done), the bridge or its turn_on call fails (→ failed), or POWER_ON_GIVE_UP_MS passes (→ failed). The final
 *  status stays readable for POWER_ON_FINAL_MS so both the 2 s poll and the snapshot see it. */
export type PowerAttempt = {
  startedAt: number;
  error: string | null;
  final: PowerOnStatus | null;
  finalAt: number;
  /** The bridge reported a running step during this attempt (its "failed" before that is an old one). */
  sawBridge?: boolean;
};
export const POWER_ON_GIVE_UP_MS = 90_000;
export const POWER_ON_FINAL_MS = 10_000;

export function powerOnView(
  s: HaMusicState,
  now: number,
  startedAt: number | null,
  attempt: PowerAttempt | null,
): { status: PowerOnStatus | null; attempt: PowerAttempt | null } {
  if (!attempt) return { status: powerOnFromHa(s, now, startedAt), attempt };
  const started = attempt.startedAt;
  if (attempt.final)
    return now - attempt.finalAt < POWER_ON_FINAL_MS
      ? { status: { ...attempt.final, updatedAt: now }, attempt }
      : { status: powerOnFromHa(s, now, startedAt), attempt: null };
  const real = powerOnFromHa(s, now, started);
  const base = { startedAt: started, updatedAt: now, elapsedMs: now - started, source: null };
  const end = (status: PowerOnStatus) => ({
    status,
    attempt: { ...attempt, final: status, finalAt: now },
  });
  if (real?.running) return { status: real, attempt: { ...attempt, sawBridge: true } }; // the bridge's own steps
  if (real?.step === "failed" && attempt.sawBridge) return end(real);
  if (attempt.error) return end({ ...base, running: false, step: "failed", error: attempt.error });
  if (s.amp.on) return end({ ...base, running: false, step: "done" });
  if (now - started > POWER_ON_GIVE_UP_MS)
    return end({ ...base, running: false, step: "failed", error: "amplifier did not turn on" });
  return { status: { ...base, running: true, step: "turn_on" }, attempt };
}

/** AirPlay is "the music path" for the panel just like SERVER (DLNA): both are Music Assistant playing. */
export const panelSource = (src: string | null): AmpSource | null =>
  src === "AirPlay" ? "SERVER" : isAmpSource(src) ? src : null;

/**
 * Project the bridge entity onto the entity ids the panel's snapshot builder reads (AMP.player / volume /
 * DLNA), so the panel keeps exactly its UI rules (screens by source, screensaver, footer slots).
 */
/** yamaha_netbridge >= 0.2.0: the receiver plays its own input (NET RADIO, CD, …), not Music Assistant (Q18). */
export const receiverPlaysOwnInput = (b: HaState | null | undefined): boolean =>
  (b?.attributes as { foreign_state?: unknown } | undefined)?.foreign_state === "playing";

export function projectStates(
  states: Map<string, HaState>,
  s: HaMusicState,
  o: MusicOutput | null = null,
): Map<string, HaState> {
  const out = new Map(states);
  const b = states.get(ampEntityOf(s));
  const busy = (o?.players ?? [s.player])
    .map((id) => states.get(id))
    .find((p) => p && ["playing", "buffering"].includes(p.state));
  const bridgeState = b?.state ?? (s.amp.available ? (s.amp.on ? "on" : "off") : "unavailable");
  // yamaha_netbridge >= 0.2.0 reports "on" (not "playing") while the receiver plays its own input (NET RADIO, CD, …)
  // and puts that play state in `foreign_state` (Q18); without this the NET RADIO play/stop key always sent "play".
  const foreignPlaying = receiverPlaysOwnInput(b);
  out.set(AMP.player, {
    entity_id: AMP.player,
    state:
      (busy && bridgeState !== "off") || (foreignPlaying && bridgeState === "on")
        ? "playing"
        : bridgeState,
    attributes: {
      ...(b?.attributes ?? {}),
      // without a receiver Music Assistant is the only path: the panel's "SERVER" screens (library, playlist)
      source: s.powerDevice === null ? "SERVER" : panelSource(s.amp.source),
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
let powerAttempt: PowerAttempt | null = null;
/** The power-on status shown on the panel: the bridge's steps, or the panel's own attempt in between. */
function currentPowerOn(s: HaMusicState, now = Date.now()): PowerOnStatus | null {
  const v = powerOnView(s, now, powerStartedAt, powerAttempt);
  powerAttempt = v.attempt;
  return v.status;
}
let lastRadio: RadioPosition | null = null;

export async function readMusicState(maxAgeMs = 0): Promise<HaMusicState> {
  if (lastState && Date.now() - lastState.at <= maxAgeMs) return lastState.value;
  const value = await haScript<HaMusicState>("music_state", outputFields());
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
  const o = musicOutput();
  const [states, s] = await Promise.all([fetchStates(), readMusicState()]);
  const snap = build(projectStates(states, s, o), {
    queue: queueFromHa(s),
    radio: lastRadio,
    powerOn: currentPowerOn(s),
  });
  // the nodes from the real states (the projection rewrites the receiver's entry for the music screen)
  return withRadio({ ...snap, nodes: nodeViews(states), output: outputView() }, s);
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
    {
      media_ids: tracks.map((t) => `jellyfin://track/${t.id}`),
      media_type: "track",
      title,
      ...outputFields(),
    },
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
      outputFields(),
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
    favouritesExternal: true,
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
  const r = await haScript<PlayAnswer>("play_radio", { station: name, ...outputFields() }, 30_000);
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
  haScript<{ ok: boolean; error?: string }>(
    "music_control",
    { op, ...outputFields() },
    30_000,
  ).then((r) => {
    lastState = null;
    if (!r.ok) throw new HomeError(r.error ?? "Music Assistant refused");
  });

export async function startPowerOnHa(): Promise<PowerOnStatus> {
  powerStartedAt = Date.now();
  const attempt: PowerAttempt = { startedAt: powerStartedAt, error: null, final: null, finalAt: 0 };
  powerAttempt = attempt;
  lastState = null; // the next status read asks HA, not a cache from before the key press
  // The bridge's turn_on blocks until the amp is up (25–60 s from deep standby): fire and forget, but remember a
  // refusal so the panel shows "failed" instead of waiting for the give-up time.
  void ampTarget()
    .then((entity_id) => service("media_player", "turn_on", { entity_id }))
    .catch((e: unknown) => {
      attempt.error = e instanceof Error ? e.message : String(e);
    });
  return {
    running: true,
    step: "turn_on",
    startedAt: powerStartedAt,
    updatedAt: powerStartedAt,
    elapsedMs: 0,
    source: null,
  };
}
/** The amp keys' entity: the output's receiver (or the player), else what HA's house default resolves to. */
async function ampTarget(): Promise<string> {
  const o = musicOutput();
  if (o) return o.powerDevice ?? o.player;
  return ampEntityOf(await readMusicState(1500));
}

/** The output picker chose `entity` (an MA player or MA group). */
export async function setOutputHa(entity: string): Promise<void> {
  const l = panelConfigNow();
  if (!(l?.outputs ?? []).some((o) => o.entity_id === entity))
    throw new HomeError("Not a Music Assistant player");
  await setMusicOutput(entity);
  lastState = null;
  // a receiver's DLNA/AirPlay select follows at once (the HA scripts also set it on the next music start)
  const o = musicOutputFrom(entity, MEDIA_NODES);
  if (o?.streamOutput) {
    const sel = await ha<HaState>("GET", `/api/states/${o.streamOutput}`).catch(() => null);
    const options = ((sel?.attributes as { options?: unknown } | undefined)?.options ??
      []) as string[];
    const option = streamOptionFor(entity, Array.isArray(options) ? options : []);
    if (option && sel?.state !== option)
      await service("select", "select_option", { entity_id: o.streamOutput, option }).catch(
        (e: unknown) => console.warn("[output] stream select not set:", e),
      );
  }
}

export async function powerOnStatusHa(): Promise<PowerOnStatus | null> {
  const s = await readMusicState(1500).catch(() => null);
  return s ? currentPowerOn(s) : null;
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
      await service("media_player", "select_source", {
        entity_id: await ampTarget(),
        source: a.source,
      });
      return;
    case "amp.volume.step": {
      const s = await readMusicState(1500);
      // a receiver with dB volume (yamaha_netbridge reports volume_db) steps in dB, anything else in its own steps
      if (s.powerDevice && s.amp.volumeDb !== null)
        await service("yamaha_netbridge", "step_volume_db", {
          entity_id: s.powerDevice,
          delta_db: a.delta * AMP.volumeStepDb,
        });
      else await control(a.delta > 0 ? "volume_up" : "volume_down");
      return;
    }
    case "amp.volume.db":
      await service("yamaha_netbridge", "set_volume_db", {
        entity_id: await ampTarget(),
        volume_db: a.db,
      });
      return;
    case "amp.volume.set":
      await service("media_player", "volume_set", {
        entity_id: await ampTarget(),
        volume_level: a.level,
      });
      return;
    case "amp.reload":
      return; // the bridge keeps its own connection healthy
    case "radio.step":
      await radioStepHa(a.delta);
      return;
    case "radio.playback":
      if (a.op === "stop") {
        // The receiver's own NET RADIO is not Music Assistant's: stop it on the bridge, MA's stop would not reach it.
        const amp = await ampTarget();
        const b = await ha<HaState>("GET", `/api/states/${amp}`).catch(() => null);
        if (receiverPlaysOwnInput(b)) {
          await service("media_player", "media_stop", { entity_id: amp });
          lastState = null;
        } else await control("stop");
      } else if (lastRadio) await tuneRadioHa(lastRadio.list, lastRadio.index);
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
    case "output":
      await setOutputHa(a.entity);
      return;
    default:
      await legacy(a);
  }
}
