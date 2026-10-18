// The panel's one icon pack (bus task 019): every icon field of the panel config (lights, rooms, scenes, custom tabs,
// toggles, sensor cards, plugs, media devices, receiver inputs) picks a name from `src/data/icons.json`. That file is
// the source of truth: name -> component name (a lucide-react export, or one of the two light icons drawn here).
// kindle_panel's `const.ICONS` lists the same names; a vitest and a panel pytest keep the two equal.
//
// lucide icons are imported by name (tree-shaken); never `import *` here.
import { createElement, type ReactNode } from "react";
import {
  AirVent,
  AlarmClock,
  Armchair,
  Baby,
  Bath,
  Battery,
  Bed,
  Bell,
  Blinds,
  Bluetooth,
  BookOpen,
  Bot,
  Cable,
  CalendarDays,
  Camera,
  Car,
  Cat,
  Coffee,
  CookingPot,
  Cylinder,
  Disc3,
  Dog,
  DoorOpen,
  Droplets,
  Fan,
  Film,
  Flame,
  Flower2,
  Footprints,
  Gamepad2,
  Gauge,
  Headphones,
  Heater,
  House,
  Key,
  Lamp,
  LampCeiling,
  LampDesk,
  LampFloor,
  Laptop,
  Leaf,
  Lightbulb,
  Lock,
  Mic,
  Monitor,
  Moon,
  Music,
  Plug,
  Power,
  Printer,
  Radio,
  Refrigerator,
  Shield,
  ShowerHead,
  Smartphone,
  Snowflake,
  Sofa,
  Sparkles,
  Speaker,
  Sprout,
  Star,
  Sun,
  Thermometer,
  Timer,
  Toilet,
  ToyBrick,
  Trash2,
  TreeDeciduous,
  Tv,
  Umbrella,
  Usb,
  Utensils,
  Warehouse,
  WashingMachine,
  Wifi,
  Wind,
  Zap,
} from "lucide-react";
import { SpotLightIcon, StripLightIcon } from "@/components/light-icons";
import pack from "@/data/icons.json";

export type IconComponent = (props: { size?: number; strokeWidth?: number }) => ReactNode;

/** Every component the pack may name, by its export name. */
export const COMPONENTS: Record<string, IconComponent> = {
  AirVent,
  AlarmClock,
  Armchair,
  Baby,
  Bath,
  Battery,
  Bed,
  Bell,
  Blinds,
  Bluetooth,
  BookOpen,
  Bot,
  Cable,
  CalendarDays,
  Camera,
  Car,
  Cat,
  Coffee,
  CookingPot,
  Cylinder,
  Disc3,
  Dog,
  DoorOpen,
  Droplets,
  Fan,
  Film,
  Flame,
  Flower2,
  Footprints,
  Gamepad2,
  Gauge,
  Headphones,
  Heater,
  House,
  Key,
  Lamp,
  LampCeiling,
  LampDesk,
  LampFloor,
  Laptop,
  Leaf,
  Lightbulb,
  Lock,
  Mic,
  Monitor,
  Moon,
  Music,
  Plug,
  Power,
  Printer,
  Radio,
  Refrigerator,
  Shield,
  ShowerHead,
  Smartphone,
  Snowflake,
  Sofa,
  Sparkles,
  Speaker,
  Sprout,
  Star,
  Sun,
  Thermometer,
  Timer,
  Toilet,
  ToyBrick,
  Trash2,
  TreeDeciduous,
  Tv,
  Umbrella,
  Usb,
  Utensils,
  Warehouse,
  WashingMachine,
  Wifi,
  Wind,
  Zap,
  SpotLightIcon,
  StripLightIcon,
};

/** The pack's names, sorted (the order the HA options flow offers them). */
export const ICON_NAMES: readonly string[] = Object.keys(pack).sort();

/** Icon name -> component. */
export const ICONS: Record<string, IconComponent> = Object.fromEntries(
  Object.entries(pack as Record<string, string>).map(([name, component]) => [
    name,
    COMPONENTS[component] ?? Star,
  ]),
);

/** Each row type's default icon (what an empty or unknown name draws). */
export const ICON_DEFAULTS = {
  light: "bulb",
  room: "room",
  scene: "star",
  toggle: "plug",
  custom_tab: "star",
  card: "gauge",
  plug: "plug",
  receiver: "speaker",
  tv: "tv",
} as const;

/** The panel's "use the entity's own icon" value (bus task 020): every icon select offers it first, and it is what a
 *  row without an icon means. Not a pack name, so every lookup below falls through it. */
export const ICON_AUTO = "auto";

/** An HA entity's own icon (its `icon` state attribute, e.g. `mdi:theater`), resolved to an SVG path on the server
 *  (src/lib/mdi.server.ts; @mdi/js never reaches the browser). */
export type EntityIcon = { name: string; path: string };
/** Entity id -> its resolved HA icon; only entities with a resolvable `icon` attribute are listed. */
export type EntityIcons = Record<string, EntityIcon>;

/** MDI is filled, lucide is stroked at 2. Both use a 24-unit box with ~2 units of margin; on the e-ink renders of bus
 *  task 020 an MDI glyph in the same box did not look heavier (its strokes are thin shapes), and padding it by 1 unit
 *  made it look smaller than its lucide neighbours, so it is drawn at the same box size (pad 0). */
const MDI_PAD = 0;
const mdiComponents = new Map<string, IconComponent>();
/** A component that draws one MDI path (filled, currentColor) with the same props as a lucide icon. */
export function mdiIcon(icon: EntityIcon): IconComponent {
  let c = mdiComponents.get(icon.path);
  if (!c) {
    const box = `${-MDI_PAD} ${-MDI_PAD} ${24 + 2 * MDI_PAD} ${24 + 2 * MDI_PAD}`;
    c = ({ size = 24 }) =>
      createElement(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: size,
          height: size,
          viewBox: box,
          fill: "currentColor",
          "aria-hidden": true,
          className: `mdi mdi-${icon.name}`,
        },
        createElement("path", { d: icon.path }),
      );
    mdiComponents.set(icon.path, c);
  }
  return c;
}

/** The icon precedence for every button and key (bus task 020): an explicit pack name set in the panel row, else the
 *  HA entity's own icon, else the fallback (a pack name = the row type's default, or a component, e.g. a key's glyph).
 *  "auto", empty and unknown names fall through to the entity's icon. */
export function pickIcon(
  row: string | null | undefined,
  entity: EntityIcon | null | undefined,
  fallback: string | IconComponent,
): IconComponent {
  const own = row ? ICONS[row] : undefined;
  if (own) return own;
  if (entity?.path) return mdiIcon(entity);
  return typeof fallback === "string" ? (ICONS[fallback] ?? Star) : fallback;
}

/** Like pickIcon, but null when neither the row nor the entity has one (receiver inputs: no icon by default). */
export function pickOptionalIcon(
  row: string | null | undefined,
  entity?: EntityIcon | null,
): IconComponent | null {
  const own = row ? ICONS[row] : undefined;
  return own ?? (entity?.path ? mdiIcon(entity) : null);
}

/** The component for `name`, or the given fallback name's (unknown / empty names draw the row type's default). */
export function iconFor(name: string | null | undefined, fallback: string): IconComponent {
  return (name ? ICONS[name] : undefined) ?? ICONS[fallback] ?? Star;
}

/** The component for `name`, or null when the name is empty or unknown (receiver inputs: no icon by default). */
export function optionalIcon(name: string | null | undefined): IconComponent | null {
  return (name ? ICONS[name] : undefined) ?? null;
}

/** A media node's icon: its row's, else its entity's HA icon, else by type (receiver "speaker", tv "tv"). */
export const nodeIcon = (n: {
  type: string;
  icon?: string | null;
  entityIcon?: EntityIcon | null;
}): IconComponent =>
  pickIcon(n.icon, n.entityIcon, n.type === "tv" ? ICON_DEFAULTS.tv : ICON_DEFAULTS.receiver);
