// Bus task 027: the Music Assistant client screens on the panel (Library = sections list -> a section, Discover, MA dial).
// Bus task 029: Enter plays now everywhere and returns to the music screen; F4 Open browses a container; Discover's rows
// come from the panel option and its footer is the list screens' one.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { demoMediaSnapshot } from "@/lib/media";
import type { MediaSnapshotResult } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import type { LibItem } from "@/lib/library";

const mocks = vi.hoisted(() => ({
  getMediaSnapshot: vi.fn(),
  runMediaAction: vi.fn(),
  startAmpPowerOn: vi.fn(),
  getPowerOnStatus: vi.fn(),
  getRadioLists: vi.fn(),
  tuneRadioStation: vi.fn(),
  getMusicLists: vi.fn(),
  playMusic: vi.fn(),
}));
const lib = vi.hoisted(() => ({
  getLibraryHome: vi.fn(),
  getLibraryList: vi.fn(),
  searchLibraryItems: vi.fn(),
  getSearchRecents: vi.fn(),
  rememberSearch: vi.fn(),
  playLibrary: vi.fn(),
  favouriteLibrary: vi.fn(),
}));
vi.mock("@/lib/media.functions", () => mocks);
vi.mock("@/lib/library.functions", () => lib);

const it_ = (
  uri: string,
  mediaType: LibItem["mediaType"],
  name: string,
  extra: Partial<LibItem> = {},
): LibItem => ({
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
  ...extra,
});

/** Music through HA on R-N500 AirPlay, nothing queued; `radio`: an MA radio plays; `discoverKey`: the panel option
 *  that gives the Library its Discover tab. */
const haResult = (radio = false, discoverKey = true): MediaSnapshotResult => {
  const s = demoMediaSnapshot();
  s.amp.source = "SERVER";
  s.nowPlaying = radio
    ? { ...s.nowPlaying, kind: "radio", station: "100FM Israeli", stationId: "ma:100fm-israeli" }
    : { ...s.nowPlaying, kind: "music", station: null };
  s.queue = null;
  s.output = {
    entity: "media_player.ma_amp_airplay",
    name: "R-N500 AirPlay",
    valid: true,
    outputs: [
      { entity_id: "media_player.ma_amp_airplay", name: "R-N500 AirPlay", state: "playing" },
    ],
    keys: ["none", "none", "none", "none"],
    library: {
      tabs: ["playlists", "radio", "genres", "albums", "artists", "tracks", "podcasts", "search"],
      tab: "playlists",
      discoverKey,
      discoverRows: ["recently_played", "favorite_radio", "recommendations"],
    },
  };
  return { configured: true, amp: true, jellyfin: false, snapshot: s, lang: "en" };
};

function Harness({ lang }: { lang: "he" | "en" }) {
  const panel = useMediaPanel({ active: true, lang, notify: () => {} });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const footer = panel.screen ? panel.modalActions : panel.actions;
      if (pressSoftKey(footer, event.key)) return;
      if (panel.screen) panel.onKey(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return (
    <LangContext.Provider value={lang}>
      <div className="kindle-screen">
        <main className="content">
          <MediaCards panel={panel} />
        </main>
        <DeviceActions actions={panel.actions} />
        <MediaModal panel={panel} status="" />
      </div>
    </LangContext.Provider>
  );
}
const renderPanel = (lang: "he" | "en" = "en") => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness lang={lang} />
    </QueryClientProvider>,
  );
};
const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const keysOf = (el: Element) =>
  Array.from(el.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
const sectionsOf = (el: Element) =>
  Array.from(el.querySelectorAll(".lib-sections [role=option]")).map((b) => b.textContent);
const selectedSection = (el: Element) =>
  el.querySelector('.lib-sections [aria-selected="true"]')?.textContent;
/** The tab strip above the two top-level lists: the tabs' names in DOM order and the open one. */
const topTabsOf = (el: Element) =>
  Array.from(el.querySelectorAll(".lib-top-tabs [role=tab]")).map((b) => b.textContent);
const openTopTab = (el: Element) =>
  el.querySelector('.lib-top-tabs [role=tab][aria-selected="true"]')?.textContent;

const ALBUM = it_("library://album/1", "album", "Sheer Heart Attack", { sub: "Queen · 1974" });
const TRACKS = [1, 2, 3].map((i) =>
  it_(`library://track/${i}`, "track", `Track ${i}`, { albumUri: ALBUM.uri }),
);
const RADIOS = [
  it_("library://radio/1", "radio", "WDR 5", { favorite: true }),
  it_("library://radio/2", "radio", "100FM Israeli", { favorite: true }),
];

async function openMusic(radio = false, lang: "he" | "en" = "en", discoverKey = true) {
  mocks.getMediaSnapshot.mockResolvedValue(haResult(radio, discoverKey));
  renderPanel(lang);
  const title = lang === "en" ? "Open music" : "פתח מוזיקה";
  await waitFor(() => expect(screen.getByTitle(title).textContent).toContain("R-N500 AirPlay"));
  press("F1");
}

describe("the Music Assistant library (bus task 027)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    lib.getLibraryList.mockImplementation(
      ({ data }: { data: { section?: string; parent?: string; favorite?: boolean } }) =>
        Promise.resolve(
          data.parent
            ? { ok: true, total: 3, offset: 0, favorites: 0, parent: ALBUM, items: TRACKS }
            : data.section === "radio"
              ? { ok: true, total: 2, offset: 0, favorites: 2, parent: null, items: RADIOS }
              : { ok: true, total: 1, offset: 0, favorites: 0, parent: null, items: [ALBUM] },
        ),
    );
    lib.playLibrary.mockResolvedValue({ ok: true, status: "playing" });
    lib.favouriteLibrary.mockResolvedValue({ ok: true });
    lib.getSearchRecents.mockResolvedValue({ items: [] });
    lib.rememberSearch.mockImplementation(({ data }: { data: { query: string } }) =>
      Promise.resolve({ items: [data.query] }),
    );
    lib.getLibraryHome.mockResolvedValue({
      ok: true,
      rows: [
        { id: "recently_played", name: "Recently played", items: [ALBUM] },
        { id: "favorite_radio", name: "Favorite Radio stations", items: RADIOS },
      ],
    });
  });

  it("F2 opens the sections list; Enter opens Playlists; a container row has Open, its Play all row the heart", async () => {
    await openMusic();
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(keysOf(now)).toEqual(["\u00a0", "Library", "Player", "Search"]);
    press("F2");
    let sections = screen.getByRole("dialog", { name: "Library" });
    // every section in the owner's order, no heading, no page text on one page; the two tabs above it, the Library
    // tab open; Back only (2026-11-22: Discover is the second tab, no longer F4)
    expect(sectionsOf(sections)).toEqual([
      "Playlists",
      "Radio",
      "Genres",
      "Albums",
      "Artists",
      "Tracks",
      "Podcasts",
      "Search",
    ]);
    expect(topTabsOf(sections)).toEqual(["Library", "Discover"]);
    expect(openTopTab(sections)).toBe("Library");
    expect(sections.querySelector("h1")).toBeNull();
    expect(sections.querySelector(".music-page")).toBeNull();
    expect(selectedSection(sections)).toBe("Playlists");
    expect(keysOf(sections)).toEqual(["Back", "\u00a0", "\u00a0", "\u00a0"]);
    expect(lib.getLibraryList).not.toHaveBeenCalled();
    expect(lib.getLibraryHome).not.toHaveBeenCalled();
    // English: the Library tab is the left one, so Left has no tab to go to
    press("ArrowLeft");
    sections = screen.getByRole("dialog", { name: "Library" });
    expect(selectedSection(sections)).toBe("Playlists");
    press("Enter");
    const libDlg = screen.getByRole("dialog", { name: "Library" });
    expect(libDlg.querySelector("h1")?.textContent).toBe("Playlists");
    await waitFor(() => expect(libDlg.textContent).toContain("Sheer Heart Attack"));
    expect(libDlg.querySelector(".lib-section-heading p")?.textContent).toBe("1 items");
    expect(lib.getLibraryList).toHaveBeenCalledWith({
      data: { section: "playlists", offset: 0, limit: 8 },
    });
    // the standard footer: the page on the left, no key-hint line (the user dropped all guidance text)
    expect(libDlg.querySelector(".music-page")?.textContent).toBe("1/1");
    expect(libDlg.textContent).not.toContain("Enter play");
    expect(libDlg.textContent).not.toMatch(/[◀▶]/);
    expect(keysOf(libDlg)).toEqual(["Back", "Play next", "Add to queue", "Open"]);
    // play next stays in the library (the owner may queue several)
    press("F2");
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({ data: { uri: ALBUM.uri, option: "next" } }),
    );
    expect(screen.getByRole("dialog", { name: "Library" })).toBeVisible();
    press("F4"); // Open
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Play all"),
    );
    expect(lib.getLibraryList).toHaveBeenLastCalledWith({
      data: { parent: ALBUM.uri, offset: 0, limit: 7 },
    });
    expect(keysOf(screen.getByRole("dialog", { name: "Library" }))).toEqual([
      "Back",
      "Play next",
      "Add to queue",
      "Favourite",
    ]);
    press("F4"); // the heart of the album, on its Play all row
    await waitFor(() =>
      expect(lib.favouriteLibrary).toHaveBeenCalledWith({
        data: { uri: ALBUM.uri, favorite: true },
      }),
    );
    await waitFor(() =>
      expect(keysOf(screen.getByRole("dialog", { name: "Library" }))[3]).toBe("Unfavourite"),
    );
    press("ArrowDown"); // Track 1: a leaf keeps the heart
    expect(keysOf(screen.getByRole("dialog", { name: "Library" }))[3]).toBe("Favourite");
    press("Escape"); // back to the list, the album row again
    expect(keysOf(screen.getByRole("dialog", { name: "Library" }))[3]).toBe("Open");
    press("F1"); // the section's top: back to the sections list
    expect(selectedSection(screen.getByRole("dialog", { name: "Library" }))).toBe("Playlists");
    press("F1"); // the sections list: closes the Library
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("Down + Enter opens Radio (the Dial key); Back lands on Radio in the list; reopening starts on the list", async () => {
    await openMusic();
    press("F2");
    press("ArrowDown");
    expect(selectedSection(screen.getByRole("dialog", { name: "Library" }))).toBe("Radio");
    press("Enter");
    let dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector("h1")?.textContent).toBe("Radio");
    await waitFor(() =>
      expect(keysOf(screen.getByRole("dialog", { name: "Library" }))).toEqual([
        "Back",
        "Dial",
        "Add to queue",
        "Unfavourite",
      ]),
    );
    expect(lib.getLibraryList).toHaveBeenCalledWith({
      data: { section: "radio", offset: 0, limit: 8 },
    });
    press("ArrowRight"); // no section cycling
    expect(screen.getByRole("dialog", { name: "Library" }).querySelector("h1")?.textContent).toBe(
      "Radio",
    );
    const calls = lib.getLibraryList.mock.calls.length;
    press("F1");
    dlg = screen.getByRole("dialog", { name: "Library" });
    expect(selectedSection(dlg)).toBe("Radio");
    // Back to the sections list fetches nothing
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(lib.getLibraryList.mock.calls.length).toBe(calls);
    press("ArrowDown");
    press("ArrowDown");
    press("F1"); // close
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    // reopened: the sections list, the cursor where it was left
    press("F2");
    dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector(".lib-sections")).not.toBeNull();
    expect(selectedSection(dlg)).toBe("Albums");
    // Search: the keyboard keys, the name only as heading
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector("h1")?.textContent).toBe("Search");
    expect(dlg.querySelector(".lib-section-heading p")).toBeNull();
    expect(keysOf(dlg)).toEqual(["Back", "Delete", "Space", "Enter"]);
  });

  it("lazy sections: nothing loads before Enter; another section shows the busy state, not the last one's rows", async () => {
    await openMusic();
    press("F2");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown"); // moving the cursor loads nothing
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(lib.getLibraryList).not.toHaveBeenCalled();
    press("ArrowUp");
    press("ArrowUp"); // Radio
    press("Enter");
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("WDR 5"),
    );
    expect(lib.getLibraryList).toHaveBeenCalledTimes(1);
    press("F1");
    // Genres: its list is still on the way
    let resolve: (v: unknown) => void = () => {};
    lib.getLibraryList.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    press("ArrowDown");
    press("Enter");
    const dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector("h1")?.textContent).toBe("Genres");
    expect(dlg.textContent).not.toContain("WDR 5");
    expect(dlg.textContent).toContain("Loading…");
    expect(dlg.querySelector(".lib-rows")?.getAttribute("aria-busy")).toBe("true");
    expect(lib.getLibraryList).toHaveBeenLastCalledWith({
      data: { section: "genres", offset: 0, limit: 8 },
    });
    await act(async () =>
      resolve({ ok: true, total: 1, offset: 0, favorites: 0, parent: null, items: [ALBUM] }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Sheer"),
    );
  });

  it("Enter plays a container at once and returns to the music screen", async () => {
    await openMusic();
    press("F2");
    press("Enter"); // Playlists
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Sheer"),
    );
    press("Enter");
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({
        data: { uri: ALBUM.uri, option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    expect(lib.getLibraryList).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ parent: ALBUM.uri }) }),
    );
  });

  it("an opened album: Enter on Play all plays it, a track plays the album from that track, both leave", async () => {
    await openMusic();
    press("F2");
    press("Enter"); // Playlists
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Sheer"),
    );
    press("F4"); // Open
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Track 2"),
    );
    press("ArrowDown");
    press("ArrowDown");
    press("Enter"); // Track 2
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({
        data: { uri: ALBUM.uri, startItem: "library://track/2", option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    // the library opens fresh (the sections list) next time
    press("F2");
    expect(screen.getByRole("dialog", { name: "Library" }).textContent).not.toContain("Play all");
    expect(
      screen.getByRole("dialog", { name: "Library" }).querySelector(".lib-sections"),
    ).not.toBeNull();
    press("Enter"); // Playlists
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Sheer"),
    );
    press("F4");
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Library" }).textContent).toContain("Play all"),
    );
    press("Enter"); // Play all
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenLastCalledWith({
        data: { uri: ALBUM.uri, option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("the Discover tab: a plain list of the categories, Enter opens one, Enter on an item plays now and leaves, Back climbs", async () => {
    await openMusic(false, "he");
    // 2026-11-22: Search took F4 on the music screen; Discover is the Library's second tab. Hebrew: the Library tab
    // sits on the right, so Left goes to Discover; F4 is empty
    press("F2");
    const sections = screen.getByRole("dialog", { name: "ספריה" });
    expect(keysOf(sections)).toEqual(["חזרה", "\u00a0", "\u00a0", "\u00a0"]);
    expect(topTabsOf(sections)).toEqual(["ספריה", "גילוי"]);
    expect(openTopTab(sections)).toBe("ספריה");
    press("F4");
    expect(screen.getByRole("dialog", { name: "ספריה" })).toBeVisible();
    press("ArrowRight"); // no tab on that side
    expect(screen.getByRole("dialog", { name: "ספריה" })).toBeVisible();
    press("ArrowLeft");
    let dlg = screen.getByRole("dialog", { name: "גילוי" });
    await waitFor(() => expect(dlg.textContent).toContain("הושמעו לאחרונה"));
    // the same strip, the Discover tab open, in place of the heading
    expect(topTabsOf(dlg)).toEqual(["ספריה", "גילוי"]);
    expect(openTopTab(dlg)).toBe("גילוי");
    expect(dlg.querySelector("h1")).toBeNull();
    expect(lib.getLibraryHome).toHaveBeenCalledWith({
      data: { sections: ["recently_played", "favorite_radio", "recommendations"] },
    });
    // the categories, one per row, with their counts; only Back in the footer
    expect(
      Array.from(dlg.querySelectorAll(".discover-category strong")).map((e) => e.textContent),
    ).toEqual(["הושמעו לאחרונה", "תחנות רדיו מועדפות"]);
    expect(dlg.querySelector(".discover-foot .music-page")?.textContent).toBe("1/1");
    expect(keysOf(dlg)).toEqual(["חזרה", "\u00a0", "\u00a0", "\u00a0"]);
    expect(dlg.textContent).not.toMatch(/[◀▶]/);
    // Enter on the radio category: its two stations, Back + the heart, no open / add / next
    press("ArrowDown");
    press("Enter");
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(dlg.querySelector("h1")?.textContent).toBe("תחנות רדיו מועדפות");
    expect(dlg.querySelectorAll(".lib-row").length).toBe(2);
    expect(dlg.querySelector(".discover-foot .music-page")?.textContent).toBe("1/1");
    expect(keysOf(dlg)).toEqual(["חזרה", "\u00a0", "\u00a0", "הסר ממועדפים"]);
    // inside a category: no strip, and Left / Right do not change the tab
    expect(topTabsOf(dlg)).toEqual([]);
    press("ArrowRight");
    press("ArrowLeft");
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(dlg.querySelector("h1")?.textContent).toBe("תחנות רדיו מועדפות");
    // Back: the Discover tab again, highlight kept on the radio category
    press("F1");
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(openTopTab(dlg)).toBe("גילוי");
    expect(dlg.querySelector('.discover-category[aria-selected="true"] strong')?.textContent).toBe(
      "תחנות רדיו מועדפות",
    );
    expect(dlg.querySelector(".discover-foot .music-page")?.textContent).toBe("1/1");
    // Right: back to the Library tab, its highlight where it was; Left: Discover again, its highlight kept too
    press("ArrowRight");
    const again = screen.getByRole("dialog", { name: "ספריה" });
    expect(openTopTab(again)).toBe("ספריה");
    expect(selectedSection(again)).toBe("פלייליסטים");
    press("ArrowLeft");
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(dlg.querySelector('.discover-category[aria-selected="true"] strong')?.textContent).toBe(
      "תחנות רדיו מועדפות",
    );
    // Back on the Discover tab: the music screen, as on the Library tab; F2 opens on the Library tab again
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F2");
    expect(openTopTab(screen.getByRole("dialog", { name: "ספריה" }))).toBe("ספריה");
    press("ArrowLeft");
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "גילוי" }).textContent).toContain(
        "תחנות רדיו מועדפות",
      ),
    );
    press("ArrowDown");
    press("Enter");
    press("ArrowDown");
    expect(
      screen.getByRole("dialog", { name: "גילוי" }).querySelector(".discover-foot .music-page")
        ?.textContent,
    ).toBe("1/1");
    press("Enter");
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({
        data: { uri: "library://radio/2", option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("English: Right goes to the Discover tab and Left comes back; Back from an opened section returns to the Library tab", async () => {
    await openMusic();
    press("F2");
    press("ArrowRight");
    const dlg = screen.getByRole("dialog", { name: "Discover" });
    await waitFor(() => expect(dlg.textContent).toContain("Recently played"));
    expect(topTabsOf(dlg)).toEqual(["Library", "Discover"]);
    expect(openTopTab(dlg)).toBe("Discover");
    press("ArrowRight"); // no tab on that side
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeVisible();
    press("ArrowLeft");
    let libDlg = screen.getByRole("dialog", { name: "Library" });
    expect(openTopTab(libDlg)).toBe("Library");
    // an opened section: no strip, Left / Right do nothing; Back returns to the Library tab
    press("Enter");
    libDlg = screen.getByRole("dialog", { name: "Library" });
    await waitFor(() => expect(libDlg.textContent).toContain("Sheer Heart Attack"));
    expect(topTabsOf(libDlg)).toEqual([]);
    press("ArrowRight");
    press("ArrowLeft");
    expect(screen.getByRole("dialog", { name: "Library" }).querySelector("h1")?.textContent).toBe(
      "Playlists",
    );
    press("F1");
    libDlg = screen.getByRole("dialog", { name: "Library" });
    expect(openTopTab(libDlg)).toBe("Library");
    expect(selectedSection(libDlg)).toBe("Playlists");
    // Back on the top level: the music screen
    press("F1");
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("panel option discover_key off: no tab strip, no Discover; Left / Right do nothing on the sections list", async () => {
    await openMusic(false, "he", false);
    press("F2");
    let sections = screen.getByRole("dialog", { name: "ספריה" });
    expect(sections.querySelector("[role=tab]")).toBeNull();
    expect(sections.querySelector(".lib-top-tabs")).toBeNull();
    expect(sectionsOf(sections)).toHaveLength(8);
    expect(keysOf(sections)).toEqual(["חזרה", "\u00a0", "\u00a0", "\u00a0"]);
    press("ArrowLeft");
    press("ArrowRight");
    press("F4");
    sections = screen.getByRole("dialog", { name: "ספריה" });
    expect(selectedSection(sections)).toBe("פלייליסטים");
    expect(screen.queryByRole("dialog", { name: "גילוי" })).toBeNull();
    expect(lib.getLibraryHome).not.toHaveBeenCalled();
  });

  it("an MA radio plays: F1 reads Radio and opens the MA dial on the playing station; F2 switches the band", async () => {
    await openMusic(true);
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(keysOf(now)[0]).toBe("Radio");
    press("F1");
    const dlg = screen.getByRole("dialog", { name: "MA radio" });
    await waitFor(() =>
      expect(dlg.querySelector(".radio-now-name")?.textContent).toBe("100FM Israeli"),
    );
    expect(keysOf(dlg)).toEqual(["Back", "Favourites", "Unfavourite", "List"]);
    press("F2");
    expect(keysOf(screen.getByRole("dialog", { name: "MA radio" }))[1]).toBe("All stations");
    // tuning plays on the player and stays on the dial (bus task 029: only the library's play now leaves)
    press("Enter");
    await waitFor(() => expect(lib.playLibrary).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "MA radio" })).toBeVisible();
    press("Escape");
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });
  it("Search keyboard: English on open, the globe toggles to Hebrew and back keeping the query; Down from the globe = results", async () => {
    lib.searchLibraryItems.mockResolvedValue({ ok: true, items: [ALBUM] });
    await openMusic(false, "he");
    press("F2");
    for (let i = 0; i < 7; i++) press("ArrowDown");
    press("Enter");
    let dlg = screen.getByRole("dialog", { name: "ספריה" });
    const grid = () => dlg.querySelector(".search-keys")!;
    const field = () => dlg.querySelector(".search-field")!;
    const selectedKey = () => dlg.querySelector('.search-key[aria-selected="true"]');
    const globe = () => screen.getByRole("gridcell", { name: "שפת המקלדת" });
    // English by default even with the Hebrew UI; five rows, the globe alone in the last one
    expect(grid().getAttribute("data-layout")).toBe("en");
    expect(Array.from(grid().querySelectorAll("[role=row]")).map((r) => r.children.length)).toEqual(
      [10, 10, 10, 10, 1],
    );
    expect(selectedKey()?.textContent).toBe("A");
    // down four rows from A: the globe; Enter toggles, types nothing, keeps the cursor there
    for (let i = 0; i < 4; i++) press("ArrowDown");
    expect(selectedKey()).toBe(globe());
    expect(globe().querySelector("svg.mdi-web")).not.toBeNull();
    press("Enter");
    expect(grid().getAttribute("data-layout")).toBe("he");
    expect(selectedKey()).toBe(globe());
    expect(field().getAttribute("data-empty")).toBe("true");
    // Up from the globe: the key above it (bottom left, "0"); the top row's left end is Yod, its right end Alef
    press("ArrowUp");
    expect(selectedKey()?.textContent).toBe("0");
    for (let i = 0; i < 3; i++) press("ArrowUp");
    expect(selectedKey()?.textContent).toBe("י");
    for (let i = 0; i < 9; i++) press("ArrowRight");
    expect(selectedKey()?.textContent).toBe("א");
    press("Enter");
    press("ArrowLeft"); // physical left: Bet
    expect(selectedKey()?.textContent).toBe("ב");
    press("Enter");
    expect(field().textContent).toBe("אב");
    expect(field().getAttribute("dir")).toBe("auto");
    // back to English through the globe (Down x4 from the top row), the query stays; type a Latin letter
    for (let i = 0; i < 4; i++) press("ArrowDown");
    expect(selectedKey()).toBe(globe());
    press("Enter");
    expect(grid().getAttribute("data-layout")).toBe("en");
    expect(field().textContent).toBe("אב");
    press("ArrowUp");
    for (let i = 0; i < 3; i++) press("ArrowUp");
    expect(selectedKey()?.textContent).toBe("A");
    press("Enter");
    expect(field().textContent).toBe("אבA");
    await waitFor(() =>
      expect(lib.searchLibraryItems).toHaveBeenLastCalledWith({ data: { query: "אבA" } }),
    );
    await waitFor(() => expect(dlg.textContent).toContain("Sheer Heart Attack"));
    // Down from the globe row moves onto the results
    for (let i = 0; i < 4; i++) press("ArrowDown");
    expect(selectedKey()).toBe(globe());
    press("Enter"); // Hebrew again
    press("ArrowDown");
    expect(dlg.querySelector('.search-rows [aria-selected="true"]')?.textContent).toContain(
      "Sheer Heart Attack",
    );
    // on the results the keyboard gives its place to the list; the search is remembered once they are opened
    expect(dlg.querySelector(".search-keys")).toBeNull();
    expect(lib.rememberSearch).toHaveBeenCalledWith({ data: { query: "אבA" } });
    // leaving Search and coming back: English again and an empty field (2026-11-22: the last search is a recent row)
    press("F1"); // results -> keys
    expect(field().textContent).toBe("אבA");
    press("F1"); // keys -> sections list
    press("Enter");
    dlg = screen.getByRole("dialog", { name: "ספריה" });
    expect(grid().getAttribute("data-layout")).toBe("en");
    expect(field().getAttribute("data-empty")).toBe("true");
  });
});

// 2026-11-22 (the owner): search one key away from the music screen, and Music Assistant's results the way its web app
// lists them: the typed song first, groups by type, recent searches below two characters.
describe("search from the music screen", () => {
  const SONG = it_("ytmusic://track/1", "track", "עוף גוזל", {
    sub: "Arik Einstein · על גבול האור",
    inLibrary: false,
  });
  const COVER = it_("ytmusic://track/2", "track", "עוף גוזל", { sub: "Sarit Hadad" });
  const ARTIST = it_("ytmusic://artist/1", "artist", "Arik Einstein");
  const RECORD = it_("ytmusic://album/1", "album", "על גבול האור", { sub: "Arik Einstein · 1987" });
  const rowsOf = (el: Element) =>
    Array.from(el.querySelectorAll(".lib-search-rows [role=option]")).map((b) => b.textContent);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    lib.playLibrary.mockResolvedValue({ ok: true, status: "playing" });
    lib.getSearchRecents.mockResolvedValue({ items: [] });
    lib.rememberSearch.mockImplementation(({ data }: { data: { query: string } }) =>
      Promise.resolve({ items: [data.query] }),
    );
    lib.searchLibraryItems.mockResolvedValue({
      ok: true,
      query: "AA",
      items: [SONG, COVER, ARTIST, RECORD],
      top: 1,
    });
    lib.getLibraryList.mockResolvedValue({
      ok: true,
      total: 0,
      offset: 0,
      favorites: 0,
      parent: ARTIST,
      items: [],
    });
  });

  it("F4 opens Search with the keyboard; Back returns to the music screen", async () => {
    await openMusic();
    expect(keysOf(screen.getByRole("dialog", { name: "Amplifier view" }))).toEqual([
      "\u00a0",
      "Library",
      "Player",
      "Search",
    ]);
    press("F4");
    const dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector("h1")?.textContent).toBe("Search");
    expect(dlg.querySelector('.search-key[aria-selected="true"]')?.textContent).toBe("A");
    expect(keysOf(dlg).slice(0, 3)).toEqual(["Back", "Delete", "Space"]);
    expect(lib.getLibraryList).not.toHaveBeenCalled();
    press("F1");
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    // the Library path still leads there, and its Back climbs to the sections list
    press("F2");
    for (let i = 0; i < 7; i++) press("ArrowDown");
    press("Enter");
    expect(screen.getByRole("dialog", { name: "Library" }).querySelector(".search-keys")).not.toBe(
      null,
    );
    press("F1");
    expect(sectionsOf(screen.getByRole("dialog", { name: "Library" })).length).toBe(8);
  });

  it("the typed song is the first row under the keyboard; on the results the list is grouped; Enter plays the song", async () => {
    await openMusic();
    press("F4");
    const dlg = screen.getByRole("dialog", { name: "Library" });
    press("Enter");
    press("Enter");
    await waitFor(() =>
      expect(lib.searchLibraryItems).toHaveBeenLastCalledWith({ data: { query: "AA" } }),
    );
    await waitFor(() => expect(rowsOf(dlg).length).toBe(4));
    // under the keyboard: the head of the list, each row says its type
    expect(rowsOf(dlg)[0]).toBe("עוף גוזלTrack · Arik Einstein · על גבול האור");
    expect(rowsOf(dlg)[2]).toBe("Arik EinsteinArtist");
    expect(dlg.querySelector('.lib-search-rows [aria-selected="true"]')).toBeNull();
    expect(lib.rememberSearch).not.toHaveBeenCalled();
    // F4 (Enter): the keyboard goes, the whole list shows under its headings, the cursor on the song
    press("F4");
    expect(dlg.querySelector(".search-keys")).toBeNull();
    expect(Array.from(dlg.querySelectorAll(".lib-search-group")).map((e) => e.textContent)).toEqual(
      ["Top result", "Tracks", "Artists", "Albums"],
    );
    expect(dlg.querySelector('.lib-search-rows [aria-selected="true"]')?.textContent).toBe(
      "עוף גוזלTrack · Arik Einstein · על גבול האור",
    );
    // under a type's heading the second line is the artist only
    expect(rowsOf(dlg)[1]).toBe("עוף גוזלSarit Hadad");
    expect(dlg.querySelector(".lib-search-foot .music-page")?.textContent).toBe("1/1");
    expect(lib.rememberSearch).toHaveBeenCalledWith({ data: { query: "AA" } });
    expect(keysOf(dlg)).toEqual(["Back", "Play next", "Add to queue", "Favourite"]);
    // an artist row offers Open; Up from the first row is the keyboard again
    press("ArrowDown");
    press("ArrowDown");
    expect(keysOf(dlg)[3]).toBe("Open");
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    expect(dlg.querySelector(".search-keys")).not.toBeNull();
    press("F4");
    press("Enter");
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({
        data: { uri: "ytmusic://track/1", option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("recent searches show below two characters; Enter on one runs it", async () => {
    lib.getSearchRecents.mockResolvedValue({ items: ["עוף גוזל", "queen"] });
    await openMusic(false, "he");
    press("F4");
    const dlg = screen.getByRole("dialog", { name: "ספריה" });
    await waitFor(() => expect(dlg.querySelectorAll(".lib-recent").length).toBe(2));
    expect(rowsOf(dlg)).toEqual(["עוף גוזלחיפוש אחרון", "queenחיפוש אחרון"]);
    press("F4");
    expect(dlg.querySelector(".search-keys")).toBeNull();
    expect(dlg.querySelector(".lib-search-group")?.textContent).toBe("חיפושים אחרונים");
    expect(keysOf(dlg)).toEqual(["חזרה", "\u00a0", "\u00a0", "\u00a0"]);
    expect(dlg.querySelector('.lib-search-rows [aria-selected="true"]')?.textContent).toContain(
      "עוף גוזל",
    );
    press("Enter");
    expect(dlg.querySelector(".search-field")?.textContent).toBe("עוף גוזל");
    expect(dlg.querySelector(".search-field")?.getAttribute("dir")).toBe("auto");
    await waitFor(() =>
      expect(lib.searchLibraryItems).toHaveBeenLastCalledWith({ data: { query: "עוף גוזל" } }),
    );
    await waitFor(() =>
      expect(
        Array.from(dlg.querySelectorAll(".lib-search-group")).map((e) => e.textContent),
      ).toEqual(["התאמה מדויקת", "שירים", "אמנים", "אלבומים"]),
    );
    expect(lib.rememberSearch).toHaveBeenCalledWith({ data: { query: "עוף גוזל" } });
    expect(lib.playLibrary).not.toHaveBeenCalled();
  });
});
