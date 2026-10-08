// Pure helpers for the radio screen: the four bands, where the needle is, the dial bar geometry and
// which station labels fit above / below the bar. No React, no network, so it is unit-testable.
import { FAVOURITES_LIST_ID } from "./media";
import type {
  MediaSnapshot,
  RadioListView,
  RadioListsResult,
  RadioPosition,
  RadioStationView,
} from "./media";
import type { Key } from "./i18n";
import type { RadioPanelState } from "./panel-state";

/** Band switch order; the catalog's "music" list is not a band on the dial. */
export const RADIO_BANDS = [FAVOURITES_LIST_ID, "local", "israel", "english"] as const;
export type RadioBand = (typeof RADIO_BANDS)[number];
export const isRadioBand = (id: string): id is RadioBand =>
  (RADIO_BANDS as readonly string[]).includes(id);
export const bandKey = (id: string): Key => `radio.band.${id}` as Key;

/** 0..n-1 with wrap-around; -1 when the list is empty. */
export const wrapIndex = (index: number, size: number): number =>
  size <= 0 ? -1 : ((index % size) + size) % size;

export const listById = (
  lists: RadioListView[] | null | undefined,
  id: string,
): RadioListView | undefined => lists?.find((l) => l.id === id);

export const stationAt = (
  lists: RadioListView[] | null | undefined,
  pos: RadioPosition | null,
): RadioStationView | undefined =>
  pos ? listById(lists, pos.list)?.stations[pos.index] : undefined;

/** Catalog ids are what the favourite action accepts; YTuner-only bookmarks are "yt:…". */
export const isCatalogStationId = (id: string) => !id.startsWith("yt:");

/**
 * Where a station id sits on the dial: the band the user is on first (so tuning inside a band never
 * jumps the dial to another band), then favourites, then the remaining bands. Null when unknown.
 */
export function findStationPosition(
  lists: RadioListView[],
  stationId: string,
  preferList?: string | null,
): RadioPosition | null {
  const order = [preferList, ...RADIO_BANDS].filter(
    (id, i, all): id is string => typeof id === "string" && all.indexOf(id) === i,
  );
  for (const list of order) {
    const index = listById(lists, list)?.stations.findIndex((s) => s.id === stationId) ?? -1;
    if (index >= 0) return { list, index };
  }
  return null;
}

/** First band with stations: favourites when there are any, else the local list. */
export const defaultBand = (lists: RadioListView[] | null | undefined): string =>
  (listById(lists, FAVOURITES_LIST_ID)?.stations.length ?? 0) > 0 ? FAVOURITES_LIST_ID : "local";

/**
 * The position the dial shows: the user's band + remembered index, clamped to the list; before the
 * user touched the dial, the playing station's position, then the server's cursor, then band start.
 */
export function dialPosition(
  state: RadioPanelState | null,
  lists: RadioListView[] | null | undefined,
  snapshot: MediaSnapshot | null,
): RadioPosition {
  if (!lists || lists.length === 0) return { list: state?.list ?? "local", index: 0 };
  if (state && isRadioBand(state.list) && listById(lists, state.list)) {
    const size = listById(lists, state.list)?.stations.length ?? 0;
    const index = state.indexByList[state.list] ?? 0;
    return { list: state.list, index: size === 0 ? 0 : Math.min(index, size - 1) };
  }
  const playing = playingPosition(lists, snapshot, null);
  if (playing) return playing;
  return { list: defaultBand(lists), index: 0 };
}

/** Where the amp's current station is on the dial (by catalog id, else the server's cursor). */
export function playingPosition(
  lists: RadioListView[],
  snapshot: MediaSnapshot | null,
  preferList: string | null,
): RadioPosition | null {
  if (!snapshot) return null;
  const id = snapshot.nowPlaying.stationId;
  if (id) {
    const found = findStationPosition(lists, id, preferList);
    if (found) return found;
  }
  const cur = snapshot.radio;
  if (cur && isRadioBand(cur.list) && stationAt(lists, cur)) return cur;
  return null;
}

export const withPosition = (
  state: RadioPanelState | null,
  pos: RadioPosition,
): RadioPanelState => ({
  list: pos.list,
  indexByList: { ...(state?.indexByList ?? {}), [pos.list]: pos.index },
});

/** Optimistic lists after adding / removing a catalog station from the favourites band. */
export function toggleFavouriteInLists(
  result: RadioListsResult,
  station: RadioStationView,
  add: boolean,
): RadioListsResult {
  return {
    ...result,
    lists: result.lists.map((l) => {
      if (l.id === FAVOURITES_LIST_ID) {
        const without = l.stations.filter((s) => s.id !== station.id);
        return {
          ...l,
          stations: add ? [...without, { ...station, favourite: true }] : without,
        };
      }
      return {
        ...l,
        stations: l.stations.map((s) => (s.id === station.id ? { ...s, favourite: add } : s)),
      };
    }),
  };
}

/** "128k · MP3" (blank parts omitted). */
export const stationDetail = (s: Pick<RadioStationView, "bitrate" | "codec">, sep = " · ") =>
  [s.bitrate > 0 ? `${s.bitrate}k` : "", s.codec].filter(Boolean).join(sep);

/** Dial label: FM MHz for stations that have one on the local band, else a short name. */
export const stationLabel = (s: Pick<RadioStationView, "name" | "fm">, list: string): string =>
  list === "local" && s.fm !== null ? s.fm.toFixed(1) : shortName(s.name);

/** About ten characters: cut at a word boundary when that keeps enough, else hard-cut with an ellipsis. */
export function shortName(name: string, max = 10): string {
  const trimmed = name.trim();
  if (trimmed.length <= max + 1) return trimmed;
  const head = trimmed.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  if (space >= 6) return head.slice(0, space);
  return `${trimmed.slice(0, max)}…`;
}

// ---- Geometry (viewBox units; the SVG scales to the content width) ----
export const DIAL = {
  width: 544,
  height: 150,
  barY: 80,
  barH: 18,
  endBlock: 48,
  dash: 12,
  gap: 4,
  stop: 24,
  /** First / last station x; the band name owns the top-left, so the first stop starts after it. */
  x0: 140,
  x1: 500,
  needleW: 10,
  labelPx: 19,
  currentPx: 22,
  namePx: 22,
  aboveY: 64,
  belowY: 132,
} as const;

export const stationX = (index: number, count: number): number =>
  count <= 1
    ? (DIAL.x0 + DIAL.x1) / 2
    : DIAL.x0 + (index * (DIAL.x1 - DIAL.x0)) / Math.max(1, count - 1);

/** Segment rectangles of the bar: solid ends, dashes between, a longer solid stop at every `stops` x. */
export function dialSegments(stops: number[]): { x: number; w: number }[] {
  const { width, endBlock, dash, gap } = DIAL;
  const out: { x: number; w: number }[] = [{ x: 0, w: endBlock }];
  for (let x = endBlock + gap; x + dash <= width - endBlock - gap; x += dash + gap)
    out.push({ x, w: dash });
  out.push({ x: width - endBlock, w: endBlock });
  for (const x of stops) out.push({ x: x - DIAL.stop / 2, w: DIAL.stop });
  return out;
}

export type DialSide = "above" | "below";
export type DialLabel = {
  index: number;
  side: DialSide;
  /** Text x: the centre, or the edge next to the needle for the current station. */
  x: number;
  anchor: "middle" | "start" | "end";
  text: string;
  current: boolean;
};

/** Rough text width in px for Alef at `px` (digits and Hebrew run narrower than Latin). */
export const estimateWidth = (text: string, px: number) =>
  Array.from(text).reduce((w, ch) => w + px * (/[0-9.:\u0590-\u05ff ]/.test(ch) ? 0.5 : 0.58), 0) +
  6;

/**
 * Which stations get a label and on which side of the bar. The current station is always labelled;
 * the rest are added outwards from it, alternating sides, and skipped when they would overlap one
 * already placed on that side (or the band name, which sits above the left end).
 */
export function planDialLabels(
  texts: string[],
  current: number,
  reservedAbove: [number, number] | null,
): DialLabel[] {
  const n = texts.length;
  if (n === 0) return [];
  const placed: Record<DialSide, [number, number][]> = {
    above: reservedAbove ? [reservedAbove] : [],
    below: [],
  };
  const clampX = (x: number, w: number) => Math.max(w / 2, Math.min(DIAL.width - w / 2, x));
  const fits = (side: DialSide, x: number, w: number) =>
    placed[side].every(([a, b]) => x + w / 2 + 6 <= a || x - w / 2 - 6 >= b);
  const put = (
    index: number,
    side: DialSide,
    x: number,
    w: number,
    anchor: DialLabel["anchor"] = "middle",
  ): DialLabel => {
    const left = anchor === "middle" ? x - w / 2 : anchor === "start" ? x : x - w;
    placed[side].push([left, left + w]);
    return { index, side, x, anchor, text: texts[index] ?? "", current: anchor !== "middle" };
  };
  const out: DialLabel[] = [];
  const cur = current >= 0 && current < n ? current : -1;
  if (cur >= 0) {
    // The current label sits beside the needle (never under it): to its right, or to its left at the end.
    const w = estimateWidth(texts[cur] ?? "", DIAL.currentPx);
    const nx = stationX(cur, n);
    const right = nx + DIAL.needleW / 2 + 6;
    const anchor: DialLabel["anchor"] = right + w <= DIAL.width ? "start" : "end";
    const x = anchor === "start" ? right : nx - DIAL.needleW / 2 - 6;
    const side: DialSide = fits("above", anchor === "start" ? x + w / 2 : x - w / 2, w)
      ? "above"
      : "below";
    out.push(put(cur, side, x, w, anchor));
    // No other label under the needle, on either side.
    const needle: [number, number] = [nx - DIAL.needleW / 2 - 4, nx + DIAL.needleW / 2 + 4];
    placed.above.push(needle);
    placed.below.push(needle);
  }
  let lastSide: DialSide = out[0]?.side ?? "below";
  const order: number[] = [];
  for (let d = 1; d < n; d++) {
    if (cur + d < n) order.push(cur + d);
    if (cur - d >= 0) order.push(cur - d);
  }
  if (cur < 0) for (let i = 0; i < n; i++) order.push(i);
  for (const i of order) {
    const w = estimateWidth(texts[i] ?? "", DIAL.labelPx);
    const x = clampX(stationX(i, n), w);
    const preferred: DialSide = lastSide === "above" ? "below" : "above";
    const side = fits(preferred, x, w) ? preferred : fits(lastSide, x, w) ? lastSide : null;
    if (!side) continue;
    out.push(put(i, side, x, w));
    lastSide = side;
  }
  return out.sort((a, b) => a.index - b.index);
}
