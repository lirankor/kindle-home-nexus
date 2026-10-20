import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { RADIO_LISTS, demoMediaSnapshot, demoMusicList, demoRadioLists } from "@/lib/media";
import type { MusicTab } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import type { MediaSnapshotResult, RadioListsResult } from "@/lib/media";
import { bandLabel } from "@/lib/radio-dial";

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
    let picker = screen.getByRole("dialog", { name: "Players" });
    expect(picker.textContent).toContain("No player chosen yet");
    const options = () => Array.from(picker.querySelectorAll('[role="option"]'));
    expect(options().map((o) => o.querySelector("strong")?.textContent)).toEqual([
      "R-N500",
      "R-N500 AirPlay",
      "Kitchen",
    ]);
    // the legend row: the quick outputs on F1 / F3
    expect(
      Array.from(picker.querySelectorAll("[data-soft-key]")).map((b) => b.textContent),
    ).toEqual(["R-N500", "Sync", "Kitchen", "Move here"]); // free keys: move (task 021), sync (task 022)
    press("ArrowDown");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    // Back: closes with no change (it opened by itself, so back to the Media tab)
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
    // again; Enter on the second row plays there from now on and lands on the music screen
    press("F1");
    picker = screen.getByRole("dialog", { name: "Players" });
    press("ArrowDown");
    press("Enter");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output", entity: "media_player.ma_amp_airplay" },
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Players" })).toBeNull();
  });

  it("picker = MA's players (task 021): state + what plays, unexposed rows not selectable, Right / Move here moves the music", async () => {
    const r = liveResult();
    r.snapshot!.output = {
      entity: "media_player.ma_amp_airplay",
      name: "R-N500 AirPlay",
      valid: true,
      outputs: [
        {
          entity_id: "media_player.ma_amp_airplay",
          name: "R-N500 AirPlay",
          state: "playing",
          now: "Holiday · Scorpions",
          kind: "player",
          exposed: true,
        },
        {
          entity_id: "media_player.ma_amp_dlna",
          name: "R-N500 DLNA",
          state: "idle",
          now: null,
          kind: "player",
          exposed: true,
        },
        {
          entity_id: "media_player.ma_house",
          name: "Whole house",
          state: "idle",
          now: null,
          kind: "group",
          exposed: true,
        },
      ],
      unexposed: [
        {
          entity_id: "ma:updcd23cf6",
          name: "TV",
          state: "idle",
          now: null,
          kind: "player",
          exposed: false,
        },
      ],
      keys: ["media_player.ma_amp_dlna", "none", "none", "none"],
      moving: null,
      playingElsewhere: null,
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    press("F3"); // Output
    const picker = screen.getByRole("dialog", { name: "Players" });
    const rows = () => Array.from(picker.querySelectorAll('[role="option"]'));
    expect(rows().map((o) => o.textContent)).toEqual([
      expect.stringContaining("Holiday · Scorpions"),
      expect.stringContaining("R-N500 DLNA"),
      expect.stringContaining("group"),
      expect.stringContaining("not in Home Assistant"),
    ]);
    // bus task 023: "now-playing · state" (the check mark, not a word, marks the current output)
    expect(rows()[0]?.textContent).toContain("Holiday · Scorpions · Playing");
    expect(rows()[0]).toHaveAttribute("data-current", "true");
    // the unexposed TV: Enter changes nothing
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
    // Right on the DLNA row moves AirPlay's music there
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output.move", entity: "media_player.ma_amp_dlna" },
      }),
    );
  });

  it("sync groups in the picker (task 022): members under the leader with a link, Sync / Unsync key, Left = sync, group label", async () => {
    const r = liveResult();
    const row = (entity_id: string, name: string, extra: Record<string, unknown> = {}) => ({
      entity_id,
      name,
      state: "idle",
      now: null,
      kind: "player" as const,
      exposed: true,
      groupWith: [] as string[],
      groupMembers: [] as string[],
      syncedTo: null as string | null,
      ...extra,
    });
    const AIR = "media_player.ma_amp_airplay";
    const TV = "media_player.tv_3";
    const PIX = "media_player.pixel_phone";
    r.snapshot!.output = {
      entity: AIR,
      name: "R-N500 AirPlay",
      groupName: "R-N500 AirPlay + TV",
      valid: true,
      outputs: [
        row(PIX, "Pixel phone", { groupWith: [AIR, TV] }),
        row(AIR, "R-N500 AirPlay", {
          state: "playing",
          now: "Holiday · Scorpions",
          groupWith: [TV, PIX],
          groupMembers: [AIR, TV],
        }),
        row(TV, "TV", { state: "playing", groupWith: [AIR, PIX], syncedTo: AIR }),
        row("media_player.ma_amp_dlna", "R-N500 DLNA"),
      ],
      unexposed: [],
      keys: ["media_player.ma_amp_dlna", "none", "none", "none"],
      moving: null,
      playingElsewhere: null,
      moveError: null,
    };
    r.snapshot!.amp = { ...r.snapshot!.amp, source: "SERVER", state: "on" };
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    expect(screen.getByRole("dialog").textContent).toContain("R-N500 AirPlay + TV");
    press("F3"); // Output
    const picker = screen.getByRole("dialog", { name: "Players" });
    const rows = () => Array.from(picker.querySelectorAll('[role="option"]'));
    const legend = () =>
      Array.from(picker.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);
    expect(rows()[2]).toHaveAttribute("data-member", "true");
    expect(rows()[2]?.textContent).toContain("in sync with R-N500 AirPlay");
    expect(rows()[2]?.querySelector(".source-row-link")).not.toBeNull();
    // cursor on the current output (the leader): no sync for itself
    expect(legend()).toEqual(["R-N500 DLNA", "\u00a0", "Sync", "Move here"]);
    press("ArrowDown"); // TV, a member: Unsync
    expect(legend()[2]).toBe("Unsync");
    press("F3");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output.sync", entity: TV, join: false },
      }),
    );
    // Pixel phone (can sync): Left joins it to AirPlay's group
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowLeft");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "output.sync", entity: PIX, join: true },
      }),
    );
  });

  it("picker rows (task 023): one status line trimmed to fit, link glyph on the icon side, five rows a page", async () => {
    const r = liveResult();
    const AIR = "media_player.ma_amp_airplay";
    const PIX = "media_player.pixel_phone";
    const row = (entity_id: string, name: string, extra: Record<string, unknown> = {}) => ({
      entity_id,
      name,
      state: "idle",
      now: null,
      kind: "player" as const,
      exposed: true,
      groupWith: [] as string[],
      groupMembers: [] as string[],
      syncedTo: null as string | null,
      ...extra,
    });
    r.snapshot!.output = {
      entity: AIR,
      name: "R-N500 AirPlay",
      valid: true,
      outputs: [
        row(AIR, "R-N500 AirPlay", {
          state: "playing",
          now: "John I Love You · Sinéad O'Connor",
          nowParts: {
            title: "John I Love You",
            artist: "Sinéad O'Connor",
            album: "I Do Not Want What I Haven't Got",
          },
          groupMembers: [AIR, PIX],
        }),
        row(PIX, "Pixel phone", { state: "playing", syncedTo: AIR }),
        ...["A", "B", "C", "D", "E"].map((n) =>
          row(`media_player.spk_${n.toLowerCase()}`, `Speaker ${n}`),
        ),
      ],
      unexposed: [],
      keys: ["none", "none", "none", "none"],
      moving: null,
      playingElsewhere: null,
      moveError: null,
    };
    r.snapshot!.amp = { ...r.snapshot!.amp, source: "SERVER", state: "on" };
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    press("F3"); // Output
    const picker = screen.getByRole("dialog", { name: "Players" });
    const rows = () => Array.from(picker.querySelectorAll('[role="option"]'));
    expect(rows()).toHaveLength(5);
    expect(picker.querySelector(".modal-heading")?.textContent).toContain("1/2");
    // album and artist dropped to fit the line budget (40): title · state
    const status = rows()[0]!.querySelector(".source-row-text > span")!.textContent!;
    expect(status).toBe("John I Love You · Playing");
    // the member: link glyph first (the icon side), then its icon
    const member = rows()[1]!;
    expect(member).toHaveAttribute("data-member", "true");
    expect(member.firstElementChild).toHaveClass("source-row-link");
    expect(member.children[1]).toHaveClass("source-row-icon");
    // down past the fifth row: page 2 with the last two
    for (let i = 0; i < 5; i++) press("ArrowDown");
    expect(rows().map((o) => o.querySelector("strong")?.textContent)).toEqual([
      "Speaker D",
      "Speaker E",
    ]);
    expect(picker.querySelector(".modal-heading")?.textContent).toContain("2/2");
  });

  it("a refused move (task 022): the output label stays and the music screen shows HA's reason", async () => {
    const r = liveResult();
    r.snapshot!.output = {
      entity: "media_player.ma_amp_airplay",
      name: "R-N500 AirPlay",
      valid: true,
      outputs: [
        {
          entity_id: "media_player.ma_amp_airplay",
          name: "R-N500 AirPlay",
          state: "playing",
          kind: "player",
          exposed: true,
        },
        {
          entity_id: "media_player.ma_amp_dlna",
          name: "R-N500 DLNA",
          state: "idle",
          kind: "player",
          exposed: true,
        },
      ],
      unexposed: [],
      keys: ["none", "none", "none", "none"],
      moving: null,
      playingElsewhere: null,
      moveError: {
        name: "R-N500 DLNA",
        error: "Cannot move: the receiver is busy (movie mode)",
        at: Date.now(),
      },
    };
    r.snapshot!.amp = { ...r.snapshot!.amp, source: "SERVER", state: "on" };
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    const now = screen.getByRole("dialog");
    expect(now.textContent).toContain("Cannot move: the receiver is busy (movie mode)");
    expect(now.textContent).toContain("R-N500 AirPlay");
  });

  it("the music screen follows its output: idle DLNA while AirPlay plays shows the hint line (task 021)", async () => {
    const r = liveResult();
    r.snapshot!.output = {
      entity: "media_player.ma_amp_dlna",
      name: "R-N500 DLNA",
      valid: true,
      outputs: [
        {
          entity_id: "media_player.ma_amp_airplay",
          name: "R-N500 AirPlay",
          state: "playing",
          now: "Holiday · Scorpions",
          kind: "player",
          exposed: true,
        },
        {
          entity_id: "media_player.ma_amp_dlna",
          name: "R-N500 DLNA",
          state: "idle",
          now: null,
          kind: "player",
          exposed: true,
        },
      ],
      unexposed: [],
      keys: ["media_player.ma_amp_dlna", "none", "none", "none"],
      moving: null,
      playingElsewhere: {
        entity: "media_player.ma_amp_airplay",
        name: "R-N500 AirPlay",
        now: "Holiday · Scorpions",
      },
    };
    r.snapshot!.amp = { ...r.snapshot!.amp, source: "SERVER", state: "on" };
    r.snapshot!.nowPlaying = {
      ...r.snapshot!.nowPlaying,
      kind: "music",
      title: null,
      station: null,
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    const now = screen.getByRole("dialog");
    expect(now.textContent).toContain("R-N500 AirPlay is playing · F3 to switch");
  });

  it("output chosen: the music screen has (Playlist) / Library / Player, no Radio, F3 opens the picker on the current one, a quick key switches", async () => {
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
      "\u00a0", // no queue: F1 empty; no radio key (bus task 025)
      "Library",
      "Player",
      "\u00a0",
    ]);
    expect(now.textContent).toContain("R-N500");
    press("F3");
    const picker = screen.getByRole("dialog", { name: "Players" });
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
      "\u00a0", // no queue: F1 empty; no radio key (bus task 025)
      "Library",
      "Player",
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
    const picker = screen.getByRole("dialog", { name: "Players" });
    expect(
      Array.from(picker.querySelectorAll("[data-soft-key]")).map((b) => b.textContent),
    ).toEqual(["Amp over DLNA", "Kitchen", "Sync", "Move here"]);
    press("F1");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "script", entity: "script.amp_dlna" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Amplifier view" })).toBeVisible();
  });

  // ---- bus task 025: the MA controller is MA only; the dial is the amp's NET RADIO, reached from the amp node ----
  /** Music through HA: an output (R-N500 AirPlay), the amp node with the bridge's station select. */
  const haResult = (nodeSource: string): MediaSnapshotResult => {
    const r = liveResult();
    r.snapshot!.output = {
      entity: "media_player.ma_amp_airplay",
      name: "R-N500 AirPlay",
      valid: true,
      outputs: [
        { entity_id: "media_player.ma_amp_airplay", name: "R-N500 AirPlay", state: "idle" },
      ],
      keys: ["none", "none", "none", "none"],
    };
    r.snapshot!.nodes![0] = { ...r.snapshot!.nodes![0]!, source: nodeSource, stations: [] };
    // the projection: AirPlay is MA's path and reads SERVER, NET RADIO stays NET RADIO
    r.snapshot!.amp.source = nodeSource === "AirPlay" ? "SERVER" : nodeSource;
    return r;
  };
  /** The HA backend's dial lists: the bridge's groups only, no favourites band. */
  const haLists = (): RadioListsResult => {
    const r = demoRadioLists();
    return { ...r, configured: true, lists: r.lists.filter((l) => l.id !== "favourites") };
  };
  const keysOf = (el: Element) =>
    Array.from(el.querySelectorAll("[data-soft-key]")).map((b) => b.textContent);

  it("music screen keys through HA: F1 Playlist when the player has a queue, F2 Library, F3 Player, F4 empty, no Radio (bus task 025)", async () => {
    const r = haResult("AirPlay");
    r.snapshot!.nowPlaying = { ...r.snapshot!.nowPlaying, kind: "music", station: null };
    r.snapshot!.queue = {
      title: "Eagles",
      index: 0,
      count: 3,
      track: null,
      positionMs: 0,
      durationMs: 0,
      status: "playing",
      prevTrack: null,
      nextTracks: [],
      stall: null,
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    renderPanel("he");
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1");
    const now = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(keysOf(now)).toEqual(["רשימת השמעה", "ספריה", "נגן", "\u00a0"]);
    press("F3");
    expect(screen.getByRole("dialog", { name: "נגנים" })).toBeVisible();
  });

  it("the music key never opens the dial, and the music screen says the amp is on NET RADIO with the Media key of the amp node (bus task 025)", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(haResult("NET RADIO"));
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    const now = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(screen.queryByRole("dialog", { name: "Radio" })).toBeNull();
    expect(now.querySelector(".amp-sub2")?.textContent).toBe(
      "Amp on NET RADIO · Amplifier → F2 on Media",
    );
    expect(keysOf(now)).not.toContain("Radio");
  });

  it("the amp node opens on the dial while NET RADIO plays; the dial has the amp's bands only, its volume, and Back returns to the amp node (bus task 025)", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(haResult("NET RADIO"));
    mocks.getRadioLists.mockResolvedValue(haLists());
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open Amplifier")).toBeVisible());
    press("F2"); // the amp node: on NET RADIO, so straight onto the dial
    const radio = screen.getByRole("dialog", { name: "Radio" });
    const first = bandLabel("en", RADIO_LISTS[0]!.id, haLists().lists);
    await waitFor(() => expect(keysOf(radio)[0]).toBe(first));
    // no favourites heart (F2), no MA player key (F3)
    expect(keysOf(radio)).toEqual([first, "\u00a0", "\u00a0", "Station list"]);
    press("F1"); // the band picker: the bridge's groups, no Favourites
    const bands = document.querySelector(".full-modal");
    expect(bands?.textContent).toContain(first);
    expect(bands?.textContent).not.toContain("Favourites");
    press("Escape");
    press("ArrowUp"); // the amp node's volume, not the MA player's
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "node", id: "amp", op: "volume", delta: 1 },
      }),
    );
    press("Escape"); // Back: the amp node screen, not the music screen, and not the dial again
    const node = screen.getByRole("dialog", { name: "Device" });
    expect(node.querySelector("h1")?.textContent).toBe("Amplifier");
    expect(keysOf(node)).toEqual(["Back", "Source", "Stream DLNA", "On / Off"]);
    press("F2"); // the source list; NET RADIO opens the dial and switches nothing yet
    press("Enter");
    expect(screen.getByRole("dialog", { name: "Radio" })).toBeVisible();
    expect(mocks.runMediaAction).not.toHaveBeenCalledWith({
      data: { type: "node", id: "amp", op: "source", source: "NET RADIO" },
    });
    press("Escape");
    expect(screen.getByRole("dialog", { name: "Device" })).toBeVisible();
  });

  it("MA radio over AirPlay is not the dial's station: the amp node opens on its screen, the dial does not follow MA, Enter tunes the needle's station (bus task 025)", async () => {
    const r = haResult("AirPlay");
    const other = RADIO_LISTS[0]!.stations[2]!;
    r.snapshot!.nowPlaying = {
      ...r.snapshot!.nowPlaying,
      kind: "radio",
      station: other.name,
      stationId: other.id,
    };
    r.snapshot!.radio = null;
    mocks.getMediaSnapshot.mockResolvedValue(r);
    mocks.getRadioLists.mockResolvedValue(haLists());
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open Amplifier")).toBeVisible());
    press("F2");
    expect(screen.getByRole("dialog", { name: "Device" })).toBeVisible();
    press("F2"); // source list
    const list = screen.getByRole("listbox", { name: "Source" });
    const rows = Array.from(list.querySelectorAll("strong")).map((x) => x.textContent);
    // cursor starts on AirPlay; walk up to NET RADIO
    for (let i = rows.indexOf("AirPlay"); i > rows.indexOf("NET RADIO"); i--) press("ArrowUp");
    press("Enter");
    const radio = screen.getByRole("dialog", { name: "Radio" });
    await waitFor(() => expect(keysOf(radio)[3]).toBe("Station list"));
    await waitFor(() =>
      expect(document.querySelectorAll(".radio-dial rect").length).toBeGreaterThan(0),
    );
    expect(radio.querySelector(".radio-now-name")?.textContent).toBe("Nothing is playing");
    press("Enter"); // the amp is not on NET RADIO: tune the station under the needle (first of the first band)
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenCalledWith({
        data: { list: RADIO_LISTS[0]!.id, index: 0 },
      }),
    );
    expect(mocks.runMediaAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "radio.playback" }) }),
    );
  });

  // ---- bus task 026: the stream quality badge; the dial reads the amp node ----
  const FLAC = {
    codec: "flac",
    sample_rate: 44100,
    bit_depth: 16,
    bit_rate: 1086,
    lossless: true,
    realtime: false,
  };
  /** Music through HA playing a queue item with this stream quality. */
  const qualityResult = (quality: Record<string, unknown> | null): MediaSnapshotResult => {
    const r = haResult("AirPlay");
    r.snapshot!.nowPlaying = {
      ...r.snapshot!.nowPlaying,
      kind: "music",
      station: null,
      quality: quality as never,
    };
    r.snapshot!.queue = {
      title: "Eagles",
      index: 0,
      count: 3,
      track: null,
      positionMs: 0,
      durationMs: 0,
      status: "playing",
      prevTrack: null,
      nextTracks: [],
      stall: null,
    };
    return r;
  };
  const badgeOf = (el: Element) => el.querySelector(".quality-badge");

  it("the music screen shows the stream quality badge under the volume dB: HQ FLAC 44.1/16, no Hi-Res (bus task 026)", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(qualityResult(FLAC));
    renderPanel("he");
    await waitFor(() => expect(screen.getByTitle("פתח מוזיקה")).toBeVisible());
    press("F1");
    const now = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    const badge = badgeOf(now)!;
    expect(badge.querySelector(".quality-tier strong")?.textContent).toBe("HQ");
    expect(badge.querySelector(".quality-detail")?.textContent).toBe("FLAC 44.1/16");
    expect(badge.querySelector(".quality-tier small")).toBeNull();
    // placement: the volume's column, right under its dB reading
    expect(badge.parentElement?.querySelector(".transport-db")).not.toBeNull();
    expect(badge.previousElementSibling?.classList.contains("transport-db")).toBe(true);
    expect(badge.getAttribute("dir")).toBe("ltr");
    // the queue screen keeps two-line rows: no badge there
    press("F1");
    const queue = screen.getByRole("dialog", { name: "רשימת השמעה" });
    expect(badgeOf(queue)).toBeNull();
  });

  it("Hi-Res FLAC reads HQ with the Hi-Res caption; a lossy 320k track SQ; a radio stream without a rate LQ (bus task 026)", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(
      qualityResult({ ...FLAC, sample_rate: 96000, bit_depth: 24, bit_rate: 4000 }),
    );
    const view = renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    let badge = badgeOf(screen.getByRole("dialog", { name: "Amplifier view" }))!;
    expect(badge.querySelector(".quality-tier")?.textContent).toBe("HQHi-Res");
    expect(badge.querySelector(".quality-detail")?.textContent).toBe("FLAC 96/24");
    view.unmount();

    mocks.getMediaSnapshot.mockResolvedValue(
      qualityResult({ ...FLAC, codec: "mp3", lossless: false, bit_rate: 320 }),
    );
    const v2 = renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    badge = badgeOf(screen.getByRole("dialog", { name: "Amplifier view" }))!;
    expect(badge.getAttribute("data-tier")).toBe("SQ");
    expect(badge.querySelector(".quality-detail")?.textContent).toBe("MP3 320k");
    v2.unmount();

    const radio = qualityResult({
      codec: null,
      sample_rate: 44100,
      bit_depth: 16,
      bit_rate: null,
      lossless: false,
      realtime: true,
    });
    radio.snapshot!.nowPlaying = {
      ...radio.snapshot!.nowPlaying,
      kind: "radio",
      station: "100FM Israeli",
      stationId: "ma:100fm-israeli",
    };
    radio.snapshot!.queue = null;
    mocks.getMediaSnapshot.mockResolvedValue(radio);
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    badge = badgeOf(screen.getByRole("dialog", { name: "Amplifier view" }))!;
    expect(badge.getAttribute("data-tier")).toBe("LQ");
    expect(badge.querySelector(".quality-detail")?.textContent).toBe("Stream");
  });

  it("no stream from Music Assistant: an empty badge slot (the layout stays), and no badge on the dial (bus task 026)", async () => {
    mocks.getMediaSnapshot.mockResolvedValue(qualityResult(null));
    const view = renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open music")).toBeVisible());
    press("F1");
    const badge = badgeOf(screen.getByRole("dialog", { name: "Amplifier view" }))!;
    expect(badge.getAttribute("data-empty")).toBe("true");
    expect(badge.textContent).toBe("");
    view.unmount();
    const r = qualityResult(FLAC);
    r.snapshot!.nodes![0] = { ...r.snapshot!.nodes![0]!, source: "NET RADIO", stations: [] };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    mocks.getRadioLists.mockResolvedValue(haLists());
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open Amplifier")).toBeVisible());
    press("F2");
    const dial = screen.getByRole("dialog", { name: "Radio" });
    expect(badgeOf(dial)).toBeNull();
  });

  it("the dial reads the amp node it was opened from, even with the TV as the music player: station, song, NET RADIO, the node's dB, the needle (bus task 026)", async () => {
    const r = haResult("NET RADIO");
    const station = RADIO_LISTS[0]!.stations[2]!;
    // the TV is the panel's MA player: the music projection knows nothing about the amp
    r.snapshot!.output = {
      ...r.snapshot!.output!,
      entity: "media_player.tv_3",
      name: "TV",
      outputs: [{ entity_id: "media_player.tv_3", name: "TV", state: "idle" }],
    };
    r.snapshot!.amp = { ...r.snapshot!.amp, source: null, volumeDb: null };
    r.snapshot!.nowPlaying = {
      ...r.snapshot!.nowPlaying,
      kind: "none",
      title: null,
      station: null,
      stationId: null,
    };
    r.snapshot!.radio = null;
    r.snapshot!.nodes![0] = {
      ...r.snapshot!.nodes![0]!,
      source: "NET RADIO",
      volumeDb: -41,
      stations: [{ option: `G · ${station.name}`, name: station.name, group: "G", fm: null }],
      station: `G · ${station.name}`,
      stationId: station.id,
      nowTitle: "Song Title",
      nowArtist: "Some Band",
      playing: true,
    };
    mocks.getMediaSnapshot.mockResolvedValue(r);
    mocks.getRadioLists.mockResolvedValue(haLists());
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open Amplifier")).toBeVisible());
    press("F2"); // the amp node plays NET RADIO: straight onto the dial
    const radio = screen.getByRole("dialog", { name: "Radio" });
    await waitFor(() =>
      expect(radio.querySelector(".radio-now-name")?.textContent).toBe(station.name),
    );
    expect(radio.querySelector(".radio-now-song")?.textContent).toBe("Song Title · Some Band");
    const transport = radio.querySelector(".radio-transport-row .transport")!;
    expect(transport.getAttribute("data-db")).toBe("-41");
    expect(transport.getAttribute("data-mode")).toBe("playing");
    expect(transport.querySelector(".transport-reading strong")?.textContent).toBe("NET RADIO");
    // the needle sits on the node's station
    const needle = () => document.querySelector("[data-list][data-index]");
    await waitFor(() => expect(needle()?.getAttribute("data-index")).toBe("2"));
    expect(needle()?.getAttribute("data-list")).toBe(RADIO_LISTS[0]!.id);
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
    expect(dialog.querySelector(".transport-db")?.textContent).toBe("-43.5dB");
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
