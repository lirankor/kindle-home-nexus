// Music through Home Assistant (MUSIC_BACKEND=ha): HA is the single gate, Music Assistant owns the queue and
// the yamaha_netbridge integration owns the amp (power-on, volume cap, inputs, DLNA). The panel keeps its own
// library views (Jellyfin lists, mixes, search: same item ids MA plays as jellyfin://<kind>/<id>) and hands the
// chosen tracks to HA's script.music_play_items; everything it shows about playback comes from script.music_state.
// The scripts live in homeserver-cloud: stacks/homeassistant/.../packages_media_platform/music_platform.yaml.
import { HomeError, fetchStates, ha, service } from "./home.server";
import { makeT, parseLang } from "./i18n";
import { mediaKeyIcons, nodeViews } from "./media-nodes.server";
import { invalidatePanelConfig, panelConfigNow, setMusicOutput } from "./panel-config.server";
import type { HaState } from "./home.server";
import {
  AMP,
  FAVOURITES_LIST_ID,
  MEDIA_NODES,
  OUTPUT_KEYS,
  RADIO_LISTS,
  isAmpSource,
  rememberMaStation,
  syncActionFor,
  syncLeaderOf,
} from "./media";
import type { NowParts, OutputRow, OutputView } from "./media";
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
  /** The MA players of the output's receiver (or just the player). Only `player` counts as "this output plays"
   *  (bus task 021: the screen follows the chosen output strictly). */
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
const PLAYING_STATES = ["playing", "buffering"];
/** "Title · Artist" of an HA media_player, null when it has nothing. */
export const nowLineOf = (st: HaState | undefined): string | null => {
  const a = (st?.attributes ?? {}) as Record<string, unknown>;
  const parts = [a["media_title"], a["media_artist"]].filter(
    (x): x is string => typeof x === "string" && x !== "",
  );
  return parts.length ? parts.join(" · ") : null;
};
/** What an HA media_player plays, by part (bus task 023), null when it has no title. */
export const nowPartsOf = (st: HaState | undefined): NowParts | null => {
  const a = (st?.attributes ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : null);
  const title = str("media_title");
  return title ? { title, artist: str("media_artist"), album: str("media_album_name") } : null;
};
/** A move under way (bus task 021): set by moveOutputHa, cleared when the target plays or after MOVE_GIVE_UP_MS. */
type Moving = {
  entity: string;
  name: string;
  startedAt: number;
  failed?: string | null;
  failedAt?: number;
};
let moving: Moving | null = null;
export const MOVE_GIVE_UP_MS = 45_000;
const MOVE_FAILED_SHOWN_MS = 15_000;
/** Pure: the move's state on this snapshot (null = no move to show). */
export function movingView(m: Moving | null, rows: OutputRow[], now: number): Moving | null {
  if (!m) return null;
  if (m.failed) return now - (m.failedAt ?? now) < MOVE_FAILED_SHOWN_MS ? m : null;
  const target = rows.find((r) => r.entity_id === m.entity);
  if (target && PLAYING_STATES.includes(target.state)) return null; // arrived
  if (now - m.startedAt > MOVE_GIVE_UP_MS)
    return { ...m, failed: "did not start playing", failedAt: now };
  return m;
}
/** A move HA refused or undid (bus task 022): shown on the music screen for MOVE_ERROR_SHOWN_MS. */
let moveError: { name: string; error: string; at: number } | null = null;
export const MOVE_ERROR_SHOWN_MS = 60_000;

/** A sync group's members (itself first) from HA's live `group_members` (MA entities have it), else kindle_panel's. */
const membersOf = (st: HaState | undefined, fallback: string[] | undefined): string[] => {
  const live = (st?.attributes as { group_members?: unknown } | undefined)?.group_members;
  const list = Array.isArray(live)
    ? live.filter((x): x is string => typeof x === "string")
    : (fallback ?? []);
  return list.length > 1 ? list : [];
};

/** Rows by name (as Music Assistant's Players list), each sync group's members right under their leader. */
export function groupOrder(rows: OutputRow[]): OutputRow[] {
  const byName = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const listed = new Set(byName.map((r) => r.entity_id));
  const out: OutputRow[] = [];
  for (const r of byName) {
    if (r.syncedTo && listed.has(r.syncedTo)) continue; // placed under its leader
    out.push(r);
    out.push(...byName.filter((m) => m.syncedTo === r.entity_id));
  }
  return out;
}

/** What the picker shows: MA's players (live state + what each plays from the HA states when given), the ones HA
 *  has no entity for (only with the panel's show_unavailable_outputs), the move under way, a refused move, sync groups
 *  and, when the chosen output is quiet, which other output plays. */
export function outputView(
  states?: Map<string, HaState> | null,
  now = Date.now(),
): OutputView | null {
  const l = panelConfigNow();
  if (!l || l.source !== "ha") return null;
  const entity = l.musicOutput ?? null;
  const showUnavailable = !!l.config.media.show_unavailable_outputs;
  const rows: OutputRow[] = (l.outputs ?? []).map((o) => {
    const st = states?.get(o.entity_id);
    return {
      entity_id: o.entity_id,
      name: o.name,
      state: st?.state ?? o.state,
      now: st ? nowLineOf(st) : (o.now ?? null),
      nowParts: st ? nowPartsOf(st) : o.now ? { title: o.now, artist: null, album: null } : null,
      kind: o.kind ?? "player",
      exposed: true,
      groupWith: o.group_with ?? [],
      groupMembers: membersOf(st, o.group_members),
      syncedTo: null,
    };
  });
  // who follows whom: HA reports the SAME group_members list (leader first) on the leader and on every member (seen
  // live 2026-10-18 17:21), so a list's first entry is the leader; only the leader keeps the member list
  const leaderOf = new Map<string, string>();
  for (const r of rows) {
    const [lead, ...rest] = r.groupMembers ?? [];
    if (lead) for (const m of rest) if (m !== lead) leaderOf.set(m, lead);
  }
  for (const r of rows) {
    r.syncedTo =
      leaderOf.get(r.entity_id) ??
      (l.outputs ?? []).find((o) => o.entity_id === r.entity_id)?.synced_to ??
      null;
    if ((r.groupMembers ?? [])[0] !== r.entity_id) r.groupMembers = [];
  }
  // only what can be chosen (bus task 022): a player that went unavailable since the last get_config hides too;
  // the panel's own output always stays
  const outputs = groupOrder(
    showUnavailable
      ? rows
      : rows.filter((r) => r.state !== "unavailable" || r.entity_id === entity),
  );
  const unexposed: OutputRow[] = (showUnavailable ? (l.outputsUnexposed ?? []) : []).map((u) => ({
    entity_id: `ma:${u.player_id}`,
    name: u.name,
    state: u.state,
    now: u.now ?? null,
    kind: u.kind ?? "player",
    exposed: false,
  }));
  const current = outputs.find((o) => o.entity_id === entity);
  const members = (current?.groupMembers ?? []).filter((m) => m !== entity);
  const groupName =
    current && members.length
      ? [
          current.name,
          // a member the picker hides (MA-hidden / hidden_outputs) still has its HA name
          ...members.map(
            (m) =>
              rows.find((r) => r.entity_id === m)?.name ??
              (states?.get(m)?.attributes as { friendly_name?: string } | undefined)
                ?.friendly_name ??
              m,
          ),
        ].join(" + ")
      : null;
  if (moveError && now - moveError.at > MOVE_ERROR_SHOWN_MS) moveError = null;
  const other =
    current && PLAYING_STATES.includes(current.state)
      ? undefined
      : outputs.find((o) => o.entity_id !== entity && PLAYING_STATES.includes(o.state));
  moving = movingView(moving, outputs, now);
  return {
    entity,
    name: current?.name ?? entity,
    valid: !!l.musicOutputValid,
    outputs,
    unexposed,
    keys: [...OUTPUT_KEYS],
    moving: moving
      ? {
          entity: moving.entity,
          name: moving.name,
          startedAt: moving.startedAt,
          failed: moving.failed ?? null,
        }
      : null,
    playingElsewhere: other
      ? { entity: other.entity_id, name: other.name, now: other.now ?? null }
      : null,
    moveError,
    groupName,
    showUnavailable,
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
    /** Radio: the station's logo (MA's image of the radio item). */
    logo?: string | null;
    /** Radio: the ICY track title MA reports (HA's media_title), null when it is just the station (bus task 024). */
    track?: string | null;
  };
  queue: {
    title: string;
    /** "mix": one of the nightly Music Assistant mix playlists (bus task 018), `title` = the mix. */
    kind?: "queue" | "mix";
    mix?: { id: string; title: string; he: string } | null;
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
/** The dial id of a Music Assistant radio the bridge's list does not have (same rule as the favourites band). */
export const maStationId = (name: string) => `ma:${normName(name).replace(/ /g, "-")}`;
/** The station a radio name stands for on the dial: the bridge's list entry, else the MA favourite id. */
export const radioStationIdOf = (name: string | null | undefined): string | null =>
  !name ? null : (stationByName(name)?.id ?? maStationId(name));
/** The ICY line of MA radio (bus task 024): the track and artist MA reports, null when the "track" is only the
 *  station's own name. */
export function radioTrackOf(n: HaMusicState["nowPlaying"]): {
  title: string | null;
  artist: string | null;
} {
  const track = n.track !== undefined ? n.track : n.title;
  if (!track || normName(track) === normName(n.station ?? "")) return { title: null, artist: null };
  const artist = n.artist && normName(n.artist) !== normName(n.station ?? "") ? n.artist : null;
  return { title: track, artist };
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
  // bus task 021: only the player music_state read (the chosen output, strictly) counts as playing; the receiver's
  // other player (AirPlay while the output is DLNA) does not make this output's screen "playing"
  void o;
  const busy = [s.player]
    .map((id) => states.get(id))
    .find((p) => p && PLAYING_STATES.includes(p.state));
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
  const icy = radioTrackOf(s.nowPlaying);
  return {
    ...snap,
    nowPlaying: {
      kind: "radio",
      title: icy.title,
      artist: icy.artist,
      album: null,
      station: s.nowPlaying.station,
      artItemId: null,
      // the station's art goes through /media/img?station= like the dial's (bus task 024)
      stationId: radioStationIdOf(s.nowPlaying.station),
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
      // MA names the queue after the player; a mix playlist's name comes from music_state
      title: s.queue?.kind === "mix" ? q.title : (full.name ?? q.title),
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
  // MA radio the bridge's list does not have: its logo (from MA) for /media/img?station=ma:… (bus task 024)
  const np = s.nowPlaying;
  if (np.kind === "radio" && np.station && !stationByName(np.station))
    rememberMaStation(maStationId(np.station), np.station, np.logo ?? np.artUrl);
  // the nodes from the real states (the projection rewrites the receiver's entry for the music screen)
  const output = outputView(states);
  return withRadio(
    {
      ...snap,
      nodes: nodeViews(states),
      output,
      // from the real states, with the picker's rows (bus task 020)
      icons: mediaKeyIcons(
        states,
        (output?.outputs ?? []).map((x) => x.entity_id),
      ),
    },
    s,
  );
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
type PlayMixAnswer = PlayAnswer & { chosen?: { title?: string; mt?: string } };
/** A mix plays the nightly Music Assistant playlist of that name (bus task 018: bin/ma-mixes.py rebuilds them at
 *  04:45, so the Kindle, the MA app, HA and voice share the same lists). Null = MA has no such playlist (yet): the
 *  caller falls back to the panel's own mix. */
async function playMixPlaylistHa(sel: PlaySelection): Promise<QueueProgress | null> {
  const r = await haScript<PlayMixAnswer>(
    "play_music",
    { query: sel.id, kind: "mix", fallback: false, ...outputFields() },
    30_000,
  );
  if (!r.ok) {
    if ((r.error ?? "").startsWith("nothing found")) return null;
    throw new HomeError(r.error ?? "Music Assistant refused");
  }
  if (r.status === "powering_on") powerStartedAt = Date.now();
  lastState = null;
  sentQueue = null; // MA's queue is the list now (kindle_panel.get_queue / music_state)
  return {
    title: r.chosen?.title ?? sel.id,
    index: 0,
    count: 0,
    track: null,
    positionMs: 0,
    durationMs: 0,
    status: "playing",
    prevTrack: null,
    nextTracks: [],
    stall: null,
  };
}
/** The panel picks the tracks (an album in order, an artist shuffle; a mix only when MA has no playlist for it) and
 *  MA plays exactly those. */
export async function playSelectionHa(
  sel: PlaySelection,
  tracksFor: (sel: PlaySelection) => Promise<{ title: string; tracks: MusicTrack[] }>,
): Promise<QueueProgress | null> {
  if (sel.kind === "mix") {
    const q = await playMixPlaylistHa(sel);
    if (q) return q;
  }
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
      if (!cat) rememberMaStation(maStationId(f.name), f.name, f.image);
      return cat
        ? { ...cat, ytunerId: null, favourite: true }
        : {
            id: maStationId(f.name),
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
        name: l.ytunerCategory,
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
  const r = await haScript<PlayAnswer & { player?: string; rerouted?: boolean }>(
    "play_radio",
    { station: name, ...outputFields() },
    30_000,
  );
  if (!r.ok) throw new HomeError(r.error ?? "Music Assistant refused");
  // HA plays radio on another player than the panel's output (house.radio_player: the amp's DLNA player hands radio
  // to its AirPlay player): the panel's output follows, so its label, queue and keys match what plays (bus task 021).
  // Only the output changes; the receiver's DLNA/AirPlay select (library music's path for voice) is left alone.
  if (r.rerouted && r.player && r.player !== musicOutput()?.player)
    await setMusicOutput(r.player).catch((e: unknown) =>
      console.warn("[output] radio reroute not followed:", e),
    );
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
  await alignStreamSelect(entity);
}

/** The receiver's DLNA/AirPlay select follows a newly chosen output at once. */
async function alignStreamSelect(entity: string) {
  const o = musicOutputFrom(entity, MEDIA_NODES);
  if (!o?.streamOutput) return;
  const sel = await ha<HaState>("GET", `/api/states/${o.streamOutput}`).catch(() => null);
  const options = ((sel?.attributes as { options?: unknown } | undefined)?.options ??
    []) as string[];
  const option = streamOptionFor(entity, Array.isArray(options) ? options : []);
  if (option && sel?.state !== option)
    await service("select", "select_option", { entity_id: o.streamOutput, option }).catch(
      (e: unknown) => console.warn("[output] stream select not set:", e),
    );
}

/** Texts made on the server (errors the panel shows as is) in the panel's language (UI_LANGUAGE, read per call). */
const serverT = () => makeT(parseLang(process.env["UI_LANGUAGE"]));
/** kindle_panel >= 0.9.0 answers move_queue; older ones answer nothing (then a refusal is an HA error). */
type MoveAnswer = { ok?: boolean; reason?: string; error?: string; restored?: string };
/** The one line the panel shows for a refused move: the reason in the panel's words plus HA's own text. */
export function moveReasonText(a: MoveAnswer, targetName: string): string {
  const t = serverT();
  const why =
    a.reason === "held"
      ? t("output.reasonHeld")
      : a.reason === "unavailable"
        ? t("output.reasonUnavailable", { name: targetName })
        : (a.error ?? "Music Assistant refused");
  const detail = a.reason === "failed" || !a.error ? "" : ` (${a.error})`;
  return t("output.moveRefused", { reason: `${why}${detail}` });
}

/** The one line the panel shows for a refused sync (bus task 023): the reason in the panel's words. */
export function syncReasonText(a: MoveAnswer, name: string): string {
  const t = serverT();
  const why =
    a.reason === "unavailable"
      ? t("output.reasonUnavailable", { name })
      : a.reason === "cannot"
        ? t("output.cantSync", { name })
        : a.reason === "not_joined"
          ? t("output.reasonNotJoined", { name })
          : (a.error ?? "Music Assistant refused");
  return t("output.syncRefused", { reason: why });
}

/** Sync (bus task 022): `entity` joins the sync group of the panel's output (the output, or the leader it follows,
 *  is the target) or leaves it. Music Assistant decides what can sync (can_group_with); the picker offers the key
 *  only for those. Bus task 023: through kindle_panel.sync_output, which answers why MA said no; the reason is shown
 *  like a refused move (music screen line + the action's error). An older kindle_panel without it: HA's
 *  media_player.join / unjoin as before. */
export async function syncOutputHa(entity: string, join: boolean): Promise<void> {
  const view = outputView(await fetchStates().catch(() => null));
  const row = view?.outputs.find((o) => o.entity_id === entity);
  if (!view || !row) throw new HomeError("Not a Music Assistant player");
  const want = syncActionFor(view.outputs, view.entity, row);
  if (want !== (join ? "join" : "unjoin"))
    throw new HomeError(serverT()("output.cantSync", { name: row.name }));
  const leader = syncLeaderOf(view.outputs, view.entity)!;
  let answer: MoveAnswer | undefined;
  try {
    const r = await ha<{ service_response?: MoveAnswer }>(
      "POST",
      "/api/services/kindle_panel/sync_output?return_response",
      { entity_id: entity, leader: leader.entity_id, join },
      20_000,
    );
    answer = r.service_response;
  } catch (e) {
    if (!(e instanceof HomeError) || e.status !== 400) throw e;
    // kindle_panel < 0.9.1 has no sync_output
    if (join)
      await service("media_player", "join", {
        entity_id: leader.entity_id,
        group_members: [entity],
      });
    else await service("media_player", "unjoin", { entity_id: entity });
  }
  invalidatePanelConfig();
  lastState = null;
  if (answer && answer.ok === false) {
    const reason = syncReasonText(answer, row.name);
    moveError = { name: row.name, error: reason, at: Date.now() };
    throw new HomeError(reason);
  }
  if (moveError) moveError = null;
}

/** Move the music here (bus task 021): Music Assistant's transfer_queue from the panel's output to `entity`
 *  (kindle_panel.move_queue: whole queue + position, auto play, the source stops); `entity` becomes the output and
 *  the picker shows "moving…" until it plays. */
export async function moveOutputHa(entity: string): Promise<void> {
  const l = panelConfigNow();
  const target = (l?.outputs ?? []).find((o) => o.entity_id === entity);
  if (!target) throw new HomeError("Not a Music Assistant player");
  const from = musicOutput()?.player;
  if (!from) throw new HomeError("No output to move the music from");
  if (from === entity) throw new HomeError("The music is already there");
  await alignStreamSelect(entity);
  moveError = null;
  const r = await ha<{ service_response?: MoveAnswer }>(
    "POST",
    "/api/services/kindle_panel/move_queue?return_response",
    { entity_id: entity, source_player: from },
    45_000,
  );
  const answer = r.service_response;
  if (answer && answer.ok === false) {
    // HA refused (target held / unavailable) or undid a failed transfer: the music stays where it was, so does the
    // output; the receiver's stream select goes back to the source (bus task 022)
    await alignStreamSelect(from);
    const reason = moveReasonText(answer, target.name);
    moveError = { name: target.name, error: reason, at: Date.now() };
    moving = null;
    lastState = null;
    invalidatePanelConfig();
    throw new HomeError(reason);
  }
  moving = { entity, name: target.name, startedAt: Date.now() };
  if (l) {
    l.musicOutput = entity;
    l.musicOutputValid = true;
  }
  invalidatePanelConfig();
  lastState = null;
  sentQueue = null; // MA's queue moved with the music
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
    case "output.move":
      await moveOutputHa(a.entity);
      return;
    case "output.sync":
      await syncOutputHa(a.entity, a.join);
      return;
    default:
      await legacy(a);
  }
}
