import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { demoMediaSnapshot, demoRadioLists } from "@/lib/media";
import type { MediaSnapshotResult, RadioListsResult } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import { DIAL, stationX } from "@/lib/radio-dial";

const mocks = vi.hoisted(() => ({
  getMediaSnapshot: vi.fn(),
  runMediaAction: vi.fn(),
  startAmpPowerOn: vi.fn(),
  getPowerOnStatus: vi.fn(),
  getRadioLists: vi.fn(),
  tuneRadioStation: vi.fn(),
}));
vi.mock("@/lib/media.functions", () => mocks);

const liveResult = (): MediaSnapshotResult => ({
  configured: true,
  amp: true,
  jellyfin: false,
  snapshot: demoMediaSnapshot(),
  lang: "he",
});
/** Demo lists, marked configured, with WDR 2 (local index 1) bookmarked. */
const lists = (): RadioListsResult => {
  const r = demoRadioLists();
  const wdr2 = r.lists.find((l) => l.id === "local")!.stations[1]!;
  wdr2.favourite = true;
  r.lists[0]!.stations = [{ ...wdr2 }];
  return { ...r, configured: true };
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
          <button data-testid="open-radio" onClick={() => panel.open("radio")} />
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
const dial = () => document.querySelector<SVGSVGElement>(".radio-dial");
const needleX = () => {
  const needle = dial()?.querySelector(".radio-needle");
  return needle ? Number(needle.getAttribute("x")) + DIAL.needleW / 2 : null;
};
const footerLabels = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".full-modal [data-soft-key]")).map(
    (b) => b.textContent,
  );

/** Media tab → amp view → source list (cursor on רדיו, the current source) → Enter. */
async function openRadio(lang: "he" | "en" = "he") {
  renderPanel(lang);
  const title = lang === "he" ? "פתח את המגבר" : "Open the amplifier";
  await waitFor(() => expect(screen.getByTitle(title)).toBeVisible());
  press("F3");
  press("F3");
  press("Enter");
  await waitFor(() => expect(mocks.runMediaAction).toHaveBeenCalled());
  await waitFor(() => expect(dial()).not.toBeNull());
  mocks.runMediaAction.mockClear();
}

describe("Radio screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMediaSnapshot.mockResolvedValue(liveResult());
    mocks.runMediaAction.mockResolvedValue({ ok: true });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    mocks.getRadioLists.mockResolvedValue(lists());
    mocks.tuneRadioStation.mockResolvedValue({ ok: true });
  });

  it("renders the band row, the dial with the needle on the playing station and the footer", async () => {
    await openRadio();
    const bands = Array.from(document.querySelectorAll<HTMLElement>(".radio-band"));
    expect(bands.map((b) => b.textContent)).toEqual(["מועדפים", "דיסלדורף", "ישראל", "אנגלית"]);
    expect(bands.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    // 1LIVE is local index 0: needle on the first stop, bold FM label, band name at the left end.
    expect(dial()?.getAttribute("data-list")).toBe("local");
    expect(dial()?.getAttribute("data-index")).toBe("0");
    expect(needleX()).toBe(stationX(0, 12));
    const current = dial()?.querySelector("text[data-current]");
    expect(current?.textContent).toBe("106.7");
    expect(dial()?.querySelector("text")?.textContent).toBe("דיסלדורף");
    const labels = Array.from(dial()?.querySelectorAll("text") ?? []).map((t) => t.textContent);
    expect(labels.length).toBeGreaterThanOrEqual(9);
    expect(labels).toContain("95.1");
    // Now playing block from the snapshot.
    const now = document.querySelector(".radio-now")!;
    expect(now.querySelector(".radio-now-name")?.textContent).toBe("1LIVE");
    expect(now.querySelector(".radio-now-song")?.textContent).toBe("Zara Larsson - Memory Lane");
    expect(now.querySelector(".radio-now-detail")?.textContent).toBe("128k · MP3");
    expect(now.querySelector(".radio-now-db")?.textContent).toBe("-44.5dB");
    expect(now.querySelector("img")?.getAttribute("src")).toBe("/media/img?station=1live&w=96");
    expect(footerLabels()).toEqual(["חזרה", "רשימה", "מועדפים", "הפעלה / כיבוי"]);
    expect(document.documentElement.getAttribute("data-eink-refresh")).toBe("full");
  });

  it("tunes the neighbour on left / right with wrap-around and moves the needle optimistically", async () => {
    await openRadio();
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.tuneRadioStation.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenCalledWith({ data: { list: "local", index: 1 } }),
    );
    // Optimistic: needle and name move before the server answers.
    expect(needleX()).toBe(stationX(1, 12));
    expect(document.querySelector(".radio-now-name")?.textContent).toBe("WDR 2");
    expect(document.querySelector(".radio-now-img, .radio-now img")?.getAttribute("src")).toBe(
      "/media/img?station=wdr-2&w=96",
    );
    await act(async () => settle({ ok: true }));
    // Wrap at the start: left from index 1 → 0 → 11.
    press("ArrowLeft");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenLastCalledWith({
        data: { list: "local", index: 0 },
      }),
    );
    press("ArrowLeft");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenLastCalledWith({
        data: { list: "local", index: 11 },
      }),
    );
    expect(needleX()).toBe(stationX(11, 12));
    // And at the end: right from 11 → 0.
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenLastCalledWith({
        data: { list: "local", index: 0 },
      }),
    );
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
  });

  it("reverts the needle when the tune fails", async () => {
    await openRadio();
    mocks.tuneRadioStation.mockResolvedValueOnce({ ok: false, error: "Amp is off" });
    press("ArrowRight");
    await waitFor(() => expect(mocks.tuneRadioStation).toHaveBeenCalled());
    await waitFor(() => expect(needleX()).toBe(stationX(0, 12)));
    expect(document.querySelector(".radio-now-name")?.textContent).toBe("1LIVE");
  });

  it("steps the volume on up / down like the amp view", async () => {
    await openRadio();
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.runMediaAction.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("ArrowUp");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.volume.step", delta: 1 },
      }),
    );
    expect(document.querySelector(".radio-now-db")?.textContent).toBe("-42.5dB");
    await act(async () => settle({ ok: true }));
    press("ArrowDown");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.volume.step", delta: -1 },
      }),
    );
    expect(mocks.tuneRadioStation).not.toHaveBeenCalled();
  });

  it("opens the station list on Enter, tunes the highlighted row and comes back to the dial", async () => {
    await openRadio();
    press("Enter");
    const list = screen.getByRole("listbox", { name: "תחנות" });
    const rows = Array.from(list.querySelectorAll('[role="option"]'));
    expect(rows).toHaveLength(8);
    expect(rows[0]?.querySelector("strong")?.textContent).toBe("1LIVE");
    expect(rows[0]?.querySelector(".radio-row-detail")?.textContent).toBe("128k MP3");
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(rows[0]?.querySelector("img")?.getAttribute("src")).toBe(
      "/media/img?station=1live&w=48",
    );
    expect(footerLabels()).toEqual(["חזרה", "\u00a0", "\u00a0", "בחר"]);
    press("ArrowDown");
    press("ArrowDown");
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    // Page 2 after moving past row 8; PageDown jumps a page.
    press("PageDown");
    expect(screen.getByRole("dialog").textContent).toContain("2/2");
    expect(screen.getAllByRole("option")[2]?.querySelector("strong")?.textContent).toBe(
      "Deutschlandfunk Kultur",
    );
    press("PageUp");
    press("Enter");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenCalledWith({ data: { list: "local", index: 2 } }),
    );
    expect(dial()).not.toBeNull();
    expect(needleX()).toBe(stationX(2, 12));
    // F1 in the list goes back without tuning; Escape on the dial goes to the amp view.
    press("Enter");
    press("F1");
    expect(dial()).not.toBeNull();
    press("Escape");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("switches the band from the F2 picker without tuning; the first right then tunes there", async () => {
    await openRadio();
    press("F2");
    const picker = screen.getByRole("listbox", { name: "בחירת רשימה" });
    const rows = Array.from(picker.querySelectorAll('[role="option"]'));
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual([
      "מועדפים",
      "דיסלדורף",
      "ישראל",
      "אנגלית",
    ]);
    expect(rows[0]?.textContent).toContain("1 תחנות");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(dial()?.getAttribute("data-list")).toBe("english");
    expect(dial()?.getAttribute("data-index")).toBe("0");
    expect(needleX()).toBe(stationX(0, 14));
    const labels = Array.from(dial()?.querySelectorAll("text") ?? []).map((t) => t.textContent);
    expect(labels[0]).toBe("אנגלית");
    expect(labels).toContain("BBC World");
    expect(mocks.tuneRadioStation).not.toHaveBeenCalled();
    // Still playing 1LIVE until something is tuned.
    expect(document.querySelector(".radio-now-name")?.textContent).toBe("1LIVE");
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.tuneRadioStation.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (settle = resolve)),
    );
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.tuneRadioStation).toHaveBeenCalledWith({ data: { list: "english", index: 1 } }),
    );
    expect(document.querySelector(".radio-now-name")?.textContent).toBe("Classic FM");
    await act(async () => settle({ ok: true }));
    // F4 in the picker selects too; favourites band shows its one bookmark.
    press("F2");
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    press("F4");
    expect(dial()?.getAttribute("data-list")).toBe("favourites");
    expect(dial()?.querySelector("text[data-current]")?.textContent).toBe("WDR 2");
  });

  it("adds or removes the station under the needle with F3 and updates the favourites band", async () => {
    await openRadio();
    expect(
      document.querySelector('.full-modal [data-soft-key="F3"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
    // The server's lists after the add (the refetch must agree with the optimistic update).
    const after = lists();
    const live = after.lists.find((l) => l.id === "local")!.stations[0]!;
    live.favourite = true;
    after.lists[0]!.stations.push({ ...live });
    mocks.getRadioLists.mockResolvedValue(after);
    press("F3");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "radio.favourite", stationId: "1live", add: true },
      }),
    );
    // Optimistic: the key shows pressed, the favourites band lists two stations.
    expect(
      document.querySelector('.full-modal [data-soft-key="F3"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    press("F2");
    expect(screen.getAllByRole("option")[0]?.textContent).toContain("2 תחנות");
    press("Escape");
    // WDR 2 is already bookmarked: F3 on it removes.
    press("ArrowRight");
    await waitFor(() => expect(mocks.tuneRadioStation).toHaveBeenCalled());
    press("F3");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "radio.favourite", stationId: "wdr-2", add: false },
      }),
    );
  });

  it("while the amp is off: empty favourites text, and tuning starts the power-on routine into NET RADIO", async () => {
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
    mocks.getRadioLists.mockResolvedValue({ ...demoRadioLists(), configured: true });
    const now = Date.now();
    mocks.startAmpPowerOn.mockResolvedValue({
      ok: true,
      status: {
        running: true,
        step: "plug",
        startedAt: now,
        updatedAt: now,
        elapsedMs: 0,
        source: "NET RADIO",
      },
    });
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open the amplifier")).toBeVisible());
    act(() => screen.getByTestId("open-radio").click());
    await waitFor(() => expect(dial()).not.toBeNull());
    expect(dial()?.getAttribute("data-list")).toBe("local");
    expect(document.querySelector(".radio-now-name")?.textContent).toBe("The amplifier is off");
    expect(document.querySelector(".radio-now-db")?.textContent).toBe("—dB");
    // Up / down do nothing while off.
    press("ArrowUp");
    expect(mocks.runMediaAction).not.toHaveBeenCalled();
    // Favourites band is empty: text on the bar, no needle.
    press("F2");
    press("ArrowUp");
    press("Enter");
    expect(dial()?.getAttribute("data-list")).toBe("favourites");
    expect(dial()?.textContent).toContain("No favourites");
    expect(needleX()).toBeNull();
    press("ArrowRight");
    expect(mocks.tuneRadioStation).not.toHaveBeenCalled();
    expect(mocks.startAmpPowerOn).not.toHaveBeenCalled();
    // Back on Düsseldorf, right remembers the station and powers the amp on with the radio source.
    press("F2");
    press("ArrowDown");
    press("Enter");
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: { source: "NET RADIO" } }),
    );
    expect(mocks.tuneRadioStation).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("Turning the amplifier on"),
    );
  });
});
