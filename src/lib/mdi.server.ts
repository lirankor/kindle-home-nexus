// Server-only (bus task 020): an HA entity's `icon` attribute -> the Material Design Icons SVG path, so the Kindle
// draws the icon HA shows. @mdi/js (~7000 paths) stays on the server; the snapshot carries only the paths in use.
// The ESM file is read as text (`?raw`) and parsed once: `import * as` of @mdi/js made the bundler move its runtime
// helpers into a chunk with an import cycle, and the server failed at start ("__commonJSMin is not a function").
import source from "@mdi/js/mdi.js?raw";
import type { EntityIcon, EntityIcons } from "@/lib/icons";

let paths: Map<string, string> | null = null;
/** export name (mdiTheater) -> SVG path, parsed on first use. */
const table = (): Map<string, string> =>
  (paths ??= new Map(
    Array.from(source.matchAll(/export var (mdi[A-Za-z0-9]+) = "([^"]+)"/g), (m) => [m[1]!, m[2]!]),
  ));
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `mdi:theater` -> its path. "hass:" (HA's old alias) and a bare name (Music Assistant's `speaker`) count as MDI;
 *  any other icon set, a malformed or an unknown name -> null (the caller falls back to the next in precedence). */
export function resolveMdi(icon: unknown): EntityIcon | null {
  if (typeof icon !== "string") return null;
  let name = icon.trim().toLowerCase();
  const colon = name.indexOf(":");
  if (colon >= 0) {
    const set = name.slice(0, colon);
    if (set !== "mdi" && set !== "hass") return null;
    name = name.slice(colon + 1);
  }
  if (!NAME.test(name)) return null;
  const key = `mdi${name
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")}`;
  const path = table().get(key);
  return path ? { name, path } : null;
}

type WithIcon = { attributes?: { icon?: unknown } | null };
/** The resolved HA icons of the given entities (those without a resolvable `icon` attribute are left out). */
export function entityIcons(
  states: Map<string, WithIcon>,
  ids: Iterable<string | null | undefined>,
): EntityIcons {
  const out: EntityIcons = {};
  for (const id of ids) {
    if (!id || Object.hasOwn(out, id)) continue;
    const icon = resolveMdi(states.get(id)?.attributes?.icon);
    if (icon) out[id] = icon;
  }
  return out;
}
