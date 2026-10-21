// Bus task 027: the Kindle's library is a Music Assistant client (MUSIC_BACKEND=ha). Pure model shared by the server
// functions, the panel hook and the screens: the tabs (Music Assistant's sidebar sections in the owner's order, the
// strip = four tabs + More), the rows (MA items through kindle_panel's library_* services), the soft-key maps of the
// Library, Discover and MA radio dial screens, and the music screen's keys (Discover on the free key).
import type { RadioStationView } from "./media";

/** The owner's tab order (addendum 3); kindle_panel answers the subset MA has a provider for, in this order. */
export const LIBRARY_TABS = [
  "playlists",
  "radio",
  "genres",
  "albums",
  "artists",
  "tracks",
  "podcasts",
  "audiobooks",
  "search",
] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];
export const DEFAULT_LIBRARY_TAB: LibraryTab = "playlists";
export const isLibraryTab = (v: unknown): v is LibraryTab =>
  (LIBRARY_TABS as readonly unknown[]).includes(v);
/** Tabs on the strip before More. Measured on the Kindle width (600 px, 22 px Alef bold): four tabs + More fit in Hebrew
 *  and English (report 027); if a translation ever overflows, the strip drops to three + More (`stripSlots`). */
export const STRIP_SLOTS = 4;
/** List rows per page (the list screens' 8 two-line rows). */
export const LIBRARY_PAGE_SIZE = 8;
/** Discover: items shown per page of a row. */
export const DISCOVER_PAGE_SIZE = 7;
/** MA radio dial: the band keys. */
export const MA_DIAL_BANDS = ["favourites", "all"] as const;
export type MaDialBand = (typeof MA_DIAL_BANDS)[number];
/** Left / Right on the MA dial plays the needle's station this long after the last press (one play per settled
 *  target, like the amp dial's coalescing). */
export const MA_DIAL_SETTLE_MS = 1500;

/** Bus task 029: Discover's rows (kindle_panel option media.discover_rows), in this fixed order; "recommendations" =
 *  the other rows of MA's recommendation providers. Podcasts / audiobooks exist but are off by default. */
export const DISCOVER_ROWS = [
  "recently_played",
  "favorite_playlists",
  "favorite_albums",
  "favorite_artists",
  "favorite_radio",
  "recommendations",
  "recently_added_albums",
  "random_albums",
  "podcasts",
  "audiobooks",
] as const;
export type DiscoverRow = (typeof DISCOVER_ROWS)[number];
export const DEFAULT_DISCOVER_ROWS: DiscoverRow[] = DISCOVER_ROWS.filter(
  (r) => r !== "podcasts" && r !== "audiobooks",
);

/** The panel's library, as kindle_panel's get_config answers it (`library`). */
export type LibraryView = {
  tabs: LibraryTab[];
  tab: LibraryTab | null;
  discoverKey: boolean;
  /** Discover's rows, handed back to library_home as `sections`. */
  discoverRows: DiscoverRow[];
};
export const DEFAULT_LIBRARY_VIEW: LibraryView = {
  tabs: [...LIBRARY_TABS],
  tab: DEFAULT_LIBRARY_TAB,
  discoverKey: true,
  discoverRows: [...DEFAULT_DISCOVER_ROWS],
};
export function libraryViewFrom(raw: unknown): LibraryView {
  if (!raw || typeof raw !== "object") return DEFAULT_LIBRARY_VIEW;
  const r = raw as {
    tabs?: unknown;
    tab?: unknown;
    discover_key?: unknown;
    discover_rows?: unknown;
  };
  const tabs = Array.isArray(r.tabs)
    ? LIBRARY_TABS.filter((t) => (r.tabs as unknown[]).includes(t))
    : [...LIBRARY_TABS];
  const tab = isLibraryTab(r.tab) && tabs.includes(r.tab) ? r.tab : (tabs[0] ?? null);
  const discoverRows = Array.isArray(r.discover_rows)
    ? DISCOVER_ROWS.filter((d) => (r.discover_rows as unknown[]).includes(d))
    : [...DEFAULT_DISCOVER_ROWS];
  return { tabs, tab, discoverKey: r.discover_key !== false, discoverRows };
}

export type LibMediaType =
  | "artist"
  | "album"
  | "track"
  | "playlist"
  | "radio"
  | "podcast"
  | "podcast_episode"
  | "audiobook"
  | "genre";
/** One Music Assistant item as the Kindle lists it. `art` = the /media/img token ("ma:" + MA image proxy URL). */
export type LibItem = {
  uri: string;
  mediaType: LibMediaType;
  name: string;
  sub: string | null;
  /** null = MA did not say (an item mapping). */
  favorite: boolean | null;
  /** A container: the Open key (F4) browses it (artist -> albums, album / playlist -> tracks, podcast -> episodes,
   *  genre -> albums); Enter plays it (bus task 029). */
  opens: boolean;
  art: string | null;
  inLibrary: boolean;
  durationS: number | null;
  /** A track's album (MA plays a track within the album it was opened from). */
  albumUri: string | null;
};
export type LibListResult = {
  ok: boolean;
  error?: string;
  total: number;
  offset: number;
  favorites: number;
  parent: LibItem | null;
  items: LibItem[];
};
export type LibHomeRow = { id: string; name: string; items: LibItem[] };
export type LibHomeResult = { ok: boolean; error?: string; rows: LibHomeRow[] };
export type LibSearchResult = { ok: boolean; error?: string; query: string; items: LibItem[] };
export type LibPlayOption = "replace" | "next" | "add";
export type LibPlayResult = {
  ok: boolean;
  error?: string;
  status?: "playing" | "queued" | "powering_on";
};

// ---- the tab strip ----

/** The strip (addendum 3): the first `slots` tabs in the owner's order, the active tab taking the last slot when it is
 *  further down, then More with every tab the strip does not show. Five tabs or fewer: no More. */
export function tabStrip(
  tabs: LibraryTab[],
  active: LibraryTab | null,
  slots = STRIP_SLOTS,
): { visible: LibraryTab[]; more: LibraryTab[] } {
  if (tabs.length <= slots + 1) return { visible: [...tabs], more: [] };
  const visible = tabs.slice(0, slots);
  if (active && !visible.includes(active)) visible[slots - 1] = active;
  return { visible, more: tabs.filter((t) => !visible.includes(t)) };
}
/** The strip's slots including More ("more"). */
export type StripSlot = LibraryTab | "more";
export const stripSlotsOf = (strip: { visible: LibraryTab[]; more: LibraryTab[] }): StripSlot[] =>
  strip.more.length ? [...strip.visible, "more"] : [...strip.visible];
/** Right / Left on the strip, in reading order, wrapping: the next slot; "more" opens the drop-down. */
export function stepStrip(slots: StripSlot[], active: LibraryTab, delta: 1 | -1): StripSlot {
  const i = slots.indexOf(active);
  const n = slots.length;
  return slots[((((i < 0 ? 0 : i) + delta) % n) + n) % n] ?? active;
}

// ---- rows ----

/** The opened list has a "Play all" row first (album, playlist, artist, genre: MA plays the whole thing). */
export const hasPlayAll = (parent: LibItem | null): boolean =>
  !!parent && ["album", "playlist", "artist", "genre"].includes(parent.mediaType);
/** The server page (offset, limit) that holds logical rows [page * size, page * size + size) of a list whose first
 *  logical row may be the "Play all" row (`shift` 1). */
export function pageWindow(
  page: number,
  size: number,
  shift: 0 | 1,
): { offset: number; limit: number } {
  const first = page * size;
  return first === 0 ? { offset: 0, limit: size - shift } : { offset: first - shift, limit: size };
}
/** Bus task 029: Enter plays now everywhere (Library, an opened list, search results, Discover) and the panel returns
 *  to the music screen; a container is browsed with the Open key (F4) instead. Play next / add to queue stay put. */
/** The row offers the Open key: a container item (not the "Play all" row, whose F4 is the parent's heart). */
export const rowOpens = (item: LibItem | null, playAllRow = false): boolean =>
  !!item && !playAllRow && item.opens;
/** Play options that leave the library for the music screen (play now); play next / add to queue do not. */
export const leavesLibrary = (option: LibPlayOption): boolean => option === "replace";
/** Play now: a track opened inside an album / playlist plays that list from the track (as MA does), else the item. */
export function playNowTarget(
  item: LibItem,
  parent: LibItem | null,
): { uri: string; startItem?: string } {
  if (item.mediaType === "track" && parent && ["album", "playlist"].includes(parent.mediaType))
    return { uri: parent.uri, startItem: item.uri };
  return { uri: item.uri };
}
/** The favourite state shown: the panel's own toggle wins until the list is read again. */
export const isFavourite = (item: LibItem, overrides: Record<string, boolean>): boolean =>
  overrides[item.uri] ?? item.favorite ?? false;

// ---- soft keys (F1..F4) ----

export type LibKey =
  | "back"
  | "playNext"
  | "addQueue"
  | "favourite"
  | "open"
  | "dial"
  | "list"
  | "band"
  | "backspace"
  | "space"
  | "results"
  | "choose"
  | null;
/** The Library's footer by context (documented in the report and KINDLE-APP.md). `opens`: the highlighted row is a
 *  container (F4 = Open instead of the heart; the heart of a container is on its opened view's "Play all" row). */
export function libraryKeys(ctx: {
  tab: LibraryTab;
  opened: boolean;
  more: boolean;
  searchKeys: boolean;
  opens?: boolean;
}): LibKey[] {
  if (ctx.more) return ["back", null, null, "choose"];
  if (ctx.tab === "search" && ctx.searchKeys && !ctx.opened)
    return ["back", "backspace", "space", "results"];
  const f4: LibKey = ctx.opens ? "open" : "favourite";
  if (ctx.tab === "radio" && !ctx.opened) return ["back", "dial", "addQueue", f4];
  return ["back", "playNext", "addQueue", f4];
}
/** Discover's footer (plain two-level list, 2026-10-21): the categories only have Back; a category's items have Back
 *  and the heart. No play next / add / open here: Enter plays the item at once. */
export const discoverKeys = (level: "categories" | "items"): (LibKey | null)[] =>
  level === "items" ? ["back", null, null, "favourite"] : ["back", null, null, null];
export const MA_DIAL_KEYS: LibKey[] = ["back", "band", "favourite", "list"];

/** The music screen's footer with the HA backend (bus tasks 025 + 027): F1 = the playlist while the player has a queue,
 *  else "Radio" (the MA dial) while it plays an MA radio; F2 Library; F3 Player; Discover takes the right-most free
 *  slot (F4 today) unless the panel option discover_key is off. */
export type MusicKey = "queue" | "radio" | "library" | "player" | "discover" | null;
export function musicScreenKeys(ctx: {
  queue: boolean;
  maRadio: boolean;
  discover: boolean;
}): MusicKey[] {
  const keys: MusicKey[] = [
    ctx.queue ? "queue" : ctx.maRadio ? "radio" : null,
    "library",
    "player",
    null,
  ];
  if (ctx.discover) {
    const free = keys.lastIndexOf(null);
    if (free >= 0) keys[free] = "discover";
  }
  return keys;
}

// ---- MA radio dial ----

/** MA radio items as dial stations (the amp dial's slider component, MA's data). */
export const maStations = (items: LibItem[]): RadioStationView[] =>
  items
    .filter((i) => i.mediaType === "radio")
    .map((i) => ({
      id: i.uri,
      name: i.name,
      url: "",
      codec: "",
      bitrate: 0,
      fm: null,
      logo: null,
      ytunerId: null,
      favourite: i.favorite ?? false,
    }));
const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** The station of a band that the player plays (by MA's station name), else -1. */
export const playingStationIndex = (
  items: LibItem[],
  station: string | null | undefined,
): number => (station ? items.findIndex((i) => norm(i.name) === norm(station)) : -1);
