import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lucide from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

/** kindle_panel's pictures of the pack (its icon chooser shows them): name -> a standalone SVG. */
const PICTURES = join(root, "homeassistant/custom_components/kindle_panel/icon_pack.json");
/** The stroke the panel's rows draw their icon with (src/routes/index.tsx). */
const PICTURE_STROKE = 1.5;

/** One pack icon as a standalone SVG: what the app's own component draws (24-unit box, currentColor), without the
 *  attributes only a page needs (class, aria-hidden, the pixel size) and with the xmlns a file needs. */
function picture(name: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(
    createElement(ICONS[name]!, { size: 24, strokeWidth: PICTURE_STROKE }),
  );
  const svg = holder.firstElementChild!;
  const attrs = ["viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]
    .map((a) => `${a}="${svg.getAttribute(a)}"`)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${svg.innerHTML}</svg>`;
}

describe("icon pack (bus task 019)", () => {
  it("the panel's ICONS list equals src/data/icons.json", () => {
    expect(panelIcons()).toEqual(Object.keys(pack).sort());
  });
  // The drawings reach Home Assistant as a generated file. After changing the pack, lucide-react or a light icon:
  //   UPDATE_ICON_PICTURES=1 bunx vitest run src/lib/icons.test.ts
  it("the panel's pictures (icon_pack.json) are the pack as the app draws it", () => {
    const drawn = Object.fromEntries(ICON_NAMES.map((name) => [name, picture(name)]));
    if (process.env["UPDATE_ICON_PICTURES"])
      writeFileSync(PICTURES, JSON.stringify(drawn, null, 2) + "\n");
    expect(JSON.parse(readFileSync(PICTURES, "utf8"))).toEqual(drawn);
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
