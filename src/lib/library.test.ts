// Bus task 027: the library's section model, the tab strip (four + More), the key maps and the config flags.
// Bus task 029: Discover's rows option, F4 Open on a container, play now leaves the library (play next / add do not).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVER_ROWS,
  LIBRARY_TABS,
  discoverKeys,
  discoverPageSize,
  leavesLibrary,
  libraryKeys,
  libraryViewFrom,
  maStations,
  musicScreenKeys,
  pageWindow,
  playNowTarget,
  playingStationIndex,
  rowOpens,
  stepStrip,
  stripSlotsOf,
  tabStrip,
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

describe("library tab strip (addendum 3)", () => {
  it("shows Playlists, Radio, Genres, Albums + More with the rest in the owner's order", () => {
    const s = tabStrip(TODAY, "playlists");
    expect(s.visible).toEqual(["playlists", "radio", "genres", "albums"]);
    expect(s.more).toEqual(["artists", "tracks", "podcasts", "search"]);
    expect(stripSlotsOf(s)).toEqual(["playlists", "radio", "genres", "albums", "more"]);
  });
  it("a tab chosen from More takes the fourth slot; the displaced tab goes into More", () => {
    const s = tabStrip(TODAY, "tracks");
    expect(s.visible).toEqual(["playlists", "radio", "genres", "tracks"]);
    expect(s.more).toEqual(["albums", "artists", "podcasts", "search"]);
  });
  it("five tabs or fewer: no More; three slots when four do not fit", () => {
    expect(tabStrip(["playlists", "radio", "albums", "search"], "radio").more).toEqual([]);
    expect(tabStrip(TODAY, "playlists", 3).visible).toEqual(["playlists", "radio", "genres"]);
  });
  it("Right / Left cycle through the visible tabs and More, wrapping", () => {
    const slots = stripSlotsOf(tabStrip(TODAY, "albums"));
    expect(stepStrip(slots, "albums", 1)).toBe("more");
    expect(stepStrip(slots, "playlists", -1)).toBe("more");
    expect(stepStrip(slots, "radio", 1)).toBe("genres");
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
    const opens = { tab: "albums" as const, opened: false, more: false, searchKeys: false };
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
  it("only play now leaves the library for the music screen", () => {
    expect(leavesLibrary("replace")).toBe(true);
    expect(leavesLibrary("next")).toBe(false);
    expect(leavesLibrary("add")).toBe(false);
  });
  it("library footer by context", () => {
    expect(libraryKeys({ tab: "albums", opened: false, more: false, searchKeys: false })).toEqual([
      "back",
      "playNext",
      "addQueue",
      "favourite",
    ]);
    expect(libraryKeys({ tab: "radio", opened: false, more: false, searchKeys: false })).toEqual([
      "back",
      "dial",
      "addQueue",
      "favourite",
    ]);
    expect(libraryKeys({ tab: "search", opened: false, more: false, searchKeys: true })).toEqual([
      "back",
      "backspace",
      "space",
      "results",
    ]);
    expect(libraryKeys({ tab: "albums", opened: false, more: true, searchKeys: false })).toEqual([
      "back",
      null,
      null,
      "choose",
    ]);
  });
  it("music screen: Discover on the free key, Radio on F1 only while an MA radio plays without a queue", () => {
    expect(musicScreenKeys({ queue: false, maRadio: false, discover: true })).toEqual([
      null,
      "library",
      "player",
      "discover",
    ]);
    expect(musicScreenKeys({ queue: true, maRadio: true, discover: true })[0]).toBe("queue");
    expect(musicScreenKeys({ queue: false, maRadio: true, discover: false })).toEqual([
      "radio",
      "library",
      "player",
      null,
    ]);
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
