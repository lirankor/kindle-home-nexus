import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lucide from "lucide-react";
import pack from "@/data/icons.json";
import {
  COMPONENTS,
  ICONS,
  ICON_DEFAULTS,
  ICON_NAMES,
  iconFor,
  nodeIcon,
  optionalIcon,
} from "./icons";

const root = join(__dirname, "..", "..");
/** kindle_panel's const.ICONS, read from the Python source (the list between `ICONS = [` and `]`). */
function panelIcons(): string[] {
  const src = readFileSync(
    join(root, "homeassistant/custom_components/kindle_panel/const.py"),
    "utf8",
  );
  const m = /^ICONS = \[([\s\S]*?)\]/m.exec(src);
  if (!m) throw new Error("ICONS not found in const.py");
  return [...m[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
}

describe("icon pack (bus task 019)", () => {
  it("the panel's ICONS list equals src/data/icons.json", () => {
    expect(panelIcons()).toEqual(Object.keys(pack).sort());
  });
  it("every name resolves to a component: a lucide export or one of the two light icons", () => {
    const custom = new Set(["SpotLightIcon", "StripLightIcon"]);
    for (const [name, component] of Object.entries(pack as Record<string, string>)) {
      expect(COMPONENTS[component], name).toBeDefined();
      expect(ICONS[name]).toBe(COMPONENTS[component]);
      if (!custom.has(component))
        expect(ICONS[name], name).toBe((lucide as Record<string, unknown>)[component]);
    }
  });
  it("is sorted, 60-80 names, and keeps every name used before the pack", () => {
    expect(ICON_NAMES).toEqual([...ICON_NAMES].sort());
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(60);
    expect(ICON_NAMES.length).toBeLessThanOrEqual(80);
    const before = [
      ...["lamp_ceiling", "spot", "strip", "lamp", "bulb"],
      ...["shower", "baby", "door", "utensils", "home", "bath", "bed", "sofa", "room"],
      ...["sun", "moon", "film", "sofa", "bed", "book", "utensils", "star", "sparkles", "power"],
      ...["plug", "bulb", "lamp", "fan", "power", "tv", "zap", "leaf", "home", "star"],
      ...[
        "thermometer",
        "droplets",
        "gauge",
        "zap",
        "plug",
        "wind",
        "sun",
        "leaf",
        "home",
        "battery",
      ],
    ];
    for (const n of before) expect(ICON_NAMES, n).toContain(n);
    for (const d of Object.values(ICON_DEFAULTS)) expect(ICON_NAMES).toContain(d);
  });
  it("unknown or empty names fall back to the row type's default", () => {
    expect(iconFor("toilet", "room")).toBe(lucide.Toilet);
    expect(iconFor("nope", "room")).toBe(lucide.House);
    expect(iconFor(null, "plug")).toBe(lucide.Plug);
    expect(nodeIcon({ type: "receiver" })).toBe(lucide.Speaker);
    expect(nodeIcon({ type: "tv" })).toBe(lucide.Tv);
    expect(nodeIcon({ type: "tv", icon: "monitor" })).toBe(lucide.Monitor);
    expect(optionalIcon(undefined)).toBeNull();
    expect(optionalIcon("bluetooth")).toBe(lucide.Bluetooth);
  });
});
