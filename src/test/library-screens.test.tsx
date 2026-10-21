// Bus task 027: the Music Assistant client screens on the panel (Library with four tabs + More, Discover, MA dial).
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

/** Music through HA on R-N500 AirPlay, nothing queued; `radio`: an MA radio plays. */
const haResult = (radio = false): MediaSnapshotResult => {
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
      discoverKey: true,
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
const tabsOf = (el: Element) =>
  Array.from(el.querySelectorAll(".lib-tabs [role=tab]")).map((b) => b.textContent);

const ALBUM = it_("library://album/1", "album", "Sheer Heart Attack", { sub: "Queen · 1974" });
const TRACKS = [1, 2, 3].map((i) =>
  it_(`library://track/${i}`, "track", `Track ${i}`, { albumUri: ALBUM.uri }),
);
const RADIOS = [
  it_("library://radio/1", "radio", "WDR 5", { favorite: true }),
  it_("library://radio/2", "radio", "100FM Israeli", { favorite: true }),
];

async function openMusic(radio = false, lang: "he" | "en" = "en") {
  mocks.getMediaSnapshot.mockResolvedValue(haResult(radio));
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
    lib.getLibraryHome.mockResolvedValue({
      ok: true,
      rows: [
        { id: "recently_played", name: "Recently played", items: [ALBUM] },
        { id: "favorite_radio", name: "Favorite Radio stations", items: RADIOS },
      ],
    });
  });

  it("F2 opens the Library on Playlists: four tabs + More; a container row has Open, its Play all row the heart", async () => {
    await openMusic();
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(keysOf(now)).toEqual(["\u00a0", "Library", "Player", "Discover"]);
    press("F2");
    const libDlg = screen.getByRole("dialog", { name: "Library" });
    expect(tabsOf(libDlg)).toEqual(["Playlists", "Radio", "Genres", "Albums", "More"]);
    await waitFor(() => expect(libDlg.textContent).toContain("Sheer Heart Attack"));
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
  });

  it("Right walks the tabs (Radio has the Dial key); past Albums More opens; a choice takes the fourth slot", async () => {
    await openMusic();
    press("F2");
    press("ArrowRight");
    let dlg = screen.getByRole("dialog", { name: "Library" });
    expect(dlg.querySelector('[role=tab][aria-selected="true"]')?.textContent).toBe("Radio");
    await waitFor(() =>
      expect(keysOf(screen.getByRole("dialog", { name: "Library" }))).toEqual([
        "Back",
        "Dial",
        "Add to queue",
        "Unfavourite",
      ]),
    );
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowRight"); // Albums -> More
    const more = screen.getByRole("dialog", { name: "More" });
    expect(more.textContent).toContain("Artists");
    expect(more.textContent).toContain("Search");
    expect(more.textContent).not.toContain("Audiobooks");
    press("ArrowDown");
    press("Enter"); // Tracks
    dlg = screen.getByRole("dialog", { name: "Library" });
    expect(tabsOf(dlg)).toEqual(["Playlists", "Radio", "Genres", "Tracks", "More"]);
  });

  it("Enter plays a container at once and returns to the music screen", async () => {
    await openMusic();
    press("F2");
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
    // the library opens fresh (top of the tab) next time
    press("F2");
    expect(screen.getByRole("dialog", { name: "Library" }).textContent).not.toContain("Play all");
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

  it("Discover on F4: the panel's rows, the standard footer, Open on a container, Enter plays now and leaves", async () => {
    await openMusic(false, "he");
    press("F4");
    let dlg = screen.getByRole("dialog", { name: "גילוי" });
    await waitFor(() => expect(dlg.textContent).toContain("הושמעו לאחרונה"));
    expect(lib.getLibraryHome).toHaveBeenCalledWith({
      data: { sections: ["recently_played", "favorite_radio", "recommendations"] },
    });
    expect(dlg.querySelector(".discover-foot .music-page")?.textContent).toBe(
      "פריט 1/1 · שורה 1/2",
    );
    expect(dlg.textContent).not.toContain("Enter נגינה"); // no key-hint line
    expect(dlg.textContent).not.toMatch(/[◀▶]/);
    expect(keysOf(dlg)).toEqual(["חזרה", "הבא בתור", "הוסף לתור", "פתח"]);
    // Open: the album in the Library (Play all first); Back returns to Discover
    press("F4");
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "ספריה" }).textContent).toContain("נגן הכל"),
    );
    press("F1");
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(dlg.textContent).toContain("הושמעו לאחרונה");
    press("ArrowLeft"); // Hebrew: left = forward
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "גילוי" }).textContent).toContain(
        "תחנות רדיו מועדפות",
      ),
    );
    dlg = screen.getByRole("dialog", { name: "גילוי" });
    expect(dlg.querySelector(".discover-foot .music-page")?.textContent).toBe(
      "פריט 1/2 · שורה 2/2",
    );
    expect(keysOf(dlg)[3]).toBe("הסר ממועדפים"); // a radio is a leaf: the heart
    press("ArrowDown");
    expect(
      screen.getByRole("dialog", { name: "גילוי" }).querySelector(".discover-foot .music-page")
        ?.textContent,
    ).toBe("פריט 2/2 · שורה 2/2");
    press("Enter");
    await waitFor(() =>
      expect(lib.playLibrary).toHaveBeenCalledWith({
        data: { uri: "library://radio/2", option: "replace" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
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
});
