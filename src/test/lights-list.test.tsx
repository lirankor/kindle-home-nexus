import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoMediaSnapshot, demoRadioLists } from "@/lib/media";
import { routeTree } from "@/routeTree.gen";

// The Lights tab in demo mode (no Home Assistant): actions change the demo state, so the rows show them.
const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  runAction: vi.fn(),
  getScreensaver: vi.fn(),
  markScreensaverPhoto: vi.fn(),
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
  markScreensaverPhoto: mocks.markScreensaverPhoto,
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

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".light-list .light-row")];
const row = (index: number) => rows()[index]!;
const level = (index: number) => row(index).querySelector(".light-level")?.textContent ?? "";
const bars = (index: number) => row(index).querySelectorAll(".level-bar i[data-on]").length;
const dialog = () => document.querySelector(".full-modal")?.getAttribute("aria-label") ?? null;
/** First row that is on (or off), by the row's own state. */
const find = (on: boolean) => rows().findIndex((el) => el.dataset["on"] === String(on));

async function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

describe("Lights list", () => {
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
  });
  afterEach(() => cleanup());

  it("shows one focusable row per light with a level bar, no inner buttons", async () => {
    await renderApp();
    expect(document.querySelector(".light-card")).toBeNull();
    for (const el of rows()) {
      expect(el.querySelectorAll("button")).toHaveLength(0);
      expect(el.querySelectorAll(".level-bar i")).toHaveLength(10);
      expect(el.getAttribute("aria-label")).not.toContain("[object");
    }
    const on = find(true);
    expect(on).toBeGreaterThanOrEqual(0);
    expect(level(on)).toMatch(/^\d+%$/);
    expect(bars(on)).toBe(Math.max(1, Math.round(parseInt(level(on), 10) / 10)));
  });

  it("Enter (a click on the row) toggles the light without opening its page", async () => {
    await renderApp();
    const on = find(true);
    act(() => row(on).click());
    expect(row(on).dataset["on"]).toBe("false");
    expect(level(on)).toBe("כבוי");
    expect(bars(on)).toBe(0);
    expect(dialog()).toBeNull();
    act(() => row(on).click());
    expect(row(on).dataset["on"]).toBe("true");
  });

  it("Left / Right on the focused row dim in 10 % steps and keep the focus on the row", async () => {
    await renderApp();
    const on = find(true);
    act(() => row(on).focus());
    // Bring the light to a known level first: up to 100, then two steps down.
    for (let step = 0; step < 10; step += 1) press("ArrowRight");
    expect(level(on)).toBe("100%");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(level(on)).toBe("80%");
    expect(bars(on)).toBe(8);
    press("ArrowRight");
    expect(level(on)).toBe("90%");
    expect(document.activeElement).toBe(row(on));
    // Never below 1 %: dimming does not switch the light off.
    for (let step = 0; step < 12; step += 1) press("ArrowLeft");
    expect(level(on)).toBe("1%");
    expect(row(on).dataset["on"]).toBe("true");
    expect(bars(on)).toBe(1);
  });

  it("Right switches a dark light on at 10 %, Left leaves it off", async () => {
    await renderApp();
    let off = find(false);
    if (off < 0) {
      off = 0;
      act(() => row(off).click());
    }
    act(() => row(off).focus());
    press("ArrowLeft");
    expect(row(off).dataset["on"]).toBe("false");
    press("ArrowRight");
    expect(row(off).dataset["on"]).toBe("true");
    expect(level(off)).toBe("10%");
  });

  it("a long press (ContextMenu, or Shift+Enter on a desktop) opens the light's page", async () => {
    await renderApp();
    act(() => row(1).focus());
    const before = row(1).dataset["on"];
    press("ContextMenu");
    expect(dialog()).toMatch(/^אור /);
    press("Escape");
    expect(dialog()).toBeNull();
    expect(row(1).dataset["on"]).toBe(before);
    act(() => row(1).focus());
    press("Enter", { shiftKey: true });
    expect(dialog()).toMatch(/^אור /);
  });

  it("a long press where there is nothing extra counts as a plain press", async () => {
    await renderApp();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    press("ContextMenu");
    expect(dialog()).toBeNull();
    // On a button without extra options (the screensaver button in the heading) it is a click.
    const moon = document.querySelector<HTMLButtonElement>(".section-heading button")!;
    act(() => moon.focus());
    press("ContextMenu");
    await waitFor(() => expect(document.querySelector(".photo-screen")).not.toBeNull());
  });

  it("a long press inside the light's page acts as Enter on the focused control, not a second page", async () => {
    await renderApp();
    act(() => row(0).focus());
    press("ContextMenu");
    expect(dialog()).toMatch(/^אור /);
    press("ContextMenu");
    expect(dialog()).toMatch(/^אור /);
  });
});
