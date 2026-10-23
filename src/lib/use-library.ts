// Bus task 027 (+ 029: Enter plays now everywhere and returns to the music screen, F4 Open browses a container, Discover
// rows from the panel option): state and keys of the Music Assistant client screens (MUSIC_BACKEND=ha): the Library (a
// plain list of MA's sections, then a section's list, 2026-10-23), Discover (MA's Home rows) and the MA radio dial (MA's radios on the amp dial's slider). Data comes
// from kindle_panel's library_* services through library.functions.ts. useMediaPanel owns the screen and the footer.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CornerDownLeft,
  Delete,
  FolderOpen,
  Gauge,
  Heart,
  ListEnd,
  ListMusic,
  ListPlus,
  Radio,
  Space,
} from "lucide-react";
import type { DeviceAction } from "@/components/device-actions";
import type { Key, Lang } from "@/lib/i18n";
import {
  DEFAULT_LIBRARY_VIEW,
  discoverPageSize,
  LIBRARY_PAGE_SIZE,
  MA_DIAL_KEYS,
  MA_DIAL_SETTLE_MS,
  discoverKeys,
  hasPlayAll,
  isFavourite,
  leavesLibrary,
  libraryKeys,
  librarySectionsPageSize,
  pageWindow,
  playNowTarget,
  playingStationIndex,
  rowOpens,
} from "@/lib/library";
import type {
  LibHomeResult,
  LibItem,
  LibKey,
  LibListResult,
  LibPlayOption,
  LibSearchResult,
  LibraryTab,
  MaDialBand,
} from "@/lib/library";
import {
  favouriteLibrary,
  getLibraryHome,
  getLibraryList,
  playLibrary,
  searchLibraryItems,
} from "@/lib/library.functions";
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from "@/lib/media";
import type { MediaAction, MediaSnapshot } from "@/lib/media";
import { SEARCH_KEYS, SEARCH_KEY_COLS, appendSearchChar } from "@/lib/media-ui";

export type LibScreen = "library" | "discover" | "madial";
/** A row of the Library's list: the "Play all" row of an opened album / playlist / artist / genre, or an item. */
export type LibRow = { kind: "playAll"; parent: LibItem } | { kind: "item"; item: LibItem };
type Opened = { item: LibItem; cursor: number };
const NAV = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];
const HOME_STALE_MS = 2 * 60_000;
const LIST_STALE_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 250;
const DIAL_LIST_LIMIT = 100;

export function useLibrary({
  screen,
  open,
  t,
  notify,
  data,
  act,
  afterPlay,
}: {
  screen: string | null;
  open: (s: "now" | LibScreen) => void;
  /** The panel's language (kept in the call; Left / Right no longer depend on the reading direction). */
  lang: Lang;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  notify: (n: { text: string; error?: boolean }) => void;
  data: MediaSnapshot | null;
  act: (a: MediaAction) => Promise<void>;
  /** A play went through: the panel refreshes its snapshot (and goes to the music screen for play now). */
  afterPlay: (nowScreen: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const view = data?.output?.library ?? DEFAULT_LIBRARY_VIEW;
  const tabs = view.tabs;
  // 2026-10-23 (owner): the Library is a plain list of the sections (section === null), Enter opens one; Back climbs.
  const [sectionState, setSection] = useState<LibraryTab | null>(null);
  const section: LibraryTab | null =
    sectionState && tabs.includes(sectionState) ? sectionState : null;
  /** The sections list's cursor, kept while the hook lives; null = start on the panel's configured tab. */
  const [sectionsCursorState, setSectionsCursor] = useState<number | null>(null);
  const sectionsCursor = Math.max(
    0,
    Math.min(
      sectionsCursorState ?? (view.tab ? tabs.indexOf(view.tab) : 0),
      Math.max(0, tabs.length - 1),
    ),
  );
  const sectionsPageSize = librarySectionsPageSize(tabs.length);
  const sectionsPage = Math.floor(sectionsCursor / sectionsPageSize);
  const sectionsPages = Math.max(1, Math.ceil(tabs.length / sectionsPageSize));
  /** The section whose list queries run ("playlists" only as a placeholder key while the sections list shows). */
  const tab: LibraryTab = section ?? "playlists";
  const [stack, setStack] = useState<Opened[]>([]);
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState<{ query: string; focus: "keys" | "results"; key: number }>({
    query: "",
    focus: "keys",
    key: 0,
  });
  /** The panel's own heart presses, shown until the lists are read again. */
  const [favs, setFavs] = useState<Record<string, boolean>>({});
  const opened = stack.length ? stack[stack.length - 1]!.item : null;

  // ---- Library list ----
  const shift: 0 | 1 = hasPlayAll(opened) ? 1 : 0;
  const page = Math.floor(cursor / LIBRARY_PAGE_SIZE);
  const win = pageWindow(page, LIBRARY_PAGE_SIZE, shift);
  // Lazy (owner, 2026-10-23): nothing is fetched while the sections list shows; a section's list loads only after Enter
  // on its row, and Back to the sections list just disables the query (the cache stays, no refetch).
  const listMode =
    screen === "library" && section !== null && (opened !== null || tab !== "search");
  const listKey = opened?.uri ?? tab;
  const listQuery = useQuery<LibListResult>({
    queryKey: ["lib", "list", listKey, win.offset, win.limit],
    queryFn: () =>
      getLibraryList({
        data: opened
          ? { parent: opened.uri, offset: win.offset, limit: win.limit }
          : { section: tab as Exclude<LibraryTab, "search">, offset: win.offset, limit: win.limit },
      }),
    enabled: listMode,
    staleTime: LIST_STALE_MS,
    // keep the previous page only while paging the same list; another section / container shows the busy state
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === listKey ? prev : undefined),
  });
  const list = listQuery.data ?? null;
  const listTotal = (list?.total ?? 0) + shift;
  const listRows: LibRow[] = [
    ...(shift && page === 0 && opened
      ? [{ kind: "playAll" as const, parent: list?.parent ?? opened }]
      : []),
    ...(list?.items ?? []).map((item) => ({ kind: "item" as const, item })),
  ];
  const listPages = Math.max(1, Math.ceil(listTotal / LIBRARY_PAGE_SIZE));
  const rowAt = (abs: number): LibRow | undefined => listRows[abs - page * LIBRARY_PAGE_SIZE];

  // ---- Search tab ----
  const [term, setTerm] = useState("");
  useEffect(() => {
    const q = search.query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setTerm("");
      return;
    }
    const id = setTimeout(() => setTerm(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search.query]);
  const searchQuery = useQuery<LibSearchResult>({
    queryKey: ["lib", "search", term],
    queryFn: () => searchLibraryItems({ data: { query: term } }),
    enabled:
      screen === "library" && section === "search" && !opened && term.length >= SEARCH_MIN_CHARS,
    staleTime: LIST_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const searchActive = search.query.trim().length >= SEARCH_MIN_CHARS;
  const searchRows: LibItem[] = searchActive ? (searchQuery.data?.items ?? []) : [];
  const searchCursor = Math.min(cursor, Math.max(0, searchRows.length - 1));
  const searchKeysFocus = section === "search" && !opened && search.focus === "keys";

  // ---- Discover ----
  const discoverRows = view.discoverRows;
  const homeQuery = useQuery<LibHomeResult>({
    queryKey: ["lib", "home", discoverRows.join(",")],
    queryFn: () => getLibraryHome({ data: { sections: discoverRows } }),
    enabled: screen === "discover",
    staleTime: HOME_STALE_MS,
  });
  const homeRows = homeQuery.data?.rows ?? [];
  // Two levels (2026-10-21, the user's UX call): a plain list of the categories (row === null), then the chosen
  // category's items. Enter on a category opens it, Enter on an item plays it at once, Back climbs one level.
  const [disc, setDisc] = useState<{ row: number | null; cursor: number }>({
    row: null,
    cursor: 0,
  });
  const discLevel: "categories" | "items" = disc.row === null ? "categories" : "items";
  const discRowIndex =
    disc.row === null ? -1 : Math.min(disc.row, Math.max(0, homeRows.length - 1));
  const discRow = disc.row === null ? null : (homeRows[discRowIndex] ?? null);
  const discItems = discRow?.items ?? [];
  const discCursor = Math.min(
    disc.cursor,
    Math.max(0, (discLevel === "items" ? discItems.length : homeRows.length) - 1),
  );
  const discPageSize = discoverPageSize(discLevel);
  const discPage = Math.floor(discCursor / discPageSize);
  const discCount = discLevel === "items" ? discItems.length : homeRows.length;
  const discPages = Math.max(1, Math.ceil(discCount / discPageSize));

  // ---- MA radio dial ----
  const [dial, setDial] = useState<{ band: MaDialBand; index: number; from: "now" | "library" }>({
    band: "favourites",
    index: 0,
    from: "now",
  });
  const dialFav = useQuery<LibListResult>({
    queryKey: ["lib", "dial", "favourites"],
    queryFn: () =>
      getLibraryList({
        data: { section: "radio", favorite: true, offset: 0, limit: DIAL_LIST_LIMIT },
      }),
    enabled: screen === "madial",
    staleTime: LIST_STALE_MS,
  });
  const dialAll = useQuery<LibListResult>({
    queryKey: ["lib", "dial", "all"],
    queryFn: () =>
      getLibraryList({ data: { section: "radio", offset: 0, limit: DIAL_LIST_LIMIT } }),
    enabled: screen === "madial",
    staleTime: LIST_STALE_MS,
  });
  const dialItems = useMemo(
    () => (dial.band === "favourites" ? dialFav.data?.items : dialAll.data?.items) ?? [],
    [dial.band, dialFav.data, dialAll.data],
  );
  const dialIndex = Math.min(dial.index, Math.max(0, dialItems.length - 1));
  const dialStation = dialItems[dialIndex] ?? null;
  const playingStation =
    data?.output && data.amp.on && data.amp.source === "SERVER" && data.nowPlaying.kind === "radio"
      ? (data.nowPlaying.station ?? null)
      : null;
  const dialSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (dialSettle.current) clearTimeout(dialSettle.current);
    },
    [],
  );
  // opened while a station plays: the needle on it (once the band's list is there)
  const needleSynced = useRef<string | null>(null);
  useEffect(() => {
    if (screen !== "madial") {
      needleSynced.current = null;
      return;
    }
    const key = `${dial.band}|${playingStation ?? ""}|${dialItems.length}`;
    if (!playingStation || !dialItems.length || needleSynced.current === key) return;
    needleSynced.current = key;
    const i = playingStationIndex(dialItems, playingStation);
    if (i >= 0) setDial((d) => ({ ...d, index: i }));
  }, [screen, dial.band, playingStation, dialItems]);

  // ---- actions ----
  const play = useCallback(
    async (
      target: { uri: string; startItem?: string },
      option: LibPlayOption,
      title: string,
      leave: boolean = leavesLibrary(option),
    ) => {
      notify({
        text: option === "replace" ? t("music.playing", { title }) : t("lib.sending", { title }),
      });
      // bus task 029: play now leaves the library at once for the music screen (as before task 027); play next / add
      // to queue stay (the owner may queue several); the MA dial stays on the dial while tuning
      if (leave) open("now");
      try {
        const r = await playLibrary({ data: { ...target, option } });
        if (!r.ok) {
          notify({ text: r.error ?? t("err.failed"), error: true });
          return;
        }
        notify({
          text:
            r.status === "powering_on"
              ? t("lib.poweringOn", { title })
              : option === "next"
                ? t("lib.queuedNext", { title })
                : option === "add"
                  ? t("lib.queuedAdd", { title })
                  : t("music.playing", { title }),
        });
        afterPlay(leave);
      } catch {
        notify({ text: t("err.server"), error: true });
      }
    },
    [notify, t, afterPlay, open],
  );
  const toggleFavourite = useCallback(
    async (item: LibItem) => {
      const want = !isFavourite(item, favs);
      setFavs((f) => ({ ...f, [item.uri]: want }));
      try {
        const r = await favouriteLibrary({ data: { uri: item.uri, favorite: want } });
        if (!r.ok) throw new Error(r.error ?? "refused");
        notify({ text: t(want ? "lib.faved" : "lib.unfaved", { title: item.name }) });
        void queryClient.invalidateQueries({ queryKey: ["lib"] });
      } catch (e) {
        setFavs((f) => ({ ...f, [item.uri]: !want }));
        notify({ text: e instanceof Error ? e.message : t("err.failed"), error: true });
      }
    },
    [favs, notify, t, queryClient],
  );

  // ---- navigation ----
  const openLibrary = () => {
    setSection(null);
    setStack([]);
    setCursor(0);
    setFavs({});
    open("library");
  };
  const openDiscover = () => {
    setFavs({});
    setDisc({ row: null, cursor: 0 });
    open("discover");
  };
  const openMaDial = (from: "now" | "library") => {
    // the band of the station that plays (favourites when it is one), else favourites
    const favItems =
      queryClient.getQueryData<LibListResult>(["lib", "dial", "favourites"])?.items ?? [];
    const inFav =
      !playingStation || playingStationIndex(favItems, playingStation) >= 0 || !favItems.length;
    setDial((d) => ({ ...d, band: inFav ? "favourites" : "all", from }));
    open("madial");
  };
  /** Enter on the sections list (or the MA dial's way back): that section's list from the top. */
  const selectTab = (next: LibraryTab) => {
    setSection(next);
    const i = tabs.indexOf(next);
    if (i >= 0) setSectionsCursor(i);
    setStack([]);
    setCursor(0);
    setSearch((s) => ({ ...s, focus: "keys" }));
  };
  const moveSections = (delta: number) =>
    setSectionsCursor(Math.max(0, Math.min(Math.max(0, tabs.length - 1), sectionsCursor + delta)));
  const back = () => {
    if (section === null) return open("now");
    if (stack.length) {
      const top = stack[stack.length - 1]!;
      setStack(stack.slice(0, -1));
      setCursor(top.cursor);
      return;
    }
    if (tab === "search" && search.focus === "results")
      return setSearch((s) => ({ ...s, focus: "keys" }));
    setSection(null);
    setCursor(0);
  };
  const highlightedRow = (): LibRow | null => {
    if (section === null) return null;
    if (tab === "search" && !opened) {
      const item = search.focus === "results" ? searchRows[searchCursor] : undefined;
      return item ? { kind: "item", item } : null;
    }
    return rowAt(Math.min(cursor, Math.max(0, listTotal - 1))) ?? null;
  };
  /** F4 Open on a container row: browse it (its "Play all" row first). */
  const openItem = (item: LibItem) => {
    if (!item.opens) return;
    setStack((s) => [...s, { item, cursor: tab === "search" && !opened ? searchCursor : cursor }]);
    setCursor(0);
  };
  /** Enter (bus task 029): play now, whatever the row (a container plays whole, a track inside an opened album /
   *  playlist plays that list from the track), then the music screen. */
  const enter = () => {
    const row = highlightedRow();
    if (!row) return;
    if (row.kind === "playAll") void play({ uri: row.parent.uri }, "replace", row.parent.name);
    else void play(playNowTarget(row.item, opened), "replace", row.item.name);
  };
  const moveCursor = (delta: number) => {
    if (tab === "search" && !opened) {
      if (delta < 0 && searchCursor === 0) setSearch((s) => ({ ...s, focus: "keys" }));
      else setCursor(Math.max(0, Math.min(searchRows.length - 1, searchCursor + delta)));
      return;
    }
    setCursor((c) => Math.max(0, Math.min(Math.max(0, listTotal - 1), c + delta)));
  };
  const typeChar = (ch: string) => {
    setSearch((s) => ({
      ...s,
      query: appendSearchChar(s.query, ch, SEARCH_MAX_CHARS),
      focus: "keys",
    }));
    setCursor(0);
  };
  const backspace = () => setSearch((s) => ({ ...s, query: s.query.slice(0, -1), focus: "keys" }));
  const toResults = () => {
    if (!searchRows.length) return;
    setSearch((s) => ({ ...s, focus: "results" }));
    setCursor(0);
  };
  const setSearchKey = (key: number) =>
    setSearch((s) => ({
      ...s,
      focus: "keys",
      key: Math.max(0, Math.min(SEARCH_KEYS.length - 1, key)),
    }));

  // Discover
  const discItem = discLevel === "items" ? (discItems[discCursor] ?? null) : null;
  const moveDisc = (delta: number) => {
    const n = discLevel === "items" ? discItems.length : homeRows.length;
    setDisc((d) => ({
      ...d,
      cursor: Math.max(0, Math.min(Math.max(0, n - 1), discCursor + delta)),
    }));
  };
  /** Enter on a category: its items (the highlight starts at the top). */
  const openDiscCategory = () => {
    if (!homeRows.length) return;
    setDisc({ row: discCursor, cursor: 0 });
  };
  /** Back on the items: the categories, highlight on the one that was open; on the categories: the music screen. */
  const discBack = () => {
    if (disc.row === null) open("now");
    else setDisc({ row: null, cursor: discRowIndex });
  };

  // MA dial
  const tuneDial = (index: number, now = false) => {
    const item = dialItems[index];
    if (!item) return;
    setDial((d) => ({ ...d, index }));
    if (dialSettle.current) clearTimeout(dialSettle.current);
    const go = () => {
      dialSettle.current = null;
      void play({ uri: item.uri }, "replace", item.name, false);
    };
    if (now) go();
    else dialSettle.current = setTimeout(go, MA_DIAL_SETTLE_MS);
  };
  const stepDial = (delta: 1 | -1) => {
    const n = dialItems.length;
    if (!n) return;
    tuneDial((((dialIndex + delta) % n) + n) % n);
  };
  const dialBack = () => {
    if (dialSettle.current) clearTimeout(dialSettle.current);
    if (dial.from === "library") {
      setSection("radio");
      open("library");
    } else open("now");
  };
  const dialToList = () => {
    if (dialSettle.current) clearTimeout(dialSettle.current);
    selectTab("radio");
    open("library");
  };

  // ---- footer ----
  const keyAction = (k: LibKey, item: LibItem | null, onBack: () => void): DeviceAction | null => {
    switch (k) {
      case "back":
        return { label: t("amp.back"), icon: ArrowLeft, onClick: onBack };
      case "playNext":
        return {
          label: t("lib.playNext"),
          icon: ListPlus,
          disabled: !item,
          onClick: () => item && void play({ uri: item.uri }, "next", item.name),
        };
      case "addQueue":
        return {
          label: t("lib.addQueue"),
          icon: ListEnd,
          disabled: !item,
          onClick: () => item && void play({ uri: item.uri }, "add", item.name),
        };
      case "favourite": {
        const fav = !!item && isFavourite(item, favs);
        return {
          label: t(fav ? "lib.unfav" : "lib.fav"),
          icon: Heart,
          pressed: fav,
          disabled: !item,
          onClick: () => item && void toggleFavourite(item),
        };
      }
      case "open":
        return {
          label: t("lib.open"),
          icon: FolderOpen,
          disabled: !item?.opens,
          onClick: () => item && openItem(item),
        };
      case "dial":
        return { label: t("lib.dial"), icon: Gauge, onClick: () => openMaDial("library") };
      case "list":
        return { label: t("lib.list"), icon: ListMusic, onClick: dialToList };
      case "band":
        return {
          label: t(dial.band === "favourites" ? "madial.band.favourites" : "madial.band.all"),
          icon: Radio,
          onClick: () =>
            setDial((d) => ({
              ...d,
              band: d.band === "favourites" ? "all" : "favourites",
              index: 0,
            })),
        };
      case "backspace":
        return {
          label: t("search.backspace"),
          icon: Delete,
          disabled: search.query === "",
          onClick: backspace,
        };
      case "space":
        return {
          label: t("search.space"),
          icon: Space,
          disabled: search.query === "",
          onClick: () => typeChar(" "),
        };
      case "results":
        return {
          label: t("search.enter"),
          icon: CornerDownLeft,
          disabled: !searchRows.length,
          onClick: toResults,
        };
      default:
        return null;
    }
  };
  const actionsFor = (s: string | null): (DeviceAction | null)[] | null => {
    if (s === "library") {
      const row = highlightedRow();
      const item = row ? (row.kind === "playAll" ? row.parent : row.item) : null;
      return libraryKeys({
        tab: section,
        opened: !!opened,
        searchKeys: searchKeysFocus,
        opens: rowOpens(item, row?.kind === "playAll"),
      }).map((k) => keyAction(k, item, back));
    }
    if (s === "discover")
      return discoverKeys(discLevel).map((k) => (k ? keyAction(k, discItem, discBack) : null));
    if (s === "madial") return MA_DIAL_KEYS.map((k) => keyAction(k, dialStation, dialBack));
    return null;
  };

  // ---- keys ----
  const onKey = (s: string | null, event: KeyboardEvent): boolean => {
    const k = event.key;
    if (s === "library") {
      if (k === "Escape") {
        event.preventDefault();
        back();
        return true;
      }
      if (section === null) {
        if (k === "Enter") {
          const next = tabs[sectionsCursor];
          if (next) selectTab(next);
        } else if (k === "ArrowUp") moveSections(-1);
        else if (k === "ArrowDown") moveSections(1);
        else if (k === "PageUp") moveSections(-sectionsPageSize);
        else if (k === "PageDown") moveSections(sectionsPageSize);
        else if (!NAV.includes(k)) return false;
        event.preventDefault();
        return true;
      }
      if (searchKeysFocus) {
        if (k === "Enter") {
          const ch = SEARCH_KEYS[search.key];
          if (ch) typeChar(ch);
        } else if (k === "ArrowLeft") setSearchKey(search.key - 1);
        else if (k === "ArrowRight") setSearchKey(search.key + 1);
        else if (k === "ArrowUp") setSearchKey(search.key - SEARCH_KEY_COLS);
        else if (k === "ArrowDown") {
          if (search.key + SEARCH_KEY_COLS > SEARCH_KEYS.length - 1) toResults();
          else setSearchKey(search.key + SEARCH_KEY_COLS);
        } else if (k === "PageDown") toResults();
        else if (k !== "PageUp") return false;
        event.preventDefault();
        return true;
      }
      if (k === "Enter") enter();
      else if (k === "ArrowUp") moveCursor(-1);
      else if (k === "ArrowDown") moveCursor(1);
      else if (k === "PageUp") moveCursor(-LIBRARY_PAGE_SIZE);
      else if (k === "PageDown") moveCursor(LIBRARY_PAGE_SIZE);
      else if (!NAV.includes(k)) return false; // Left / Right: no section cycling (2026-10-23)
      event.preventDefault();
      return true;
    }
    if (s === "discover") {
      if (k === "Escape") discBack();
      else if (k === "Enter") {
        if (discLevel === "categories") openDiscCategory();
        else if (discItem) void play({ uri: discItem.uri }, "replace", discItem.name);
      } else if (k === "ArrowUp") moveDisc(-1);
      else if (k === "ArrowDown") moveDisc(1);
      else if (k === "PageUp") moveDisc(-discPageSize);
      else if (k === "PageDown") moveDisc(discPageSize);
      else return false;
      event.preventDefault();
      return true;
    }
    if (s === "madial") {
      if (k === "Escape") dialBack();
      else if (k === "Enter") tuneDial(dialIndex, true);
      else if (k === "ArrowLeft" || k === "ArrowRight") stepDial(k === "ArrowRight" ? 1 : -1);
      else if (k === "ArrowUp" || k === "ArrowDown") {
        if (data?.amp.on) void act({ type: "amp.volume.step", delta: k === "ArrowUp" ? 1 : -1 });
      } else if (k === "PageUp" || k === "PageDown") return false;
      else return false;
      event.preventDefault();
      return true;
    }
    return false;
  };

  return {
    view,
    tab,
    section,
    sections: tabs,
    sectionsCursor,
    sectionsPage,
    sectionsPages,
    sectionsPageSize,
    opened,
    stack,
    cursor,
    page,
    listPages,
    listTotal,
    listRows,
    list,
    listLoading: listQuery.isPending && listMode,
    listError: listQuery.isError
      ? t("err.server")
      : list && !list.ok
        ? (list.error ?? t("err.failed"))
        : null,
    search,
    searchRows,
    searchCursor,
    searchActive,
    searchLoading: searchActive && (searchQuery.isFetching || term === ""),
    searchError: searchQuery.data && !searchQuery.data.ok ? (searchQuery.data.error ?? null) : null,
    typeChar,
    setSearchKey,
    selectTab,
    favs,
    // Discover
    homeRows,
    homeLoading: homeQuery.isPending && screen === "discover",
    homeError: homeQuery.isError
      ? t("err.server")
      : homeQuery.data && !homeQuery.data.ok
        ? (homeQuery.data.error ?? null)
        : null,
    discLevel,
    discRowIndex,
    discRow,
    discCursor,
    discPage,
    discPages,
    discPageSize,
    // MA dial
    dial,
    dialItems,
    dialIndex,
    dialStation,
    dialLoading:
      screen === "madial" && (dial.band === "favourites" ? dialFav.isPending : dialAll.isPending),
    playingStation,
    // wiring
    openLibrary,
    openDiscover,
    openMaDial,
    actionsFor,
    onKey,
    refreshKey: `${section ?? "sections"}|${sectionsPage}|${opened?.uri ?? ""}|${page}|${discLevel}|${discRowIndex}|${discPage}|${dial.band}`,
  };
}
export type LibraryPanel = ReturnType<typeof useLibrary>;
