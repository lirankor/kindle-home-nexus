import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoMediaSnapshot, demoRadioLists } from "@/lib/media";
import { routeTree } from "@/routeTree.gen";
import { applyHomeConfig, demoSnapshot } from "@/lib/home";
import { DEFAULT_CONFIG, mergePanelConfig, panelView } from "@/lib/panel-config";

// The whole shell, with the server functions mocked: demo home data, a live-looking media snapshot.
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

const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const activeTab = () => document.querySelector('.device-tabs [data-active="true"]')?.textContent;

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

const footer = () =>
  Array.from(document.querySelectorAll(".device-actions [data-soft-key]")).map(
    (b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`,
  );

describe("custom tab (task 012)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    const config = mergePanelConfig({
      ...DEFAULT_CONFIG,
      tabs: ["lights", "power", "custom:garden"],
      names: { he: { ...DEFAULT_CONFIG.names.he, Garden: "גינה", Pump: "משאבה" } },
      custom_tabs: {
        garden: {
          title: "Garden",
          icon: "leaf",
          toggles: [
            { entity_id: "input_boolean.pump", name: "Pump", icon: "zap" },
            { entity_id: "light.garden", name: "Garden light", icon: "bulb" },
          ],
          keys: ["input_boolean.pump", "script.water", "all_off", "none"],
        },
      },
    });
    applyHomeConfig(config);
    const snapshot = {
      ...demoSnapshot(),
      custom: { garden: { on: [true, false], names: { "script.water": "Water" } } },
    };
    const result = { configured: true, snapshot, lang: "he", panel: panelView(config, "ha") };
    mocks.getSnapshot.mockResolvedValue(result);
    mocks.runAction.mockResolvedValue({ ok: true, snapshot });
    mocks.getScreensaver.mockResolvedValue({ image: null, sample: true, result });
    mocks.getMediaSnapshot.mockResolvedValue({
      configured: true,
      amp: true,
      jellyfin: false,
      snapshot: demoMediaSnapshot(),
      lang: "he",
    });
    mocks.getPowerOnStatus.mockResolvedValue(null);
    mocks.getRadioLists.mockResolvedValue(demoRadioLists());
  });
  afterEach(() => {
    cleanup();
    applyHomeConfig(DEFAULT_CONFIG);
  });

  it("is a tab like the others: title, toggle rows, F1..F4 from its keys", async () => {
    await renderApp();
    await waitFor(() => expect(document.querySelectorAll(".device-tabs button").length).toBe(3));
    press("PageUp"); // from Lights back to the last tab
    await waitFor(() => expect(activeTab()).toContain("גינה"));
    expect(document.querySelector(".content h1")?.textContent).toBe("גינה");
    const rows = Array.from(document.querySelectorAll(".content .power-row")).map(
      (r) => r.textContent,
    );
    expect(rows).toEqual(["משאבהדלוק", "Garden lightכבוי"]);
    expect(footer()).toEqual(["משאבה*", "Water", "כבה הכל", "\u00a0"]);
    press("F1");
    press("F2");
    press("F3");
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(3));
    expect(mocks.runAction.mock.calls.map((c) => c[0].data)).toEqual([
      { type: "custom.toggle", tab: "garden", entity: "input_boolean.pump" },
      { type: "custom.run", tab: "garden", entity: "script.water", name: "Water" },
      { type: "custom.off", tab: "garden" },
    ]);
  });
});
