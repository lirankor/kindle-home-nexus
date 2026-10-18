// The panel's one icon pack (bus task 019): every icon field of the panel config (lights, rooms, scenes, custom tabs,
// toggles, sensor cards, plugs, media devices, receiver inputs) picks a name from `src/data/icons.json`. That file is
// the source of truth: name -> component name (a lucide-react export, or one of the two light icons drawn here).
// kindle_panel's `const.ICONS` lists the same names; a vitest and a panel pytest keep the two equal.
//
// lucide icons are imported by name (tree-shaken); never `import *` here.
import type { ReactNode } from "react";
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

/** The component for `name`, or the given fallback name's (unknown / empty names draw the row type's default). */
export function iconFor(name: string | null | undefined, fallback: string): IconComponent {
  return (name ? ICONS[name] : undefined) ?? ICONS[fallback] ?? Star;
}

/** The component for `name`, or null when the name is empty or unknown (receiver inputs: no icon by default). */
export function optionalIcon(name: string | null | undefined): IconComponent | null {
  return (name ? ICONS[name] : undefined) ?? null;
}

/** A media node's icon: its own, else by type (receiver "speaker", tv "tv"). */
export const nodeIcon = (n: { type: string; icon?: string | null }): IconComponent =>
  iconFor(n.icon, n.type === "tv" ? ICON_DEFAULTS.tv : ICON_DEFAULTS.receiver);
