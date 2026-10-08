import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoMediaSnapshot, demoMusicList, demoRadioLists } from "@/lib/media";
import type { MusicTab } from "@/lib/media";
import { routeTree } from "@/routeTree.gen";

// The whole shell, with the server functions mocked: demo home data, a live-looking media snapshot.
const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  runAction: vi.fn(),
  getScreensaver: vi.fn(),
  getMediaSnapshot: vi.fn(),
  runMediaAction: vi.fn(),
  startAmpPowerOn: vi.fn(),
  getPowerOnStatus: vi.fn(),
  getRadioLists: vi.fn(),
  tuneRadioStation: vi.fn(),
  getMusicLists: vi.fn(),
  playMusic: vi.fn(),
}));
vi.mock("@/lib/home.functions", () => ({
  getSnapshot: mocks.getSnapshot,
  runAction: mocks.runAction,
  getScreensaver: mocks.getScreensaver,
}));
vi.mock("@/lib/media.functions", () => ({
  getMediaSnapshot: mocks.getMediaSnapshot,
  runMediaAction: mocks.runMediaAction,
  startAmpPowerOn: mocks.startAmpPowerOn,
  getPowerOnStatus: mocks.getPowerOnStatus,
  getRadioLists: mocks.getRadioLists,
  tuneRadioStation: mocks.tuneRadioStation,
  getMusicLists: mocks.getMusicLists,
  playMusic: mocks.playMusic,
}));

const KEY = "kindle-panel-state";
const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const activeTab = () => document.querySelector('.device-tabs [data-active="true"]')?.textContent;
const dialog = () => document.querySelector(".full-modal")?.getAttribute("aria-label") ?? null;

async function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(document.querySelector(".device-tabs")).not.toBeNull());
}

describe("Panel idle behaviour and persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getSnapshot.mockResolvedValue({ configured: false, snapshot: null, lang: "he" });
    mocks.getScreensaver.mockResolvedValue({
      image: null,
      sample: true,
      result: { configured: false, snapshot: null, lang: "he" },
    });
    mocks.getMediaSnapshot.mockResolvedValue({
      configured: true,
      amp: true,
      jellyfin: false,
      snapshot: demoMediaSnapshot(),
      lang: "he",
    });
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    mocks.getRadioLists.mockResolvedValue(demoRadioLists());
    mocks.tuneRadioStation.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("closes a light modal after 30 s idle but keeps the amp view open", async () => {
    await renderApp();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Light modal: open the first light card (Enter on a focused card is a native button click).
    act(() => document.querySelector<HTMLButtonElement>(".light-card")?.click());
    expect(dialog()).toMatch(/^אור /);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(dialog()).toBeNull();

    // Amp view: Media tab, F3. It is a "now playing" view and must survive the idle timeout.
    press("PageUp");
    expect(activeTab()).toBe("מדיה");
    press("F3");
    expect(dialog()).toBe("תצוגת המגבר");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(dialog()).toBe("תצוגת המגבר");
  });

  it("remembers the tab and the media screen and restores them on mount", async () => {
    await renderApp();
    expect(activeTab()).toBe("אורות");
    press("PageUp");
    expect(activeTab()).toBe("מדיה");
    press("F3");
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
        tab: "Media",
        mediaScreen: "now",
      }),
    );
    press("F1");
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
        tab: "Media",
        mediaScreen: null,
      }),
    );
    cleanup();

    // A fresh mount (bridge page reload) comes back to the Media tab …
    await renderApp();
    await waitFor(() => expect(activeTab()).toBe("מדיה"));
    cleanup();

    // … and to the amp view when that was open.
    localStorage.setItem(KEY, JSON.stringify({ tab: "Media", mediaScreen: "now" }));
    await renderApp();
    await waitFor(() => expect(dialog()).toBe("תצוגת המגבר"));
    expect(activeTab()).toBe("מדיה");
  });

  it("remembers the radio band and index and restores the dial there", async () => {
    await renderApp();
    press("PageUp");
    press("F3");
    expect(dialog()).toBe("תצוגת המגבר");
    press("F3"); // source list
    press("Enter"); // cursor is on רדיו (the current source) → radio screen
    await waitFor(() => expect(dialog()).toBe("רדיו"));
    await waitFor(() => expect(document.querySelector(".radio-dial")).not.toBeNull());
    press("ArrowRight"); // tune to station 2 of the local band (demo: no server call needed)
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
        tab: "Media",
        mediaScreen: "radio",
        radio: { list: "local", indexByList: { local: 1 } },
      }),
    );
    cleanup();
    // With the amp off nothing is playing, so the dial comes back where the user left it.
    const off = demoMediaSnapshot();
    off.amp.on = false;
    off.amp.state = "off";
    off.nowPlaying = { ...off.nowPlaying, kind: "none", station: null, stationId: null };
    off.radio = null;
    mocks.getMediaSnapshot.mockResolvedValue({
      configured: true,
      amp: true,
      jellyfin: false,
      snapshot: off,
      lang: "he",
    });
    localStorage.setItem(
      KEY,
      JSON.stringify({
        tab: "Media",
        mediaScreen: "radio",
        radio: { list: "english", indexByList: { english: 3 } },
      }),
    );
    await renderApp();
    await waitFor(() => expect(dialog()).toBe("רדיו"));
    await waitFor(() =>
      expect(document.querySelector(".radio-dial")?.getAttribute("data-list")).toBe("english"),
    );
    expect(document.querySelector(".radio-dial")?.getAttribute("data-index")).toBe("3");
  });

  it("remembers the music tab and page and reopens the screen there", async () => {
    mocks.getMusicLists.mockImplementation(({ data }: { data: { tab: MusicTab; page: number } }) =>
      Promise.resolve({
        ...demoMusicList(data.tab, data.page),
        configured: true,
        page: data.page,
        pages: 2,
      }),
    );
    await renderApp();
    press("PageUp");
    press("F3");
    expect(dialog()).toBe("תצוגת המגבר");
    press("F2"); // music screen
    await waitFor(() => expect(dialog()).toBe("מוזיקה"));
    press("ArrowLeft"); // Hebrew: the next tab (מומלצים)
    await waitFor(() => expect(document.querySelector(".music-page")?.textContent).toBe("1/2"));
    press("F3"); // next page
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
        tab: "Media",
        mediaScreen: "music",
        music: { tab: "suggested", pageByTab: { suggested: 1 } },
      }),
    );
    cleanup();
    localStorage.setItem(
      KEY,
      JSON.stringify({
        tab: "Media",
        mediaScreen: "music",
        music: { tab: "albums", pageByTab: { albums: 1 } },
      }),
    );
    await renderApp();
    await waitFor(() => expect(dialog()).toBe("מוזיקה"));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "אלבומים",
    );
    await waitFor(() => expect(document.querySelector(".music-page")?.textContent).toBe("2/2"));
    expect(mocks.getMusicLists).toHaveBeenLastCalledWith({ data: { tab: "albums", page: 1 } });
  });

  it("ignores a broken or foreign localStorage value", async () => {
    localStorage.setItem(KEY, "{not json");
    await renderApp();
    expect(activeTab()).toBe("אורות");
    cleanup();
    localStorage.setItem(KEY, JSON.stringify({ tab: "Nope", mediaScreen: "now" }));
    await renderApp();
    expect(activeTab()).toBe("אורות");
    expect(dialog()).toBeNull();
  });
});
