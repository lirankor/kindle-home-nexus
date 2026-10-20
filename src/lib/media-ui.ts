// Pure helpers for the media screens: volume display rule, optimistic reducer for MediaAction,
// next/previous dispatch by what is playing, and status-line labels. No React, no network.
import { AMP, INPUT_NET_RADIO, INPUT_PHONO, INPUT_SERVER, INPUT_TUNER, MIX_IDS } from "./media";
import type {
  AmpSource,
  NodeView,
  AmpStatus,
  MediaAction,
  MediaSnapshot,
  MixId,
  MusicListItem,
  NowPlaying,
  NowPlayingKind,
  PowerOnStep,
  QueueProgress,
  RadioPosition,
  RadioStationView,
} from "./media";
import { makeT } from "./i18n";
import { localName } from "./home";
import type { Key, Lang, TFn } from "./i18n";

/** dB to show: the number entity when known, else derived from the 0..1 level, else null. */
export const displayDb = (amp: Pick<AmpStatus, "volumeDb" | "volume">): number | null =>
  amp.volumeDb !== null
    ? amp.volumeDb
    : amp.volume !== null
      ? Math.round(AMP.volumeMinDb + amp.volume * (AMP.volumeMaxDb - AMP.volumeMinDb))
      : null;

/** "-35", "-44.5", "—". */
export const formatDb = (db: number | null): string =>
  db === null ? "—" : Number.isInteger(db) ? String(db) : db.toFixed(1);

const clampDb = (db: number) => Math.max(AMP.volumeMinDb, Math.min(AMP.volumeMaxDb, db));
const dbToLevel = (db: number) => (db - AMP.volumeMinDb) / (AMP.volumeMaxDb - AMP.volumeMinDb);

/** What the panel shows for an input: the music / radio / FM / turntable screens, else just the input's name. */
export const kindForSource = (source: AmpSource): NowPlayingKind =>
  source === INPUT_SERVER
    ? "music"
    : source === INPUT_NET_RADIO
      ? "radio"
      : source === INPUT_TUNER
        ? "fm"
        : source === INPUT_PHONO
          ? "phono"
          : "input";

const EMPTY_PLAY: NowPlaying = {
  kind: "none",
  title: null,
  artist: null,
  album: null,
  station: null,
  artItemId: null,
  stationId: null,
  preset: null,
};

/** Screen to open after CHOOSING a source: radio for NET RADIO, the music library for SERVER, else the amp view. */
export const screenForSource = (source: AmpSource | null | undefined): "radio" | "music" | "now" =>
  source === INPUT_NET_RADIO ? "radio" : source === INPUT_SERVER ? "music" : "now";

/** The now-playing screen of a source: radio for NET RADIO, the amp view for everything else (SERVER included). */
export const sourceHomeScreen = (source: AmpSource | null | undefined): "radio" | "now" =>
  source === INPUT_NET_RADIO ? "radio" : "now";

/** The line under a station's name: the song MA / the receiver reports ("title · artist"), "" without one. */
export const radioSongLine = (n: Pick<NowPlaying, "title" | "artist">): string =>
  [n.title, n.artist].filter((x): x is string => !!x).join(" · ");

/** The receiver the amp screens belong to: the node whose entity is the amp player, else the first receiver. */
export const ampNode = (s: MediaSnapshot | null | undefined): NodeView | null =>
  s?.nodes?.find((n) => n.type === "receiver") ?? null;

/** A receiver with the bridge's NET RADIO station select: its NET RADIO input opens the dial (bus task 025). */
export const isNetRadioNode = (n: Pick<NodeView, "type" | "stations">): boolean =>
  n.type === "receiver" && Array.isArray(n.stations);

/** Music through HA (bus task 025): the music screen's hint when the selected player's amp is on an input that is not
 *  Music Assistant's (NET RADIO, TUNER, …): which input, and the Media tab key that opens the amp node. Null = MA's. */
export function ampElsewhereHint(s: MediaSnapshot | null | undefined, lang: Lang): string | null {
  if (!s?.output || !s.amp.on || !s.amp.source || s.amp.source === INPUT_SERVER) return null;
  const t = makeT(lang);
  const amp = ampNode(s);
  const input = inputLabel(lang, amp, s.amp.source);
  const i = amp ? (s.keys ?? []).indexOf(amp.id) : -1;
  return i >= 0 && amp
    ? t("music.ampOnInput", { input, amp: nodeLabel(lang, amp.name), key: `F${i + 1}` })
    : t("music.ampOnInputNoKey", { input });
}

/** The amp's input list rows: its receiver node's inputs (live source_list, hidden ones left out), in its order. */
export const ampSourceRows = (s: MediaSnapshot | null | undefined): AmpSource[] =>
  ampNode(s)?.sources ?? [];

/** An input's name on the panel: the name its node's `inputs` row gives (Hebrew when there is one), else the device's
 *  own title. */
export function inputLabel(
  lang: Lang,
  node: Pick<NodeView, "inputNames"> | null | undefined,
  source: string | null | undefined,
): string {
  if (!source) return "—";
  const n = node?.inputNames?.[source];
  return (lang === "he" ? n?.name_he || n?.name : n?.name) || source;
}

/** On-screen keyboard of the search screen, driven by the 5-way: an alphabetic grid scans faster
 *  than QWERTY when there is a cursor instead of fingers. Ten columns, so left / right walk a row
 *  and up / down jump a row; a Hebrew layout can be added as a second entry later. */
export const SEARCH_KEY_ROWS: Record<"en", readonly (readonly string[])[]> = {
  en: [
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    ["K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"],
    ["U", "V", "W", "X", "Y", "Z", "'", "&", "-", "."],
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ],
};
export const SEARCH_KEY_COLS = 10;
export const SEARCH_KEYS: readonly string[] = SEARCH_KEY_ROWS.en.flat();
/** Adds a typed character: letters are kept as shown, a second space in a row is ignored. */
export function appendSearchChar(query: string, ch: string, max: number): string {
  if (ch === " " && (query === "" || query.endsWith(" "))) return query;
  return (query + ch).slice(0, max);
}

/** Station id to treat as current: what the amp reports beats the persisted cursor. */
export const currentStationId = (s: MediaSnapshot | null): string | null =>
  s?.nowPlaying.stationId ?? null;

/** What the UI expects HA to report after `action`; reverted when the server says no. */
export function applyMediaOptimistic(s: MediaSnapshot, action: MediaAction): MediaSnapshot {
  const next: MediaSnapshot = {
    ...s,
    amp: { ...s.amp },
    nowPlaying: { ...s.nowPlaying },
    tv: { ...s.tv },
    queue: s.queue ? { ...s.queue } : null,
  };
  switch (action.type) {
    case "node": {
      next.nodes = (s.nodes ?? []).map((n) => {
        if (n.id !== action.id) return n;
        const m = { ...n };
        if (action.op === "power") {
          m.on = action.on;
          m.state = action.on ? "on" : "off";
        } else if (action.op === "volume" && m.volumeDb !== null)
          m.volumeDb = m.volumeDb + action.delta * AMP.volumeStepDb;
        else if (action.op === "source") m.source = action.source;
        else if (action.op === "stream") m.stream = action.option;
        else if (action.op === "movie") m.movieActive = action.on;
        return m;
      });
      break;
    }
    case "output":
      if (s.output)
        next.output = {
          ...s.output,
          entity: action.entity,
          valid: true,
          name: s.output.outputs.find((o) => o.entity_id === action.entity)?.name ?? action.entity,
        };
      break;
    case "output.move":
      // "moving…" at once; the output (and its label) switches only when HA moved the music (bus task 022: a refused
      // move used to leave the label on the target while the music stayed, or stopped, on the source)
      if (s.output) {
        const name =
          s.output.outputs.find((o) => o.entity_id === action.entity)?.name ?? action.entity;
        next.output = {
          ...s.output,
          moving: { entity: action.entity, name, startedAt: Date.now(), failed: null },
          moveError: null,
        };
      }
      break;
    case "amp.power":
      next.amp.on = action.on;
      next.amp.state = action.on ? "on" : "off";
      next.amp.available = true;
      if (!action.on) next.amp.playing = false;
      if (!action.on) next.nowPlaying = { ...EMPTY_PLAY };
      else if (next.amp.source) next.nowPlaying.kind = kindForSource(next.amp.source);
      break;
    case "amp.source":
      next.amp.source = action.source;
      next.nowPlaying = {
        ...EMPTY_PLAY,
        kind: next.amp.on ? kindForSource(action.source) : "none",
      };
      break;
    case "amp.volume.step": {
      const current = displayDb(s.amp);
      if (current === null) break;
      const db = clampDb(current + action.delta * AMP.volumeStepDb);
      next.amp.volumeDb = db;
      next.amp.volume = dbToLevel(db);
      break;
    }
    case "amp.volume.db":
      next.amp.volumeDb = clampDb(action.db);
      next.amp.volume = dbToLevel(next.amp.volumeDb);
      break;
    case "amp.volume.set":
      next.amp.volume = action.level;
      next.amp.volumeDb = null;
      break;
    case "plug":
      next.plugOn = action.on;
      break;
    case "tv":
      if (action.op === "turn_on") next.tv.state = "on";
      else if (action.op === "turn_off") next.tv.state = "off";
      else if (action.op === "toggle") next.tv.state = s.tv.state === "off" ? "on" : "off";
      break;
    case "movie":
      next.movieActive = action.on;
      break;
    case "fm.preset":
      next.nowPlaying.preset = action.preset;
      break;
    case "radio.playback":
      next.amp.state = action.op === "play" ? "playing" : "idle";
      next.amp.playing = action.op === "play";
      break;
    case "all_off":
      next.amp.on = false;
      next.amp.state = "off";
      next.nowPlaying = { ...EMPTY_PLAY };
      next.tv.state = "off";
      next.plugOn = false;
      if (next.queue) next.queue.status = "stopped";
      break;
    case "queue":
      if (next.queue) {
        if (action.op === "pause") next.queue.status = "paused";
        else if (action.op === "resume") next.queue.status = "playing";
        else if (action.op === "toggle")
          next.queue.status = next.queue.status === "playing" ? "paused" : "playing";
        else if (action.op === "stop") next.queue.status = "stopped";
        else if (action.op === "next" || action.op === "prev") {
          next.queue = applyQueueSkip(next.queue, action.op);
          const track = next.queue.track;
          if (track && next.nowPlaying.kind === "music")
            next.nowPlaying = {
              ...next.nowPlaying,
              title: track.title,
              artist: track.artist,
              album: track.album,
              artItemId: track.artItemId,
            };
        }
      }
      break;
    case "queue.jump":
      if (next.queue) {
        next.queue.index = action.index;
        next.queue.positionMs = 0;
        next.queue.status = "playing";
      }
      break;
    default:
      break;
  }
  return next;
}

/** The queue after next / prev, mirroring the server: prev restarts the track after 5 s, next past
 *  the last track ends the queue. The neighbour lists shift along; a neighbour we do not know yet
 *  leaves `track` null, which keeps the old titles on screen until the server answers. */
export function applyQueueSkip(q: QueueProgress, op: "next" | "prev"): QueueProgress {
  const prevTrack = q.prevTrack ?? null;
  const nextTracks = q.nextTracks ?? [];
  if (op === "next") {
    if (q.index + 1 >= q.count) return { ...q, status: "ended", positionMs: 0 };
    const track = nextTracks[0] ?? null;
    return {
      ...q,
      index: q.index + 1,
      track,
      positionMs: 0,
      durationMs: track?.durationMs ?? 0,
      status: "playing",
      prevTrack: q.track,
      nextTracks: nextTracks.slice(1),
    };
  }
  if (q.positionMs > 5000 || q.index === 0) return { ...q, positionMs: 0, status: "playing" };
  return {
    ...q,
    index: q.index - 1,
    track: prevTrack,
    positionMs: 0,
    durationMs: prevTrack?.durationMs ?? 0,
    status: "playing",
    prevTrack: null,
    nextTracks: q.track ? [q.track, ...nextTracks].slice(0, 3) : nextTracks,
  };
}

/** What the snapshot will say once the amp has tuned `station` (radio screen left/right, list Enter). */
export function applyRadioTune(
  s: MediaSnapshot,
  station: Pick<RadioStationView, "id" | "name">,
  pos: RadioPosition,
): MediaSnapshot {
  return {
    ...s,
    amp: { ...s.amp, source: "NET RADIO", state: s.amp.on ? "playing" : s.amp.state },
    nowPlaying: {
      ...EMPTY_PLAY,
      kind: "radio",
      station: station.name,
      stationId: station.id.startsWith("yt:") ? null : station.id,
    },
    radio: pos,
  };
}

/** What the snapshot will say once the server has started `item` (music list Enter): source SERVER,
 *  the first track (or the item itself until the queue is known) as now playing. */
export function applyMusicPlay(
  s: MediaSnapshot,
  item: Pick<MusicListItem, "kind" | "title" | "detail" | "artItemId">,
  queue: QueueProgress | null,
): MediaSnapshot {
  const track = queue?.track ?? null;
  return {
    ...s,
    amp: { ...s.amp, on: true, source: "SERVER", state: "playing" },
    nowPlaying: {
      ...EMPTY_PLAY,
      kind: "music",
      title: track?.title ?? item.title,
      artist:
        track?.artist ?? (item.kind === "track" ? (item.detail.split(" · ")[0] ?? null) : null),
      album: track?.album ?? (item.kind === "album" ? item.title : null),
      artItemId: track?.artItemId ?? item.artItemId,
    },
    queue: queue ?? s.queue,
  };
}

export const isMixId = (id: string): id is MixId => (MIX_IDS as readonly string[]).includes(id);
/** Row title: the four mixes are named here, everything else comes from Jellyfin as is. */
export const musicItemTitle = (item: Pick<MusicListItem, "kind" | "id" | "title">, t: TFn) =>
  item.kind === "mix" && isMixId(item.id) ? t(`music.mix.${item.id}` as Key) : item.title;
/** Row detail: mixes get their one-line description and track count; a bare number on an artist is
 *  an album count; anything else ("artist · year", "artist · album") is shown as it came. */
export function musicItemDetail(item: Pick<MusicListItem, "kind" | "id" | "detail">, t: TFn) {
  const n = /^\d+$/.test(item.detail) ? Number(item.detail) : null;
  if (item.kind === "mix") {
    const desc = isMixId(item.id) ? t(`music.mix.${item.id}.desc` as Key) : "";
    return [desc, n !== null ? t("music.tracks", { n }) : item.detail].filter(Boolean).join(" · ");
  }
  if (n !== null) return t(item.kind === "artist" ? "music.albums" : "music.tracks", { n });
  return item.detail;
}

/** Release date of an album row: the full date ("17 Apr 1973") when the tags have a real day, the
 *  year alone when they only knew that (Jellyfin stores a year-only tag as 1 January), else null. */
export function albumDateLabel(
  item: Pick<MusicListItem, "year" | "releaseDate">,
  lang: Lang,
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.releaseDate ?? "");
  if (m && !(m[2] === "01" && m[3] === "01")) {
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  return item.year ? String(item.year) : (m?.[1] ?? null);
}

/** Left/right in the amp view: the server decides how, the kind decides what. Null = nothing to do. */
export function stepAction(s: MediaSnapshot | null, delta: 1 | -1): MediaAction | null {
  if (!s || !s.amp.on) return null;
  switch (s.nowPlaying.kind) {
    case "music":
      return { type: "queue", op: delta > 0 ? "next" : "prev" };
    case "radio":
      return { type: "radio.step", delta };
    case "fm": {
      const preset = s.nowPlaying.preset;
      if (preset === null) return null;
      const n = Math.max(1, Math.min(40, preset + delta));
      return n === preset ? null : { type: "fm.preset", preset: n };
    }
    default:
      return null;
  }
}

/** Enter in the amp view: play/pause only means something for the Jellyfin queue. Pause is explicit
 *  (the amp cannot pause a pushed stream: the server stops and later re-pushes with a seek), resume
 *  covers paused, stopped and ended queues. */
export const toggleAction = (s: MediaSnapshot | null): MediaAction | null =>
  s?.queue && ((s.amp.on && s.nowPlaying.kind === "music") || (s.output && !s.amp.on))
    ? // music through HA with the receiver off: resume is what wakes it (the HA package powers the output's receiver)
      { type: "queue", op: s.queue.status === "playing" ? "pause" : "resume" }
    : null;

/** Status-line text after an action; `after` is the optimistic snapshot (for the new volume). */
export function mediaActionLabel(action: MediaAction, lang: Lang, after?: MediaSnapshot): string {
  const t = makeT(lang);
  switch (action.type) {
    case "amp.power":
      return t(action.on ? "act.ampOn" : "act.ampOff");
    case "amp.source":
      return t("act.ampSource", { source: inputLabel(lang, ampNode(after), action.source) });
    case "amp.volume.step":
    case "amp.volume.db":
    case "amp.volume.set":
      return t("act.volume", { db: formatDb(after ? displayDb(after.amp) : null) });
    case "tv":
      return t("act.tv", { op: t(`op.${action.op}` as Key) });
    case "movie":
      return t(action.on ? "act.movieOn" : "act.movieOff");
    case "radio.step":
      return t(action.delta > 0 ? "act.next" : "act.prev");
    case "fm.preset":
      return t("act.preset", { n: action.preset });
    case "radio.favourite":
      return t(action.add ? "act.favAdded" : "act.favRemoved");
    case "radio.playback":
      return t(action.op === "play" ? "act.radioPlay" : "act.radioStop");
    case "all_off":
      return t("act.allOff");
    case "output":
      return t("act.output", {
        name:
          after?.output?.outputs.find((o) => o.entity_id === action.entity)?.name ?? action.entity,
      });
    case "output.move":
      return t("act.move", {
        name:
          after?.output?.outputs.find((o) => o.entity_id === action.entity)?.name ?? action.entity,
      });
    case "output.sync":
      return t(action.join ? "act.sync" : "act.unsync", {
        name:
          after?.output?.outputs.find((o) => o.entity_id === action.entity)?.name ?? action.entity,
      });
    case "node": {
      const n = after?.nodes?.find((x) => x.id === action.id);
      const name = n ? nodeLabel(lang, n.name) : action.id;
      if (action.op === "power") return t(action.on ? "act.nodeOn" : "act.nodeOff", { name });
      if (action.op === "volume") return t("act.volume", { db: formatDb(n?.volumeDb ?? null) });
      if (action.op === "movie") return t(action.on ? "act.movieOn" : "act.movieOff");
      return t("act.done");
    }
    case "queue.jump":
      return t("act.track", { n: action.index + 1 });
    case "queue":
      return action.op === "next"
        ? t("act.next")
        : action.op === "prev"
          ? t("act.prev")
          : action.op === "pause"
            ? t("act.pause")
            : action.op === "resume"
              ? t("act.resume")
              : t("act.playPause");
    default:
      return t("act.done");
  }
}

export const powerOnStepKey = (step: PowerOnStep): Key => `poweron.${step}` as Key;

/**
 * The amp's footer slot (Media tab F3, amp view F4): "open" = the amp is on (or no snapshot yet) and
 * the slot keeps its usual action; "powerOn" while the amp is off, in standby or unknown (shown as
 * off); "powering" while the power-on routine runs (same action, drawn pressed). Never a standby
 * action while the amp is on (owner's call, 2026-10-15).
 */
export type AmpPowerSlot = "open" | "powerOn" | "powering";
export function ampPowerSlot(s: MediaSnapshot | null, running: boolean): AmpPowerSlot {
  if (!s || s.amp.on) return "open";
  return running ? "powering" : "powerOn";
}

/** A node's display name: its Hebrew name from the panel config (names.he), else the two household defaults in the
 *  app's own words, else the name as configured. */
export function nodeLabel(lang: Lang, name: string): string {
  const own = localName(lang, name);
  if (own !== name) return own;
  const t = makeT(lang);
  return name === "Sony TV" ? t("media.tvName") : name === "Yamaha R-N500" ? t("media.amp") : name;
}

/** The radio dial's amp (bus task 026): the receiver node the dial was opened from (else the first receiver with a
 *  NET RADIO station list), read from that node only (its power, input, volume, the bridge's NET RADIO station and the
 *  receiver's song line), never from the selected Music Assistant player's projection (with the TV as the player the
 *  dial used to find no amp). Null without the HA music backend or a receiver node: the dial keeps the amp snapshot. */
export type DialAmp = {
  id: string;
  available: boolean;
  on: boolean;
  source: string | null;
  volumeDb: number | null;
  /** The receiver plays its own NET RADIO input. */
  netRadio: boolean;
  playing: boolean;
  /** NET RADIO: the bridge's station id (= the dial's ids), its name from the station select, the song line. */
  stationId: string | null;
  station: string | null;
  title: string | null;
  artist: string | null;
};
export function dialAmp(
  s: MediaSnapshot | null | undefined,
  opened?: NodeView | null,
): DialAmp | null {
  if (!s?.output) return null;
  const n =
    opened && isNetRadioNode(opened)
      ? opened
      : (s.nodes?.find(isNetRadioNode) ?? ampNode(s) ?? null);
  if (!n) return null;
  const netRadio = n.on && n.source === INPUT_NET_RADIO;
  const station = netRadio ? (n.stations?.find((x) => x.option === n.station)?.name ?? null) : null;
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const title = netRadio && n.nowTitle && !same(n.nowTitle, station) ? n.nowTitle : null;
  const artist = netRadio && n.nowArtist && !same(n.nowArtist, station) ? n.nowArtist : null;
  return {
    id: n.id,
    available: n.available,
    on: n.on,
    source: n.source,
    volumeDb: n.on ? n.volumeDb : null,
    netRadio,
    playing: netRadio && !!n.playing,
    stationId: netRadio ? (n.stationId ?? null) : null,
    station,
    title,
    artist,
  };
}
