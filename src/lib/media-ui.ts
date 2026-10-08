// Pure helpers for the media screens: volume display rule, optimistic reducer for MediaAction,
// next/previous dispatch by what is playing, and status-line labels. No React, no network.
import { AMP } from "./media";
import type {
  AmpSource,
  AmpStatus,
  MediaAction,
  MediaSnapshot,
  NowPlaying,
  NowPlayingKind,
  PowerOnStep,
} from "./media";
import { makeT } from "./i18n";
import type { Key, Lang } from "./i18n";

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
    default:
      break;
  }
  return next;
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

/** Enter in the amp view: play/pause only means something for the Jellyfin queue. */
export const toggleAction = (s: MediaSnapshot | null): MediaAction | null =>
  s?.amp.on && s.nowPlaying.kind === "music" ? { type: "queue", op: "toggle" } : null;

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
    case "all_off":
      return t("act.allOff");
    case "queue":
      return action.op === "next"
        ? t("act.next")
        : action.op === "prev"
          ? t("act.prev")
          : t("act.playPause");
    default:
      return t("act.done");
  }
}

export const powerOnStepKey = (step: PowerOnStep): Key => `poweron.${step}` as Key;
