import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { demoMediaSnapshot, demoMusicList, demoRadioLists, demoTracks } from "@/lib/media";
import type { MediaSnapshotResult, MusicListResult, MusicTab, QueueProgress } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import type { MediaNotice } from "@/lib/media-panel";

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
vi.mock("@/lib/media.functions", () => mocks);

const liveResult = (): MediaSnapshotResult => ({
  configured: true,
  amp: true,
  jellyfin: true,
  snapshot: demoMediaSnapshot(),
  lang: "he",
});
/** The amp playing the second demo track from a four-track queue, 30 s in. */
const musicQueue = (): QueueProgress => {
  const track = demoTracks()[1]!;
  return {
    title: track.album ?? "",
    index: 1,
    count: 4,
    track,
    positionMs: 30000,
    durationMs: track.durationMs,
    status: "playing",
  };
};
const musicResult = (): MediaSnapshotResult => {
  const r = liveResult();
  const s = r.snapshot!;
  const queue = musicQueue();
  s.amp.source = "SERVER";
  s.nowPlaying = {
    kind: "music",
    title: queue.track!.title,
    artist: queue.track!.artist,
    album: queue.track!.album,
    station: null,
    artItemId: null,
    stationId: null,
    preset: null,
  };
  s.queue = queue;
  s.radio = null;
  return r;
};
/** Demo lists marked configured; albums get a second page with one more album. */
const musicLists = ({
  data,
}: {
  data: { tab: MusicTab; page: number };
}): Promise<MusicListResult> => {
  const base = { ...demoMusicList(data.tab, data.page), configured: true };
  if (data.tab !== "albums") return Promise.resolve(base);
  if (data.page === 0) return Promise.resolve({ ...base, pages: 2 });
  return Promise.resolve({
    configured: true,
    tab: "albums",
    page: 1,
    pages: 2,
    items: [
      {
        kind: "album",
        id: "album-9",
        title: "Page Two Album",
        detail: "Someone · 1999",
        artItemId: null,
      },
    ],
  });
};

const notices: MediaNotice[] = [];
function Harness({ lang }: { lang: "he" | "en" }) {
  const panel = useMediaPanel({ active: true, lang, notify: (n) => notices.push(n) });
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
          <button data-testid="open-music" onClick={() => panel.open("music")} />
        </main>
        <DeviceActions actions={panel.actions} />
        <MediaModal panel={panel} status="" />
      </div>
    </LangContext.Provider>
  );
}

const renderPanel = (lang: "he" | "en" = "he") =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness lang={lang} />
    </QueryClientProvider>,
  );
const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const activeTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null;
const rowTitles = () =>
  Array.from(document.querySelectorAll(".music-row strong")).map((el) => el.textContent);
const rowDetails = () =>
  Array.from(document.querySelectorAll(".music-row .source-row-text span")).map(
    (el) => el.textContent,
  );
const selectedRow = () =>
  document.querySelector('.music-row[aria-selected="true"] strong')?.textContent ?? null;
const pageCounter = () => document.querySelector(".music-page")?.textContent ?? null;
const softKey = (n: number) =>
  document.querySelectorAll<HTMLButtonElement>(".full-modal [data-soft-key]")[n - 1]!;

/** Media tab → music screen straight away. */
async function openMusic(lang: "he" | "en" = "he") {
  renderPanel(lang);
  const title = lang === "he" ? "פתח את המגבר" : "Open the amplifier";
  await waitFor(() => expect(screen.getByTitle(title)).toBeVisible());
  act(() => screen.getByTestId("open-music").click());
  await waitFor(() => expect(rowTitles().length).toBeGreaterThan(0));
}

describe("Music screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notices.length = 0;
    mocks.getMediaSnapshot.mockResolvedValue(liveResult());
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    mocks.getRadioLists.mockResolvedValue({ ...demoRadioLists(), configured: true });
    mocks.tuneRadioStation.mockResolvedValue({ ok: true });
    mocks.getMusicLists.mockImplementation(musicLists);
    mocks.playMusic.mockResolvedValue({ ok: true, queue: musicQueue() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens from the source list on the mixes tab, names the mixes, and switches tabs with left / right", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3"); // NET RADIO plays: the radio screen
    press("F1"); // amp view
    press("F3"); // source list, cursor on רדיו (the current source, row 4)
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    press("Enter"); // ג׳ליפין
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenCalledWith({
        data: { type: "amp.source", source: "SERVER" },
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "מוזיקה" });
    expect(dialog).toBeVisible();
    await waitFor(() =>
      expect(mocks.getMusicLists).toHaveBeenCalledWith({ data: { tab: "mixes", page: 0 } }),
    );
    await waitFor(() => expect(rowTitles().slice(0, 4)).toEqual(["מיקס יומי", "גילוי", "מסיבה", "ריקודים"]));
    expect(activeTab()).toBe("מיקסים");
    expect(rowDetails()[0]).toBe("סביב שיר אהוב · 20 שירים");
    expect(selectedRow()).toBe("מיקס יומי");
    expect(pageCounter()).toBe("1/1");
    // Footer: back, previous (greyed on page 1), next (greyed, one page), blank (no power key).
    expect(softKey(1).textContent).toBe("חזרה");
    expect(softKey(2).disabled).toBe(true);
    expect(softKey(3).disabled).toBe(true);
    expect(softKey(4).disabled).toBe(true);
    // Hebrew: the first tab is at the right end, so left moves on to the second tab.
    press("ArrowRight");
    expect(activeTab()).toBe("מיקסים");
    press("ArrowLeft");
    expect(activeTab()).toBe("מומלצים");
    await waitFor(() =>
      expect(mocks.getMusicLists).toHaveBeenCalledWith({ data: { tab: "suggested", page: 0 } }),
    );
    await waitFor(() => expect(rowTitles()[0]).toBe("Where Is Love"));
    expect(rowDetails()[0]).toBe("McCoy Tyner Trio");
    press("ArrowRight");
    expect(activeTab()).toBe("מיקסים");
    await waitFor(() => expect(rowTitles()[0]).toBe("מיקס יומי"));
    // Already cached: no second request for the mixes.
    expect(mocks.getMusicLists.mock.calls.filter((c) => c[0].data.tab === "mixes").length).toBe(1);
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("shows English tab names and reads left-to-right", async () => {
    await openMusic("en");
    expect(
      Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent),
    ).toEqual(["Mixes", "Picks", "Artists", "Albums", "Recent"]);
    expect(rowTitles().slice(0, 4)).toEqual(["Daily mix", "Discover", "Party", "Dancing"]);
    expect(rowDetails()[1]).toBe("Tracks never played · 20 tracks");
    press("ArrowRight");
    expect(activeTab()).toBe("Picks");
    expect(screen.getByRole("dialog").textContent).toContain("Enter play");
  });

  it("pages the albums tab with F3 / F2 and lets the highlight cross the page edge", async () => {
    await openMusic();
    press("ArrowLeft");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(activeTab()).toBe("אלבומים");
    await waitFor(() => expect(pageCounter()).toBe("1/2"));
    expect(rowTitles()).toEqual([
      "Infinity",
      "Origin of Symmetry",
      "Greatest Hits",
      "Kind of Blue",
    ]);
    expect(rowDetails()[0]).toBe("McCoy Tyner Trio");
    expect(softKey(2).disabled).toBe(true);
    expect(softKey(3).disabled).toBe(false);
    press("F3");
    await waitFor(() =>
      expect(mocks.getMusicLists).toHaveBeenCalledWith({ data: { tab: "albums", page: 1 } }),
    );
    await waitFor(() => expect(rowTitles()).toEqual(["Page Two Album"]));
    expect(pageCounter()).toBe("2/2");
    expect(rowDetails()[0]).toBe("Someone · 1999");
    expect(softKey(3).disabled).toBe(true);
    expect(selectedRow()).toBe("Page Two Album");
    // Up from the first row goes back a page, onto its last row; down from there comes forward again.
    press("ArrowUp");
    await waitFor(() => expect(pageCounter()).toBe("1/2"));
    expect(selectedRow()).toBe("Kind of Blue");
    press("ArrowDown");
    await waitFor(() => expect(pageCounter()).toBe("2/2"));
    expect(selectedRow()).toBe("Page Two Album");
    press("F2");
    await waitFor(() => expect(pageCounter()).toBe("1/2"));
    expect(selectedRow()).toBe("Infinity");
    press("ArrowDown");
    expect(selectedRow()).toBe("Origin of Symmetry");
    // The remembered page survives a tab change.
    press("F3");
    await waitFor(() => expect(pageCounter()).toBe("2/2"));
    press("ArrowRight");
    expect(activeTab()).toBe("אמנים");
    await waitFor(() => expect(rowTitles()[0]).toBe("McCoy Tyner Trio"));
    expect(rowDetails()[0]).toBe("3 אלבומים");
    press("ArrowLeft");
    await waitFor(() => expect(pageCounter()).toBe("2/2"));
  });

  it("plays the highlighted row on Enter and opens the amp view once the server started it", async () => {
    await openMusic();
    press("ArrowDown");
    expect(selectedRow()).toBe("גילוי");
    let settle: (value: { ok: boolean; queue: QueueProgress }) => void = () => {};
    mocks.playMusic.mockImplementationOnce(
      () => new Promise<{ ok: boolean; queue: QueueProgress }>((resolve) => (settle = resolve)),
    );
    press("Enter");
    await waitFor(() =>
      expect(mocks.playMusic).toHaveBeenCalledWith({ data: { kind: "mix", id: "discover" } }),
    );
    // Optimistic status line, still on the list until the server answers.
    expect(notices.at(-1)?.text).toBe("מנגן: גילוי…");
    expect(screen.getByRole("dialog", { name: "מוזיקה" })).toBeVisible();
    const queue = { ...musicQueue(), index: 0, positionMs: 0 };
    mocks.getMediaSnapshot.mockResolvedValue({
      ...musicResult(),
      snapshot: { ...musicResult().snapshot!, queue },
    });
    await act(async () => settle({ ok: true, queue }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible());
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(dialog.querySelector(".amp-badge")?.textContent).toBe("ג׳ליפין");
    expect(dialog.querySelector(".amp-title")?.textContent).toBe("New Born");
    expect(dialog.querySelector(".amp-queue-pos")?.textContent).toBe("1 מתוך 4");
    expect(dialog.querySelector(".amp-progress")).not.toBeNull();
  });

  it("reports a failed play and stays on the list", async () => {
    await openMusic();
    mocks.playMusic.mockResolvedValueOnce({ ok: false, error: "Amp is off" });
    press("Enter");
    await waitFor(() => expect(notices.at(-1)).toEqual({ text: "Amp is off", error: true }));
    expect(screen.getByRole("dialog", { name: "מוזיקה" })).toBeVisible();
  });

  it("amp view with music: progress bar and track position, right / left / Enter drive the queue, the bar counts on between polls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.getMediaSnapshot.mockResolvedValue(musicResult());
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    expect(screen.getByTitle("פתח את המגבר").textContent).toContain("New Born · Muse");
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(dialog.querySelector(".amp-title")?.textContent).toBe("New Born");
    expect(dialog.querySelector(".amp-sub")?.textContent).toBe("Muse");
    expect(dialog.querySelector(".amp-queue-pos")?.textContent).toBe("2 מתוך 4");
    expect(dialog.querySelector(".amp-time-pos")?.textContent).toBe("0:30");
    expect(dialog.querySelector(".amp-times")?.textContent).toContain("6:05");
    const width = () => dialog.querySelector<HTMLElement>(".progress-track span")!.style.width;
    expect(parseFloat(width())).toBeCloseTo((30000 / 365000) * 100, 1);
    expect(dialog.textContent).toContain("Enter נגן/השהה");
    // Client-side ticker: a second later the position moved on without a new snapshot.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(dialog.querySelector(".amp-time-pos")?.textContent).toBe("0:32");
    expect(parseFloat(width())).toBeGreaterThan((30000 / 365000) * 100);
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "queue", op: "next" },
      }),
    );
    press("ArrowLeft");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "queue", op: "prev" },
      }),
    );
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.runMediaAction.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "queue", op: "pause" },
      }),
    );
    // Optimistically paused: the bar is marked and the ticker stops.
    expect(dialog.querySelector(".amp-progress")?.getAttribute("data-status")).toBe("paused");
    expect(dialog.querySelector(".amp-queue-pos")?.textContent).toContain("הושהה");
    await act(async () => settle({ ok: true }));
    // A paused queue in the snapshot: Enter resumes.
    const paused = musicResult();
    paused.snapshot!.queue!.status = "paused";
    mocks.getMediaSnapshot.mockResolvedValue(paused);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await waitFor(() =>
      expect(dialog.querySelector(".amp-progress")?.getAttribute("data-status")).toBe("paused"),
    );
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "queue", op: "resume" },
      }),
    );
  });

  it("while the amp is off: Enter starts the power-on routine into SERVER and plays the choice when it is done", async () => {
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    off.snapshot!.nowPlaying = {
      ...off.snapshot!.nowPlaying,
      kind: "none",
      station: null,
      stationId: null,
    };
    off.snapshot!.radio = null;
    mocks.getMediaSnapshot.mockResolvedValue(off);
    const now = Date.now();
    const running = {
      running: true,
      step: "plug" as const,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      source: "SERVER" as const,
    };
    mocks.startAmpPowerOn.mockResolvedValue({ ok: true, status: running });
    mocks.getPowerOnStatus.mockResolvedValue({ ...running, step: "wait", elapsedMs: 3000 });
    await openMusic();
    expect(screen.getByRole("dialog").textContent).toContain("Enter מדליק את המגבר");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter"); // רגוע
    await waitFor(() =>
      expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: { source: "SERVER" } }),
    );
    expect(mocks.playMusic).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "מוזיקה" });
    await waitFor(() => expect(dialog.textContent).toContain("מדליק את המגבר"));
    await waitFor(() => expect(mocks.getPowerOnStatus).toHaveBeenCalled());
    mocks.getPowerOnStatus.mockResolvedValue({
      ...running,
      running: false,
      step: "done",
      elapsedMs: 120000,
    });
    await waitFor(
      () => expect(mocks.playMusic).toHaveBeenCalledWith({ data: { kind: "mix", id: "party" } }),
      { timeout: 4000 },
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible());
  });
});
