// Bus task 027: the library's section model, the key maps and the config flags (2026-10-23: sections as a plain list).
// Bus task 029: Discover's rows option, F4 Open on a container, play now leaves the library (play next / add do not).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVER_ROWS,
  LIBRARY_TABS,
  discoverKeys,
  discoverPageSize,
  leavesLibrary,
  libraryKeys,
  librarySectionsPageSize,
  libraryTopTabs,
  libraryViewFrom,
  addRecentSearch,
  matchRecentSearches,
  orderSearchItems,
  searchPageOf,
  searchPageStart,
  searchPages,
  maStations,
  musicScreenKeys,
  pageWindow,
  playNowTarget,
  playingStationIndex,
  rowOpens,
  topTabOnArrow,
} from "./library";
import type { LibItem } from "./library";

const item = (uri: string, mediaType: LibItem["mediaType"], name = uri): LibItem => ({
  uri,
  mediaType,
  name,
  sub: null,
  favorite: false,
  opens: ["artist", "album", "playlist", "podcast", "genre"].includes(mediaType),
  art: null,
  inLibrary: true,
  durationS: null,
  albumUri: null,
});
const TODAY = LIBRARY_TABS.filter((t) => t !== "audiobooks"); // no audiobook provider

describe("library sections list (2026-10-23)", () => {
  it("all of today's sections fit one page; more paginate at Discover's category size", () => {
    expect(TODAY.length).toBe(8);
    expect(librarySectionsPageSize(TODAY.length)).toBe(8);
    expect(librarySectionsPageSize(LIBRARY_TABS.length)).toBe(discoverPageSize("categories"));
  });
});

describe("library config flags (kindle_panel get_config library)", () => {
  it("keeps the owner's order, falls back to the first tab, Discover on by default", () => {
    expect(libraryViewFrom({ tabs: ["search", "albums"], tab: "radio" })).toEqual({
      tabs: ["albums", "search"],
      tab: "albums",
      discoverKey: true,
      discoverRows: DEFAULT_DISCOVER_ROWS,
    });
    expect(libraryViewFrom({ tabs: TODAY, tab: "genres", discover_key: false })).toMatchObject({
      tab: "genres",
      discoverKey: false,
    });
    expect(libraryViewFrom(undefined).tab).toBe("playlists");
  });
  it("Discover's rows: the panel's choice in the fixed order; default without podcasts / audiobooks", () => {
    expect(DEFAULT_DISCOVER_ROWS).toEqual([
      "recently_played",
      "favorite_playlists",
      "favorite_albums",
      "favorite_artists",
      "favorite_radio",
      "recommendations",
      "recently_added_albums",
      "random_albums",
    ]);
    expect(
      libraryViewFrom({ discover_rows: ["podcasts", "random_albums", "nope"] }).discoverRows,
    ).toEqual(["random_albums", "podcasts"]);
    expect(libraryViewFrom({}).discoverRows).toEqual(DEFAULT_DISCOVER_ROWS);
  });
});

describe("library rows and play targets", () => {
  it("the Play all row shifts the server window of page 0 only", () => {
    expect(pageWindow(0, 8, 1)).toEqual({ offset: 0, limit: 7 });
    expect(pageWindow(1, 8, 1)).toEqual({ offset: 7, limit: 8 });
    expect(pageWindow(2, 8, 0)).toEqual({ offset: 16, limit: 8 });
  });
  it("a track opened in an album plays the album from that track; elsewhere the item itself", () => {
    const album = item("library://album/1", "album");
    const track = item("library://track/9", "track");
    expect(playNowTarget(track, album)).toEqual({ uri: album.uri, startItem: track.uri });
    expect(playNowTarget(track, null)).toEqual({ uri: track.uri });
    expect(playNowTarget(item("library://radio/2", "radio"), null)).toEqual({
      uri: "library://radio/2",
    });
  });
});

describe("key maps", () => {
  it("F4 = Open on a container row (not on Play all), the heart on a leaf; Discover the same", () => {
    const album = item("library://album/1", "album");
    const track = item("library://track/9", "track");
    expect(rowOpens(album)).toBe(true);
    expect(rowOpens(album, true)).toBe(false); // the Play all row: the parent's heart
    expect(rowOpens(track)).toBe(false);
    expect(rowOpens(null)).toBe(false);
    const opens = { tab: "albums" as const, opened: false, searchKeys: false };
    expect(libraryKeys({ ...opens, opens: true })).toEqual([
      "back",
      "playNext",
      "addQueue",
      "open",
    ]);
    expect(libraryKeys({ ...opens, opened: true, opens: false })[3]).toBe("favourite");
    expect(libraryKeys({ ...opens, tab: "search", opens: true })[3]).toBe("open"); // results
    // Discover (plain two-level list): categories have Back only, items Back + the heart
    expect(discoverKeys("categories")).toEqual(["back", null, null, null]);
    expect(discoverKeys("items")).toEqual(["back", null, null, "favourite"]);
  });
  it("the Library's two tabs: the panel option decides, Left / Right follow the strip as the eye sees it", () => {
    expect(libraryTopTabs({ discoverKey: true })).toEqual(["library", "discover"]);
    expect(libraryTopTabs({ discoverKey: false })).toEqual([]);
    const tabs = libraryTopTabs({ discoverKey: true });
    // Hebrew: the first tab sits on the right, so Left goes on to Discover and Right comes back
    expect(topTabOnArrow(tabs, "library", "ArrowLeft", true)).toBe("discover");
    expect(topTabOnArrow(tabs, "library", "ArrowRight", true)).toBeNull();
    expect(topTabOnArrow(tabs, "discover", "ArrowRight", true)).toBe("library");
    expect(topTabOnArrow(tabs, "discover", "ArrowLeft", true)).toBeNull();
    // English: mirrored
    expect(topTabOnArrow(tabs, "library", "ArrowRight", false)).toBe("discover");
    expect(topTabOnArrow(tabs, "library", "ArrowLeft", false)).toBeNull();
    expect(topTabOnArrow(tabs, "discover", "ArrowLeft", false)).toBe("library");
    expect(topTabOnArrow(tabs, "discover", "ArrowRight", false)).toBeNull();
    // no strip: no tab to go to
    expect(topTabOnArrow([], "library", "ArrowLeft", true)).toBeNull();
    expect(topTabOnArrow([], "library", "ArrowRight", false)).toBeNull();
  });
  it("only play now leaves the library for the music screen", () => {
    expect(leavesLibrary("replace")).toBe(true);
    expect(leavesLibrary("next")).toBe(false);
    expect(leavesLibrary("add")).toBe(false);
  });
  it("library footer by context", () => {
    expect(libraryKeys({ tab: "albums", opened: false, searchKeys: false })).toEqual([
      "back",
      "playNext",
      "addQueue",
      "favourite",
    ]);
    expect(libraryKeys({ tab: "radio", opened: false, searchKeys: false })).toEqual([
      "back",
      "dial",
      "addQueue",
      "favourite",
    ]);
    expect(libraryKeys({ tab: "search", opened: false, searchKeys: true })).toEqual([
      "back",
      "backspace",
      "space",
      "results",
    ]);
    // the sections list: Back only, like Discover's categories (2026-11-22: Discover is a tab, F4 is empty again)
    expect(libraryKeys({ tab: null, opened: false, searchKeys: false })).toEqual([
      "back",
      null,
      null,
      null,
    ]);
    expect(libraryKeys({ tab: null, opened: false, searchKeys: false })).toEqual(
      discoverKeys("categories"),
    );
    // search, the highlight on a recent search: Back only (Enter runs it)
    expect(libraryKeys({ tab: "search", opened: false, searchKeys: false, recent: true })).toEqual([
      "back",
      null,
      null,
      null,
    ]);
    expect(libraryKeys({ tab: "search", opened: false, searchKeys: true, recent: true })[3]).toBe(
      "results",
    );
    // search results and an opened container keep the list keys
    expect(libraryKeys({ tab: "search", opened: false, searchKeys: false })).toEqual([
      "back",
      "playNext",
      "addQueue",
      "favourite",
    ]);
    expect(libraryKeys({ tab: "radio", opened: true, searchKeys: false, opens: true })).toEqual([
      "back",
      "playNext",
      "addQueue",
      "open",
    ]);
  });
  it("music screen: Search on F4, Radio on F1 only while an MA radio plays without a queue", () => {
    expect(musicScreenKeys({ queue: false, maRadio: false })).toEqual([
      null,
      "library",
      "player",
      "search",
    ]);
    expect(musicScreenKeys({ queue: true, maRadio: true })[0]).toBe("queue");
    expect(musicScreenKeys({ queue: false, maRadio: true })).toEqual([
      "radio",
      "library",
      "player",
      "search",
    ]);
  });
});

// 2026-11-22: Music Assistant's search listed the way its web app lists it (the owner searched a song and got the
// artist on top, the song on the third screen).
describe("search results order", () => {
  type Raw = { type: LibItem["mediaType"]; name: string; artist?: string | null };
  const raw = (type: Raw["type"], name: string, artist: string | null = null): Raw => ({
    type,
    name,
    artist,
  });
  const get = (r: Raw) => r;
  // Music Assistant's answer for the song as kindle_panel hands it over when asked in the old order
  const ANSWER: Raw[] = [
    raw("artist", "Arik Einstein"),
    raw("artist", "Miki Gavrielov"),
    raw("album", "על גבול האור", "Arik Einstein, Miki Gavrielov"),
    raw("album", "אוסף", "Arik Einstein"),
    raw("track", "עוף גוזל", "Arik Einstein"),
    raw("track", "עוף גוזל", "Sarit Hadad"),
    raw("track", "עוף גוזל", "Arik Einstein, Miki Gavrielov"),
    raw("track", "עוף מוזר", "פאר טסי"),
    raw("playlist", "מסיבת סיום"),
    raw("playlist", "מסיבת סיום"),
    raw("podcast", "עוף גוזל"),
  ];
  it("the typed song first, then tracks, artists, albums, playlists; duplicates dropped as the web app drops them", () => {
    const { items, top } = orderSearchItems(ANSWER, " עוף  גוזל ", get);
    expect(top).toBe(2);
    expect(items.map((i) => `${i.type}:${i.name}:${i.artist ?? ""}`)).toEqual([
      // top results: the first exact match of each type, songs first
      "track:עוף גוזל:Arik Einstein",
      "podcast:עוף גוזל:",
      // tracks: the other exact match first; the same song by the same first artist is listed once
      "track:עוף גוזל:Sarit Hadad",
      "track:עוף מוזר:פאר טסי",
      "artist:Arik Einstein:",
      "artist:Miki Gavrielov:",
      "album:על גבול האור:Arik Einstein, Miki Gavrielov",
      "album:אוסף:Arik Einstein",
      // playlists are never merged
      "playlist:מסיבת סיום:",
      "playlist:מסיבת סיום:",
    ]);
  });
  it("an artist typed in full is the first row; the match ignores case; no exact match = no top group", () => {
    const answer = [
      raw("track", "Bohemian Rhapsody", "Queen"),
      raw("track", "Killer Queen", "Queen"),
      raw("artist", "Queen"),
      raw("album", "Queen", "Queen"),
      raw("album", "Queen II", "Queen"),
      raw("radio", "Queen Radio"),
    ];
    const hit = orderSearchItems(answer, "queen", get);
    expect(hit.top).toBe(2);
    expect(hit.items.slice(0, 3).map((i) => `${i.type}:${i.name}`)).toEqual([
      "artist:Queen",
      "album:Queen",
      "track:Bohemian Rhapsody",
    ]);
    const typing = orderSearchItems(answer, "que", get);
    expect(typing.top).toBe(0);
    expect(typing.items.map((i) => i.type)).toEqual([
      "track",
      "track",
      "artist",
      "album",
      "album",
      "radio",
    ]);
  });
  it("pages by height: a heading per group, repeated when a group runs over, never a heading at the foot", () => {
    const items = [
      item("t://track/0", "track", "exact"),
      ...[1, 2, 3, 4, 5].map((i) => item(`t://track/${i}`, "track", `t${i}`)),
      ...[1, 2, 3].map((i) => item(`t://artist/${i}`, "artist", `a${i}`)),
      item("t://album/1", "album", "al1"),
    ];
    const pages = searchPages(items, 1);
    const shape = (p: (typeof pages)[number]) =>
      p.map((e) => (e.kind === "heading" ? `[${e.group}]` : e.item.name));
    // 462 px: top heading + 1 row, tracks heading + 5 rows = 2 * 32 + 6 * 54 + 5 * 6 = 418; the artists heading and a
    // row (92 more) do not fit, so the group starts the next page
    expect(pages.map(shape)).toEqual([
      ["[top]", "exact", "[track]", "t1", "t2", "t3", "t4", "t5"],
      ["[artist]", "a1", "a2", "a3", "[album]", "al1"],
    ]);
    for (const p of pages) {
      const height =
        p.reduce((h, e) => h + (e.kind === "heading" ? 26 : 54), 0) + (p.length - 1) * 6;
      expect(height).toBeLessThanOrEqual(462);
      expect(p[p.length - 1]!.kind).toBe("item");
    }
    expect(searchPageOf(pages, 0)).toBe(0);
    expect(searchPageOf(pages, 6)).toBe(1);
    expect(searchPageStart(pages, 1)).toBe(6);
    // one long group: its heading again on the second page
    const long = searchPages(
      Array.from({ length: 9 }, (_, i) => item(`t://track/${i}`, "track", `t${i}`)),
      0,
    );
    expect(long.map((p) => p[0]!.kind === "heading" && p[0]!.group)).toEqual(["track", "track"]);
    expect(long.map((p) => p.length - 1)).toEqual([7, 2]);
    expect(searchPages([], 0)).toEqual([]);
  });
  it("recent searches: newest first, one entry per search whatever its case, capped; offered by what is typed", () => {
    let list: string[] = [];
    for (const q of ["Queen", "עוף גוזל", "queen ", "a", ""]) list = addRecentSearch(list, q);
    expect(list).toEqual(["a", "queen", "עוף גוזל"]);
    expect(addRecentSearch(["1", "2", "3"], "4", 3)).toEqual(["4", "1", "2"]);
    expect(matchRecentSearches(list, "")).toEqual(list);
    expect(matchRecentSearches(list, "Q")).toEqual(["queen"]);
    expect(matchRecentSearches(list, "ג")).toEqual(["עוף גוזל"]);
  });
});

describe("MA radio dial data", () => {
  it("maps MA radios to dial stations and finds the playing one by name", () => {
    const radios = [
      item("library://radio/1", "radio", "WDR 5"),
      item("library://radio/2", "radio", "100FM Israeli"),
    ];
    expect(maStations(radios).map((s) => s.id)).toEqual(["library://radio/1", "library://radio/2"]);
    expect(playingStationIndex(radios, "100fm israeli")).toBe(1);
    expect(playingStationIndex(radios, null)).toBe(-1);
  });
});

describe("libItemFrom (kindle_panel item → row)", () => {
  it("drops the provider name as a subtitle but keeps a real one", async () => {
    const { libItemFrom } = await import("./library-ha.server");
    const base = { uri: "library://playlist/1", media_type: "playlist" as const, name: "80s" };
    expect(libItemFrom({ ...base, sub: "Music Assistant" }).sub).toBeNull();
    expect(libItemFrom({ ...base, sub: "Spotify", provider: "Spotify" }).sub).toBeNull();
    expect(libItemFrom({ ...base, sub: "12 tracks" }).sub).toBe("12 tracks");
    expect(libItemFrom({ ...base, sub: "  " }).sub).toBeNull();
  });

  it("Discover pages: 7 category rows, 8 item rows", () => {
    expect(discoverPageSize("categories")).toBe(7);
    expect(discoverPageSize("items")).toBe(8);
  });
});

describe("library uri validator", () => {
  it("accepts a podcast episode uri with a space and ordinary uris", async () => {
    const { LIB_URI_RE } = await import("./library.functions");
    const episode =
      "itunes_podcasts://podcast_episode/https://anchor.fm/s/96515a90/podcast/rss ac5df1da-83c8-4e5a-b900-642ab3aa1dab";
    expect(LIB_URI_RE.test(episode)).toBe(true);
    expect(LIB_URI_RE.test("library://podcast/1")).toBe(true);
    expect(LIB_URI_RE.test("spotify://track/4uLU6hMCjMI75M1A2tKUQC")).toBe(true);
  });

  it("rejects control characters, newlines, edge spaces, empty and oversize ids", async () => {
    const { LIB_URI_RE } = await import("./library.functions");
    for (const bad of [
      "library://podcast/a\nb",
      "library://podcast/a\tb",
      "library://podcast/a\u0000b",
      "library://podcast/a b",
      "library://podcast/ a",
      "library://podcast/a ",
      "library://podcast/",
      "library://podcast/" + "a".repeat(401),
      "no-scheme",
    ])
      expect(LIB_URI_RE.test(bad), JSON.stringify(bad)).toBe(false);
    expect(LIB_URI_RE.test("library://podcast/" + "a b".repeat(133) + "c")).toBe(true);
  });
});
