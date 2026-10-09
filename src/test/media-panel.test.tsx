import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { demoMediaSnapshot, demoMusicList, demoRadioLists } from "@/lib/media";
import type { MusicTab } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import type { MediaSnapshotResult } from "@/lib/media";

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
  jellyfin: false,
  snapshot: demoMediaSnapshot(),
  lang: "he",
});

/** The amp on the turntable: its screen is the plain amp view. */
const phonoResult = (): MediaSnapshotResult => {
  const r = liveResult();
  r.snapshot!.amp.source = "PHONO";
  r.snapshot!.nowPlaying = {
    ...r.snapshot!.nowPlaying,
    kind: "phono",
    title: null,
    station: null,
    stationId: null,
  };
  r.snapshot!.radio = null;
  return r;
};

/** The shell's wiring in miniature: footer from the panel, soft keys first, then the panel's keys. */
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

describe("Media tab and amp view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMediaSnapshot.mockResolvedValue(liveResult());
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    mocks.getRadioLists.mockResolvedValue(demoRadioLists());
    mocks.tuneRadioStation.mockResolvedValue({ ok: true });
    mocks.getMusicLists.mockImplementation(({ data }: { data: { tab: MusicTab; page: number } }) =>
      Promise.resolve({ ...demoMusicList(data.tab, data.page), configured: true }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the TV and amp cards from the demo snapshot with the all-off footer", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("WDR 5 · Zara Larsson - Memory Lane")).toBeVisible(),
    );
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".media-cards button"));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("טלוויזיה");
    expect(cards[0]?.textContent).toContain("כבוי");
    expect(cards[1]?.textContent).toContain("מגבר");
    expect(cards[1]?.textContent).toContain("רדיו");
    expect(cards[1]?.textContent).toContain("-44.5 dB");
    // Footer: F1 movie mode, F2 TV, F3 amp, F4 all off.
    const footer = screen.getByRole("contentinfo");
    const slots = Array.from(footer.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    expect(slots).toEqual(["מצב סרט", "טלוויזיה", "מגבר", "כבה הכל"]);
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.runMediaAction.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({ data: { type: "all_off" } }),
    );
    // Optimistic: the amp shows off (no dB) while the server works.
    expect(cards[1]?.textContent).toContain("כבוי");
    expect(cards[1]?.textContent).not.toContain("dB");
    await act(async () => settle({ ok: true }));
  });

  it("opens the active source's screen from the amp card: the radio for NET RADIO, the amp view for the turntable", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    act(() => screen.getByTitle("פתח את המגבר").click());
    // NET RADIO plays: straight to the radio screen, no generic now-playing screen in between.
    expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible();
    expect(document.documentElement.getAttribute("data-eink-refresh")).toBe("full");
    // F1 on the radio goes to the amp view (which has the source key); F1 there closes.
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("amp view for the turntable: volume on up / down, no library key, Enter and right / left do nothing", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(phonoResult());
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(dialog).toBeVisible();
    expect(dialog.querySelector(".amp-title")?.textContent).toBe("פטיפון");
    expect(dialog.querySelector(".transport-db")?.textContent).toBe("-44.5dB");
    // Footer: back, no library (not the SERVER screen), source, no power key.
    const slots = Array.from(dialog.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    expect(slots).toEqual(["חזרה", "\u00a0", "מקור", "\u00a0"]);

    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.runMediaAction.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("ArrowUp");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenCalledWith({
        data: { type: "amp.volume.step", delta: 1 },
      }),
    );
    // Optimistic: shown right away, before the server answers; back to the snapshot once it does.
    expect(dialog.querySelector(".transport-db")?.textContent).toBe("-42.5dB");
    await act(async () => settle({ ok: true }));
    await waitFor(() => expect(dialog.querySelector(".transport-db")?.textContent).toBe("-44.5dB"));
    press("ArrowDown");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.volume.step", delta: -1 },
      }),
    );
    const calls = mocks.runMediaAction.mock.calls.length;
    press("ArrowRight");
    press("Enter");
    expect(mocks.runMediaAction).toHaveBeenCalledTimes(calls);
    press("F1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the source list on F3 and applies a source with Enter", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(phonoResult());
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3"); // amp view (turntable)
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3"); // source list
    const list = screen.getByRole("listbox", { name: "מקור" });
    const rows = list.querySelectorAll('[role="option"]');
    expect(Array.from(rows).map((r) => r.querySelector("strong")?.textContent)).toEqual([
      "ג׳ליפין",
      "טלוויזיה",
      "פטיפון",
      "רדיו",
      "FM",
    ]);
    // Cursor starts on the current source (PHONO = row 3).
    expect(rows[2]).toHaveAttribute("aria-selected", "true");
    press("ArrowUp");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.source", source: "CD" },
      }),
    );
    // CD goes back to the amp view; Jellyfin / radio would open their screens.
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3");
    // The snapshot still says PHONO (the mock returned no new one), so the cursor is on פטיפון.
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    // Cancel returns to where the list was opened from.
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3");
    press("ArrowDown");
    expect(screen.getAllByRole("option")[3]).toHaveAttribute("aria-selected", "true");
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.source", source: "NET RADIO" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".radio-dial")).not.toBeNull());
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("opening the amp while it is off starts the power-on routine and shows its steps", async () => {
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    mocks.getMediaSnapshot.mockResolvedValue(off);
    const now = Date.now();
    const waiting = {
      running: true,
      step: "wait" as const,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      source: "NET RADIO" as const,
    };
    mocks.startAmpPowerOn.mockResolvedValue({ ok: true, status: waiting });
    mocks.getPowerOnStatus.mockResolvedValue({ ...waiting, elapsedMs: 2000 });
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open the amplifier")).toBeVisible());
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(dialog.querySelector(".transport-db")?.textContent).toBe("—dB");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: {} }));
    await waitFor(() => expect(dialog.textContent).toContain("Waiting for the amplifier…"));
    expect(dialog.querySelector('[data-state="active"]')?.textContent).toContain("Waiting");
    expect(dialog.querySelector('[data-state="done"]')?.textContent).toContain("plug");
  });

  it("drops the step block within one poll when the server finishes at once, and refetches the snapshot", async () => {
    // Seen on the device: a stale "off" snapshot, F4 → the start call answers step "plug"; the amp
    // was in fact on, so the server finished within seconds, but the block stayed on step 1 / 0 s.
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    mocks.getMediaSnapshot.mockResolvedValue(off);
    const now = Date.now();
    const started = {
      running: true,
      step: "plug" as const,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      source: null,
    };
    mocks.startAmpPowerOn.mockResolvedValue({ ok: true, status: started });
    mocks.getPowerOnStatus.mockResolvedValue({
      ...started,
      running: false,
      step: "done",
      updatedAt: now + 1500,
      elapsedMs: 1500,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    const snapshots = mocks.getMediaSnapshot.mock.calls.length;
    press("F3"); // opening the amp while off starts the routine
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    mocks.getMediaSnapshot.mockResolvedValue(liveResult()); // the refetch sees the amp on
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: {} }));
    await waitFor(() => expect(mocks.getPowerOnStatus).toHaveBeenCalled());
    await waitFor(() => expect(dialog.textContent).not.toContain("מדליק את המגבר"), {
      timeout: 3000,
    });
    expect(dialog.querySelector(".poweron")).toBeNull();
    // The snapshot was refetched after "done": the amp is on NET RADIO, so the radio screen shows
    // with its volume.
    await waitFor(() =>
      expect(mocks.getMediaSnapshot.mock.calls.length).toBeGreaterThan(snapshots),
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible());
    const radio = screen.getByRole("dialog", { name: "רדיו" });
    await waitFor(() => expect(radio.querySelector(".transport-db")?.textContent).toBe("-44.5dB"));
    expect(radio.textContent).toContain("WDR 5");
  });

  it("refetches the snapshot when a screen opens and again 2 s after an action", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(phonoResult());
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    const before = mocks.getMediaSnapshot.mock.calls.length;
    press("F3"); // amp view: fresh snapshot right away, not at the next 10 s poll
    await waitFor(() => expect(mocks.getMediaSnapshot.mock.calls.length).toBe(before + 1));
    press("F3"); // source list: again
    await waitFor(() => expect(mocks.getMediaSnapshot.mock.calls.length).toBe(before + 2));
    press("F1");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const beforeAction = mocks.getMediaSnapshot.mock.calls.length;
    press("ArrowUp");
    await waitFor(() => expect(mocks.runMediaAction).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const settled = mocks.getMediaSnapshot.mock.calls.length; // invalidate right after the action
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mocks.getMediaSnapshot.mock.calls.length).toBe(settled + 1);
    expect(settled).toBeGreaterThanOrEqual(beforeAction);
  });

  it("shows a power-on routine started elsewhere, polls it, and ends on the radio screen for NET RADIO", async () => {
    const now = Date.now();
    const running = {
      running: true,
      step: "wait" as const,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 5000,
      source: "NET RADIO" as const,
    };
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    off.snapshot!.powerOn = running; // another client (or F4 on the server side) started it
    mocks.getMediaSnapshot.mockResolvedValue(off);
    mocks.getPowerOnStatus.mockResolvedValue({ ...running, step: "reload", elapsedMs: 9000 });
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    await waitFor(() => expect(dialog.textContent).toContain("מדליק את המגבר"));
    // Polled: the status moved on to the reload step.
    await waitFor(() => expect(mocks.getPowerOnStatus).toHaveBeenCalled());
    await waitFor(() =>
      expect(dialog.querySelector('[data-state="active"]')?.textContent).toContain("מתחבר"),
    );
    // Opening the amp did not start a second routine; it ends on NET RADIO → radio screen.
    expect(mocks.startAmpPowerOn).not.toHaveBeenCalled();
    mocks.getPowerOnStatus.mockResolvedValue({
      ...running,
      running: false,
      step: "done",
      elapsedMs: 120000,
    });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible(), {
      timeout: 4000,
    });
  });

  it("stays on the amp view when the routine ends there", async () => {
    const now = Date.now();
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    off.snapshot!.powerOn = {
      running: true,
      step: "turn_on",
      startedAt: now,
      updatedAt: now,
      elapsedMs: 80000,
      source: "SERVER",
    };
    mocks.getMediaSnapshot.mockResolvedValue(off);
    mocks.getPowerOnStatus.mockResolvedValue({
      ...off.snapshot!.powerOn,
      running: false,
      step: "done",
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3");
    await waitFor(() => expect(mocks.getPowerOnStatus).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "תצוגת המגבר" }).textContent).not.toContain(
        "מדליק את המגבר",
      ),
    );
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });
});
