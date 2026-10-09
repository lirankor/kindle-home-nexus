// Pure helpers for the media screens: volume display rule, optimistic reducer for MediaAction,
// next/previous dispatch by what is playing, and status-line labels. No React, no network.
import { AMP, MIX_IDS } from "./media";
import type {
  AmpSource,
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

export const KIND_BY_SOURCE: Record<AmpSource, NowPlayingKind> = {
  SERVER: "music",
  CD: "tv",
  PHONO: "phono",
  TUNER: "fm",
  "NET RADIO": "radio",
};

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
  source === "NET RADIO" ? "radio" : source === "SERVER" ? "music" : "now";

/** The now-playing screen of a source: radio for NET RADIO, the amp view for everything else (SERVER included). */
export const sourceHomeScreen = (source: AmpSource | null | undefined): "radio" | "now" =>
  source === "NET RADIO" ? "radio" : "now";

/** Order of the source list rows: Jellyfin, TV, turntable, radio, FM. */
export const SOURCE_ROWS: readonly AmpSource[] = ["SERVER", "CD", "PHONO", "NET RADIO", "TUNER"];

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
    case "amp.power":
      next.amp.on = action.on;
      next.amp.state = action.on ? "on" : "off";
      next.amp.available = true;
      if (!action.on) next.nowPlaying = { ...EMPTY_PLAY };
      else if (next.amp.source) next.nowPlaying.kind = KIND_BY_SOURCE[next.amp.source];
      break;
    case "amp.source":
      next.amp.source = action.source;
      next.nowPlaying = {
        ...EMPTY_PLAY,
        kind: next.amp.on ? KIND_BY_SOURCE[action.source] : "none",
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
  s?.amp.on && s.nowPlaying.kind === "music" && s.queue
    ? { type: "queue", op: s.queue.status === "playing" ? "pause" : "resume" }
    : null;

/** Status-line text after an action; `after` is the optimistic snapshot (for the new volume). */
export function mediaActionLabel(action: MediaAction, lang: Lang, after?: MediaSnapshot): string {
  const t = makeT(lang);
  switch (action.type) {
    case "amp.power":
      return t(action.on ? "act.ampOn" : "act.ampOff");
    case "amp.source":
      return t("act.ampSource", { source: t(`source.${action.source}` as Key) });
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
