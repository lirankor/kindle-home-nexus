import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActions, pressSoftKey } from "@/components/device-actions";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { LangContext } from "@/lib/lang-context";
import { demoMediaSnapshot } from "@/lib/media";
import { useMediaPanel } from "@/lib/media-panel";
import type { MediaSnapshotResult } from "@/lib/media";

const mocks = vi.hoisted(() => ({
  getMediaSnapshot: vi.fn(),
  runMediaAction: vi.fn(),
  startAmpPowerOn: vi.fn(),
  getPowerOnStatus: vi.fn(),
}));
vi.mock("@/lib/media.functions", () => mocks);

const liveResult = (): MediaSnapshotResult => ({
  configured: true,
  amp: true,
  jellyfin: false,
  snapshot: demoMediaSnapshot(),
  lang: "he",
});

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
  });

  it("renders the TV and amp cards from the demo snapshot with the all-off footer", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("1LIVE · Zara Larsson - Memory Lane")).toBeVisible(),
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

  it("opens the amp view from the amp card and steps the volume on up/down", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    act(() => screen.getByTitle("פתח את המגבר").click());
    const dialog = screen.getByRole("dialog", { name: "תצוגת המגבר" });
    expect(dialog).toBeVisible();
    expect(dialog.textContent).toContain("1LIVE");
    expect(dialog.querySelector(".amp-knob")?.textContent).toBe("-44.5dB");
    expect(document.documentElement.getAttribute("data-eink-refresh")).toBe("full");

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
    expect(dialog.querySelector(".amp-knob")?.textContent).toBe("-42.5dB");
    await act(async () => settle({ ok: true }));
    await waitFor(() => expect(dialog.querySelector(".amp-knob")?.textContent).toBe("-44.5dB"));
    press("ArrowDown");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.volume.step", delta: -1 },
      }),
    );
    // Right = next station while the radio plays.
    press("ArrowRight");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "radio.step", delta: 1 },
      }),
    );
    // Enter is a no-op for radio.
    const calls = mocks.runMediaAction.mock.calls.length;
    press("Enter");
    expect(mocks.runMediaAction).toHaveBeenCalledTimes(calls);
    // F1 closes.
    press("F1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the source list on F3 and applies a source with Enter", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTitle("פתח את המגבר")).toBeVisible());
    press("F3"); // amp view
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
    // Cursor starts on the current source (NET RADIO = row 4).
    expect(rows[3]).toHaveAttribute("aria-selected", "true");
    press("ArrowUp");
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
    // The snapshot still says NET RADIO (the mock returned no new one), so the cursor is on רדיו.
    expect(screen.getAllByRole("option")[3]).toHaveAttribute("aria-selected", "true");
    press("F4");
    await waitFor(() =>
      expect(mocks.runMediaAction).toHaveBeenLastCalledWith({
        data: { type: "amp.source", source: "NET RADIO" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "רדיו" }).textContent).toContain("בקרוב");
    press("F1");
    expect(screen.getByRole("dialog", { name: "תצוגת המגבר" })).toBeVisible();
  });

  it("starts the power-on routine from F4 when the amp is off and shows its steps", async () => {
    const off = liveResult();
    off.snapshot!.amp.on = false;
    off.snapshot!.amp.state = "off";
    mocks.getMediaSnapshot.mockResolvedValue(off);
    const now = Date.now();
    mocks.startAmpPowerOn.mockResolvedValue({
      ok: true,
      status: {
        running: true,
        step: "wait",
        startedAt: now,
        updatedAt: now,
        elapsedMs: 0,
        source: "NET RADIO",
      },
    });
    renderPanel("en");
    await waitFor(() => expect(screen.getByTitle("Open the amplifier")).toBeVisible());
    press("F3");
    const dialog = screen.getByRole("dialog", { name: "Amplifier view" });
    expect(dialog.textContent).toContain("The amplifier is off");
    expect(dialog.querySelector(".amp-knob")?.textContent).toBe("—dB");
    press("F4");
    await waitFor(() => expect(mocks.startAmpPowerOn).toHaveBeenCalledWith({ data: {} }));
    await waitFor(() => expect(dialog.textContent).toContain("Waiting for the amplifier…"));
    expect(dialog.querySelector('[data-state="active"]')?.textContent).toContain("Waiting");
    expect(dialog.querySelector('[data-state="done"]')?.textContent).toContain("plug");
  });
});
