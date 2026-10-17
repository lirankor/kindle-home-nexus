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
function Harness({ lang, active = true }: { lang: "he" | "en"; active?: boolean }) {
  const panel = useMediaPanel({ active, lang, notify: () => {} });
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

const renderPanel = (lang: "he" | "en" = "he", active = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (a: boolean) => (
    <QueryClientProvider client={client}>
      <Harness lang={lang} active={a} />
    </QueryClientProvider>
  );
  const r = render(ui(active));
  return { ...r, setActive: (a: boolean) => r.rerender(ui(a)) };
};
const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

const fullGen = () => Number(document.documentElement.getAttribute("data-eink-full") ?? 0);

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

  it("renders the music card and one row per node, with the F-keys from media.keys (task 014)", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("WDR 5 · Zara Larsson - Memory Lane")).toBeVisible(),
    );
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".media-cards button"));
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("מוזיקה");
    expect(cards[0]?.textContent).toContain("דלוק · NET RADIO"); // the receiver's own title (task 015)
    expect(cards[0]?.textContent).toContain("-44.5 dB");
    expect(cards[1]?.textContent).toContain("מגבר");
    expect(cards[1]?.textContent).toContain("דלוק · NET RADIO");
    expect(cards[2]?.textContent).toContain("טלוויזיה");
    expect(cards[2]?.textContent).toContain("כבוי");
    // Footer: F1 music, F2 the amp node, F3 the TV node, F4 nothing.
    const footer = screen.getByRole("contentinfo");
    const slots = Array.from(footer.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    expect(slots).toEqual(["מוזיקה", "מגבר ימאהה", "טלוויזיה", "\u00a0"]);
  });

  it("a node screen: receiver keys (source list, stream output, power), volume on up / down", async () => {
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open Amplifier")).toBeVisible());
    press("F2");
    const dialog = screen.getByRole("dialog", { name: "Device" });
    expect(dialog.querySelector("h1")?.textContent).toBe("Amplifier");
    const slots = () =>
      Array.from(dialog.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    expect(slots()).toEqual(["Back", "Source", "Stream DLNA", "On / Off"]);
    press("ArrowUp");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "amp", op: "volume", delta: 1 },
      }),
    );
    press("F3");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "amp", op: "stream", option: "airplay" },
      }),
    );
    press("F2"); // the receiver's own inputs, live from its source_list and in its order (task 015)
    const list = screen.getByRole("listbox", { name: "Source" });
    expect(Array.from(list.querySelectorAll("strong")).map((r) => r.textContent)).toEqual([
      "Spotify",
      "NET RADIO",
      "SERVER",
      "AirPlay",
      "TUNER",
    ]); // five rows fit above the footer and the hint; the window follows the cursor
    expect(list.textContent).not.toContain("Bluetooth & TV");
    expect(list.querySelector('[aria-selected="true"]')?.textContent).toContain("NET RADIO");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(
      screen.getByRole("listbox").querySelector('[aria-selected="true"]')?.textContent,
    ).toContain("TUNER");
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "amp", op: "source", source: "TUNER" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Device" })).toBeVisible();
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "amp", op: "power", on: false },
      }),
    );
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the TV node: movie mode on F2, power on F4", async () => {
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open TV")).toBeVisible());
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "Device" });
    expect(
      Array.from(dialog.querySelectorAll("[data-soft-key]")).map((b) => b.textContent),
    ).toEqual(["Back", "Movie mode", "Source", "On / Off"]);
    press("F2");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "tv", op: "movie", on: true },
      }),
    );
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "tv", op: "power", on: true },
      }),
    );
  });

  it("output picker: opens by itself without an output, up / down + Enter choose, Back changes nothing, F-keys are quick outputs", async () => {
    const r = liveResult();
    const outputs = [
      { entity_id: "media_player.ma_amp_dlna", name: "R-N500", state: "idle" },
      { entity_id: "media_player.ma_amp_airplay", name: "R-N500 AirPlay", state: "off" },
      { entity_id: "media_player.ma_kitchen", name: "Kitchen", state: "idle" },
    ];
    r.snapshot!.output = {
      entity: null,
      name: null,
      valid: false,
      outputs,
      keys: ["media_player.ma_amp_dlna", "none", "media_player.ma_kitchen", "none"],
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1"); // music: no output yet, so the picker first
    let picker = screen.getByRole("dialog", { name: "Play music on" });
    expect(picker.textContent).toContain("No output chosen yet");
    const options = () => Array.from(picker.querySelectorAll('[role="option"]'));
    expect(options().map((o) => o.querySelector("strong")?.textContent)).toEqual([
      "R-N500",
      "R-N500 AirPlay",
      "Kitchen",
    ]);
    // the legend row: the quick outputs on F1 / F3
    expect(
      Array.from(picker.querySelectorAll("[data-soft-key]")).map((b) => b.textContent),
    ).toEqual(["R-N500", "\u00a0", "Kitchen", "\u00a0"]);
    press("ArrowDown");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    // Back: closes with no change (it opened by itself, so back to the Media tab)
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
    // again; Enter on the second row plays there from now on and lands on the music screen
    press("F1");
    picker = screen.getByRole("dialog", { name: "Play music on" });
    press("ArrowDown");
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output", entity: "media_player.ma_amp_airplay" },
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Play music on" })).toBeNull();
  });

  it("output chosen: the music screen has Radio / Library / Output / Playlist, F3 opens the picker on the current one, a quick key switches", async () => {
    const r = liveResult();
    r.snapshot!.amp.source = "SERVER";
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    r.snapshot!.output = {
      entity: "media_player.ma_amp_dlna",
      name: "R-N500",
      valid: true,
      outputs: [
        { entity_id: "media_player.ma_amp_dlna", name: "R-N500", state: "playing" },
        { entity_id: "media_player.ma_kitchen", name: "Kitchen", state: "idle" },
      ],
      keys: ["media_player.ma_amp_dlna", "media_player.ma_kitchen", "none", "none"],
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    await waitFor(() => expect(screen.getByTitle("Open music").textContent).toContain("On R-N500"));
    press("F1");
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(Array.from(now.querySelectorAll("[data-soft-key]")).map((b) => b.textContent)).toEqual([
      "Radio",
      "Library",
      "Output",
      "\u00a0",
    ]);
    expect(now.textContent).toContain("R-N500");
    press("F3");
    const picker = screen.getByRole("dialog", { name: "Play music on" });
    expect(picker.querySelector('[aria-selected="true"]')?.textContent).toContain("R-N500");
    press("F2"); // quick key: Kitchen
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output", entity: "media_player.ma_kitchen" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("music through HA never powers the amp: Music on the key, no power-on on entering, no Power on on F4 (task 015)", async () => {
    const r = liveResult();
    r.snapshot!.amp = { ...r.snapshot!.amp, on: false, state: "off" };
    r.snapshot!.nowPlaying = {
      ...r.snapshot!.nowPlaying,
      kind: "none",
      station: null,
      title: null,
    };
    r.snapshot!.radio = null;
    r.snapshot!.output = {
      entity: "media_player.ma_amp_dlna",
      name: "R-N500",
      valid: true,
      outputs: [{ entity_id: "media_player.ma_amp_dlna", name: "R-N500", state: "off" }],
      keys: ["media_player.ma_amp_dlna", "none", "none", "none"],
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    const footer = screen.getByRole("contentinfo");
    expect(footer.querySelector("[data-soft-key]")?.textContent).toBe("Music");
    press("F1");
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(Array.from(now.querySelectorAll("[data-soft-key]")).map((b) => b.textContent)).toEqual([
      "Radio",
      "Library",
      "Output",
      "\u00a0",
    ]);
    expect(now.textContent).toContain("Playing something turns it on"); // no "right-hand button" hint
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.startAmpPowerOn).not.toHaveBeenCalled();
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
  });

  it("output picker keys may run scripts: the legend shows the script's name, the key runs it and returns (task 015)", async () => {
    const r = liveResult();
    r.snapshot!.output = {
      entity: "media_player.ma_kitchen",
      name: "Kitchen",
      valid: true,
      outputs: [
        { entity_id: "media_player.ma_amp_dlna", name: "R-N500", state: "off" },
        { entity_id: "media_player.ma_kitchen", name: "Kitchen", state: "idle" },
      ],
      keys: ["script.amp_dlna", "media_player.ma_kitchen", "none", "none"],
    };
    r.snapshot!.keyLabels = { "script.amp_dlna": "Amp over DLNA" };
    r.snapshot!.amp.source = "SERVER";
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    press("F3");
    const picker = screen.getByRole("dialog", { name: "Play music on" });
    expect(
      Array.from(picker.querySelectorAll("[data-soft-key]")).map((b) => b.textContent),
    ).toEqual(["Amp over DLNA", "Kitchen", "\u00a0", "\u00a0"]);
    press("F1");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "script", entity: "script.amp_dlna" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  it("opens the active source's screen from the amp card: the radio for NET RADIO, the amp view for the turntable", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    const fullBefore = fullGen();
    act(() => screen.getByTitle("פתח מוזיקה").click());
    // NET RADIO plays: straight to the radio screen, no generic now-playing screen in between.
    expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible();
    // A screen change is a full-refresh event for the e-ink (the counter may step more than once
    // when several keys change in the same render; the bridge flashes once per new value).
    expect(fullGen()).toBeGreaterThan(fullBefore);
    // The radio has no back key: a tab key closes it (the shell then switches the tab).
    press("PageDown");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("amp view for the turntable: volume on up / down, no library key, Enter and right / left do nothing", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(phonoResult());
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1");
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(dialog).toBeVisible();
    expect(dialog.querySelector(".amp-title")?.textContent).toBe("PHONO"); // the receiver's title (task 015)
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
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1"); // music (the amp on the turntable)
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3"); // source list
    const list = screen.getByRole("listbox", { name: "מקור" });
    const rows = list.querySelectorAll('[role="option"]');
    // The receiver's inputs in its own order (its node's live source_list), names from the node's rows (task 015).
    // Five rows at a time, the window around the cursor (it starts on the current source, PHONO).
    expect(Array.from(rows).map((r) => r.querySelector("strong")?.textContent)).toEqual([
      "NET RADIO",
      "SERVER",
      "AirPlay",
      "TUNER",
      "PHONO",
    ]);
    expect(rows[4]).toHaveAttribute("aria-selected", "true");
    press("ArrowDown"); // the window moves on: CD, renamed by the node's inputs row
    const shown = screen.getAllByRole("option");
    expect(shown.map((r) => r.querySelector("strong")?.textContent).at(-1)).toBe(
      "בלוטות׳ וטלוויזיה",
    );
    expect(shown.at(-1)).toHaveAttribute("aria-selected", "true");
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.source", source: "CD" },
      }),
    );
    // A plain input goes back to the amp view; SERVER / NET RADIO would open their screens.
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3");
    // The snapshot still says PHONO (the mock returned no new one), so the cursor is on PHONO.
    expect(screen.getAllByRole("option")[4]).toHaveAttribute("aria-selected", "true");
    // Cancel returns to where the list was opened from.
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
    press("F3");
    for (let i = 0; i < 4; i++) press("ArrowUp");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.source", source: "NET RADIO" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "רדיו" })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".radio-dial")).not.toBeNull());
    // F3 on the radio is the source list again.
    press("F3");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
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
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
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
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    const snapshots = mocks.getMediaSnapshot.mock.calls.length;
    press("F1"); // opening music while the amp is off starts the routine
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
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    const before = mocks.getMediaSnapshot.mock.calls.length;
    press("F1"); // amp view: fresh snapshot right away, not at the next 10 s poll
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
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1");
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
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1");
    await waitFor(() => expect(mocks.getPowerOnStatus).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "תצוגת המגבר" }).textContent).not.toContain(
        "מדליק את המגבר",
      ),
    );
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("amp off: F3 reads Power on and starts the routine, the card shows the step, the amp view has Power on in F4", async () => {
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
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    const footer = screen.getByRole("contentinfo");
    const slots = () =>
      Array.from(footer.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    await waitFor(() => expect(slots()).toEqual(["Power on", "Amplifier", "TV", "\u00a0"]));
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".media-cards button"));
    expect(cards[0]?.textContent).toContain("Off");
    press("F1");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: {} }));
    const dialog = screen.getByRole("dialog", { name: "Amplifier view" });
    await waitFor(() => expect(dialog.textContent).toContain("Waiting for the amplifier…"));
    // The card under the view follows the routine: state line = the routine, body = the step.
    expect(cards[0]?.textContent).toContain("Turning the amplifier on");
    expect(cards[0]?.textContent).toContain("Waiting for the amplifier…");
    // Amp view footer: Back, blank, Source, Power on — drawn pressed while the routine runs.
    const modalSlots = Array.from(dialog.querySelectorAll("[data-soft-key]"));
    expect(modalSlots.map((b) => b.textContent)).toEqual(["Back", "\u00a0", "Source", "Power on"]);
    expect(modalSlots[3]?.getAttribute("aria-pressed")).toBe("true");
    expect(footer.querySelector('[data-soft-key="F1"]')?.getAttribute("aria-pressed")).toBe("true");
    // The failed routine shows its error on the card.
    mocks.getPowerOnStatus.mockResolvedValue({
      ...waiting,
      running: false,
      step: "failed",
      error: "Amp did not come up",
      updatedAt: Date.now(),
    });
    // The status arrives with the routine's 2 s poll.
    await waitFor(() => expect(cards[0]?.textContent).toContain("Amp did not come up"), {
      timeout: 4000,
    });
    expect(cards[0]?.textContent).toContain("Power-on failed");
  });

  it("an amp nobody can reach (plug on) reads as off with the reason, and F4 on the amp view powers it on", async () => {
    const unknown = liveResult();
    unknown.snapshot!.amp = {
      ...unknown.snapshot!.amp,
      on: false,
      available: false,
      state: "unavailable",
      source: null,
    };
    mocks.getMediaSnapshot.mockResolvedValue(unknown);
    mocks.startAmpPowerOn.mockResolvedValue({ ok: false, error: "nope" });
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".media-cards button"));
    await waitFor(() => expect(cards[0]?.textContent).toContain("Off"));
    expect(cards[0]?.textContent).not.toContain("Unavailable");
    press("F1");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledTimes(1));
    const dialog = screen.getByRole("dialog", { name: "Amplifier view" });
    // "Turning on…" shows at once (optimistic); the refusal drops it again.
    await waitFor(() => expect(dialog.textContent).toContain("The amplifier is off"));
    expect(dialog.textContent).toContain("Power on: the right-hand button");
    expect(dialog.textContent).toContain("No answer from the amplifier (plug on)");
    press("F4");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledTimes(2));
  });

  it("shows Turning on… the moment the power-on key is pressed, before the server answers (Q13)", async () => {
    const off = liveResult();
    off.snapshot!.amp = { ...off.snapshot!.amp, on: false, state: "off", source: null };
    mocks.getMediaSnapshot.mockResolvedValue(off);
    let answer: (v: unknown) => void = () => {};
    mocks.startAmpPowerOn.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mocks.getPowerOnStatus.mockResolvedValue(null); // a poll that ran before the server registered the start
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledTimes(1));
    const dialog = screen.getByRole("dialog", { name: "Amplifier view" });
    await waitFor(() => expect(dialog.textContent).toContain("Turning on…"));
    answer({ ok: false, error: "nope" });
    await waitFor(() => expect(dialog.textContent).toContain("The amplifier is off"));
  });

  it("fetches a fresh snapshot the moment the tab becomes active again", async () => {
    const r = renderPanel("en", false);
    await waitFor(() => expect(mocks.getMediaSnapshot).toHaveBeenCalledTimes(1));
    r.setActive(true);
    await waitFor(() => expect(mocks.getMediaSnapshot).toHaveBeenCalledTimes(2));
    r.setActive(false);
    r.setActive(true);
    await waitFor(() => expect(mocks.getMediaSnapshot).toHaveBeenCalledTimes(3));
  });

  it("a stale snapshot does not decide where the amp opens: the amp view refetches, then routes", async () => {
    // Polling died for two idle polls while the amp went to standby; the last snapshot still says
    // NET RADIO on (2026-10-15: a 30-min-old "on" opened the amp view with no way to power on).
    vi.useFakeTimers({ toFake: ["Date"] });
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    mocks.getMediaSnapshot.mockResolvedValue(off);
    const later = Date.now() + 121_000;
    const plug = {
      running: true,
      step: "plug" as const,
      startedAt: later,
      updatedAt: later,
      elapsedMs: 0,
      source: null,
    };
    mocks.startAmpPowerOn.mockResolvedValue({ ok: true, status: plug });
    mocks.getPowerOnStatus.mockResolvedValue(plug);
    vi.setSystemTime(later);
    press("F1");
    // Not the radio screen the stale "NET RADIO on" would have opened: the amp view, which refetches.
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Radio" })).toBeNull();
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: {} }));
  });
});
