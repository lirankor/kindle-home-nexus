import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// The radio bands come from HA at run time; tests start with the fixture list.
import { radioListsFromBridge, setRadioLists } from "@/lib/media";
import { BRIDGE_STATIONS } from "./radio-fixture";
import { beforeEach } from "vitest";
beforeEach(() => setRadioLists(radioListsFromBridge(BRIDGE_STATIONS)));
