// Bus task 027: the Kindle's library is a Music Assistant client (MUSIC_BACKEND=ha). Pure model shared by the server
// functions, the panel hook and the screens: the sections (Music Assistant's sidebar sections in the owner's order,
// listed as plain rows since 2026-10-23), the rows (MA items through kindle_panel's library_* services), the soft-key maps of the
// Library, Discover and MA radio dial screens, the Library's two tabs (the sections list and Discover, 2026-11-22), the
// music screen's keys and the search list (order, groups, pages, recents).
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
/** List rows per page (the list screens' 8 two-line rows). */
export const LIBRARY_PAGE_SIZE = 8;
/** Discover: category rows per page (two-line rows, no item count line under the heading). */
export const DISCOVER_PAGE_SIZE = 7;
/** Discover: item rows per page of a row (54px rows, the heading has two lines). */
export const DISCOVER_ITEMS_PAGE_SIZE = 8;
export const discoverPageSize = (level: "categories" | "items"): number =>
  level === "items" ? DISCOVER_ITEMS_PAGE_SIZE : DISCOVER_PAGE_SIZE;
/** The Library's sections list (2026-10-23, no heading): eight rows fit one page without the page text (74px rows;
 *  68px under the tab strip, 2026-11-22); with more sections it paginates at Discover's category size so the page text
 *  fits above the footer. */
export const LIBRARY_SECTIONS_ONE_PAGE = 8;
export const librarySectionsPageSize = (count: number): number =>
  count <= LIBRARY_SECTIONS_ONE_PAGE ? LIBRARY_SECTIONS_ONE_PAGE : DISCOVER_PAGE_SIZE;
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
  /** The section the sections list's cursor starts on. */
  tab: LibraryTab | null;
  /** The panel option `discover_key`: the Library has a Discover tab (2026-11-22; it was a soft key before). */
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

/** The Library screen's two tabs (2026-11-22, the owner's call: Discover no longer hides behind a key): the sections
 *  list and Discover's categories, named on a strip above both top-level lists. The panel option `discover_key`
 *  decides whether the Discover tab exists; without it there is no strip at all. */
export const LIBRARY_TOP_TABS = ["library", "discover"] as const;
export type LibraryTopTab = (typeof LIBRARY_TOP_TABS)[number];
export const libraryTopTabs = (view: Pick<LibraryView, "discoverKey">): LibraryTopTab[] =>
  view.discoverKey ? [...LIBRARY_TOP_TABS] : [];
/** Left / Right on a top-level list: the tab the key points at, as the eye sees the strip (in Hebrew the first tab
 *  sits on the right, so Left is the next one); null when there is no tab on that side, and without a strip. */
export function topTabOnArrow(
  tabs: readonly LibraryTopTab[],
  current: LibraryTopTab,
  key: "ArrowLeft" | "ArrowRight",
  rtl: boolean,
): LibraryTopTab | null {
  const i = tabs.indexOf(current);
  if (i < 0) return null;
  const forward = key === "ArrowRight" ? !rtl : rtl;
  return tabs[i + (forward ? 1 : -1)] ?? null;
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
/** `items` in the order the panel shows them (see orderSearchItems); the first `top` are the exact matches. */
export type LibSearchResult = {
  ok: boolean;
  error?: string;
  query: string;
  items: LibItem[];
  top?: number;
};
export type LibPlayOption = "replace" | "next" | "add";
export type LibPlayResult = {
  ok: boolean;
  error?: string;
  status?: "playing" | "queued" | "powering_on";
};

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
  | null;
/** The Library's footer by context (documented in the report and KINDLE-APP.md). `tab` null = the sections list (Back
 *  only, like Discover's categories: since 2026-11-22 Discover is the tab next to it, reached with Left / Right, not a
 *  key). `opens`: the highlighted row is a container (F4 = Open instead of the heart; the heart of a container is on
 *  its opened view's "Play all" row). */
export function libraryKeys(ctx: {
  tab: LibraryTab | null;
  opened: boolean;
  searchKeys: boolean;
  opens?: boolean;
  /** Search, the highlight is on a recent search: nothing to queue or favour, Enter runs it. */
  recent?: boolean;
}): LibKey[] {
  if (ctx.tab === null) return ["back", null, null, null];
  if (ctx.tab === "search" && ctx.searchKeys && !ctx.opened)
    return ["back", "backspace", "space", "results"];
  if (ctx.tab === "search" && ctx.recent && !ctx.opened) return ["back", null, null, null];
  const f4: LibKey = ctx.opens ? "open" : "favourite";
  if (ctx.tab === "radio" && !ctx.opened) return ["back", "dial", "addQueue", f4];
  return ["back", "playNext", "addQueue", f4];
}
/** Discover's footer (plain two-level list, 2026-10-21): the categories only have Back (to the music screen; Left /
 *  Right change the tab); a category's items have Back (to the categories) and the heart. No play next / add / open
 *  here: Enter plays the item at once. */
export const discoverKeys = (level: "categories" | "items"): (LibKey | null)[] =>
  level === "items" ? ["back", null, null, "favourite"] : ["back", null, null, null];
export const MA_DIAL_KEYS: LibKey[] = ["back", "band", "favourite", "list"];

/** The music screen's footer with the HA backend (bus tasks 025 + 027): F1 = the playlist while the player has a queue,
 *  else "Radio" (the MA dial) while it plays an MA radio; F2 Library; F3 Player; F4 Search (2026-11-22, the owner's
 *  call: search one key away). Discover, which had F4, is the Library's second tab now (libraryTopTabs, panel option
 *  discover_key). */
export type MusicKey = "queue" | "radio" | "library" | "player" | "search" | null;
export function musicScreenKeys(ctx: { queue: boolean; maRadio: boolean }): MusicKey[] {
  return [ctx.queue ? "queue" : ctx.maRadio ? "radio" : null, "library", "player", "search"];
}

// ---- search (2026-11-22: Music Assistant's own search, shown the way its web app shows it) ----

/** The types asked of music/search and the order of the groups: the web app's order with radio moved up (songs first). */
export const SEARCH_TYPE_ORDER: LibMediaType[] = [
  "track",
  "artist",
  "album",
  "playlist",
  "radio",
  "podcast",
  "audiobook",
];
/** Items per type asked of Music Assistant (its web app shows five and a "more" row). */
export const SEARCH_LIMIT_PER_TYPE = 6;
/** Exact matches lifted into the "Top result" group: one per type at most, this many in all. */
export const SEARCH_TOP_MAX = 3;
const searchNorm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
/**
 * Music Assistant's answer in the order the panel lists it. As the web app does: duplicates dropped (same type, name
 * and first artist; never playlists) and, within a type, the items whose name is exactly the query first. On top of
 * that the first exact match of each type (songs first) is lifted to the head of the list, so the song that was typed
 * is the first row even on the four rows under the keyboard. Returns the list and how many head items are such matches.
 */
export function orderSearchItems<T>(
  raw: T[],
  query: string,
  get: (item: T) => { type: LibMediaType; name: string; artist?: string | null | undefined },
): { items: T[]; top: number } {
  const q = searchNorm(query);
  const seen = new Set<string>();
  const groups = new Map<LibMediaType, { exact: T[]; rest: T[] }>();
  for (const item of raw) {
    const g = get(item);
    if (g.type !== "playlist") {
      const key = `${g.type}:${searchNorm(g.name)}:${searchNorm((g.artist ?? "").split(",")[0])}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const group = groups.get(g.type) ?? { exact: [], rest: [] };
    groups.set(g.type, group);
    (q !== "" && searchNorm(g.name) === q ? group.exact : group.rest).push(item);
  }
  const types = [
    ...SEARCH_TYPE_ORDER.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !SEARCH_TYPE_ORDER.includes(t)),
  ];
  const top: T[] = [];
  for (const t of types) {
    const group = groups.get(t)!;
    if (top.length < SEARCH_TOP_MAX && group.exact.length) top.push(group.exact.shift()!);
  }
  return {
    items: [...top, ...types.flatMap((t) => [...groups.get(t)!.exact, ...groups.get(t)!.rest])],
    top: top.length,
  };
}

export type SearchGroup = "top" | LibMediaType;
/** One line of the results list: a group's slim heading, or an item (`index` into the flat list = the cursor). */
export type SearchEntry =
  | { kind: "heading"; group: SearchGroup }
  | { kind: "item"; group: SearchGroup; item: LibItem; index: number };
/** The results list's box with the keyboard hidden (px): what the pages may fill, a row, a heading, the gap. */
export const SEARCH_LIST_HEIGHTS = { budget: 462, item: 54, heading: 26, gap: 6 };
/**
 * The results list cut into pages by height: every group starts under its heading, a group that runs over a page gets
 * its heading again at the top of the next one, and a heading never ends a page.
 */
export function searchPages(
  items: LibItem[],
  top: number,
  h: { budget: number; item: number; heading: number; gap: number } = SEARCH_LIST_HEIGHTS,
): SearchEntry[][] {
  const pages: SearchEntry[][] = [];
  let page: SearchEntry[] = [];
  let used = 0;
  let last: SearchGroup | null = null;
  items.forEach((item, index) => {
    const group: SearchGroup = index < top ? "top" : item.mediaType;
    const cost = (withHeading: boolean) =>
      (withHeading ? h.heading + h.gap : 0) + h.item + (page.length ? h.gap : 0);
    if (page.length && used + cost(group !== last) > h.budget) {
      pages.push(page);
      page = [];
      used = 0;
      last = null;
    }
    used += cost(group !== last);
    if (group !== last) page.push({ kind: "heading", group });
    page.push({ kind: "item", group, item, index });
    last = group;
  });
  if (page.length) pages.push(page);
  return pages;
}
/** The page that holds the item at `index` (0 when there is none). */
export const searchPageOf = (pages: SearchEntry[][], index: number): number =>
  Math.max(
    0,
    pages.findIndex((p) => p.some((e) => e.kind === "item" && e.index === index)),
  );
/** The first item index of a page (the cursor after a page key). */
export const searchPageStart = (pages: SearchEntry[][], page: number): number => {
  const first = pages[page]?.find((e) => e.kind === "item");
  return first && first.kind === "item" ? first.index : 0;
};

/** Recent searches the panel keeps (Music Assistant's web app keeps five, per user, on its server). */
export const RECENT_SEARCH_MAX = 8;
/** A search goes to the head of the list; the same words in another case replace the older entry. */
export function addRecentSearch(
  list: string[],
  query: string,
  max: number = RECENT_SEARCH_MAX,
): string[] {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) return list.slice(0, max);
  return [q, ...list.filter((r) => searchNorm(r) !== searchNorm(q))].slice(0, max);
}
/** The recent searches offered for what is typed so far (the web app's rule: those that contain it). */
export const matchRecentSearches = (list: string[], typed: string): string[] => {
  const q = searchNorm(typed);
  return q ? list.filter((r) => searchNorm(r).includes(q)) : list;
};

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
