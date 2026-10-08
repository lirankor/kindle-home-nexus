// Server-only: talks to Home Assistant and Immich. Env vars are read at request
// time from process.env and never reach the browser.
import {
  LIGHTS,
  LIGHT_IDS,
  MEDIA,
  PLUGS,
  ROOMS,
  SCRIPTS,
  SENSORS,
  VACUUM,
  COLOR_MODES,
  nearestColor,
  nearestShade,
} from "@/lib/home";
import { cropToScreen, pickAsset } from "@/lib/photo.server";
import type { PhotoAsset } from "@/lib/photo.server";
import type { Action, LightState, Shade, Snapshot } from "@/lib/home";

type HaAttrs = {
  brightness?: unknown;
  color_temp_kelvin?: unknown;
  color_mode?: unknown;
  supported_color_modes?: unknown;
  rgb_color?: unknown;
  battery_level?: unknown;
  volume_level?: unknown;
  source?: unknown;
  temperature?: unknown;
};
export type HaState = { entity_id: string; state: string; attributes: HaAttrs };
export class HomeError extends Error {}

const env = (name: string) => (process.env[name] ?? "").trim().replace(/\/+$/, "");
export const haConfigured = () => env("HA_TOKEN") !== "";

export async function ha<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = env("HA_BASE_URL") || "http://host.docker.internal:8123";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env("HA_TOKEN")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new HomeError("HA unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new HomeError("HA rejected token");
  if (!res.ok) throw new HomeError(`HA error ${res.status}`);
  return (await res.json()) as T;
}

export const fetchStates = async () =>
  new Map((await ha<HaState[]>("GET", "/api/states")).map((s) => [s.entity_id, s]));
export const service = (domain: string, name: string, data: Record<string, unknown>) =>
  ha("POST", `/api/services/${domain}/${name}`, data);

const num = (s?: HaState): number | null => {
  if (!s || s.state === "unavailable" || s.state === "unknown") return null;
  const n = parseFloat(s.state);
  return Number.isFinite(n) ? n : null;
};
const attrNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseLight(s?: HaState): LightState {
  const on = s?.state === "on";
  const a = s?.attributes ?? {};
  const b = attrNum(a.brightness);
  const kelvin = attrNum(a.color_temp_kelvin);
  const mode = typeof a.color_mode === "string" ? a.color_mode : "";
  const rgb = Array.isArray(a.rgb_color) ? (a.rgb_color as number[]) : null;
  const colored =
    rgb !== null &&
    mode !== "" &&
    mode !== "color_temp" &&
    mode !== "brightness" &&
    mode !== "onoff";
  const modes = Array.isArray(a.supported_color_modes)
    ? (a.supported_color_modes as unknown[])
    : [];
  const canColor = modes.some((m) => typeof m === "string" && COLOR_MODES.includes(m));
  const shade: Shade = kelvin !== null ? nearestShade(kelvin) : "Neutral";
  return {
    on,
    level: on ? (b === null ? 100 : Math.max(1, Math.round((b / 255) * 100))) : 0,
    shade,
    color: canColor && colored ? nearestColor(rgb) : "White",
    canColor,
  };
}

export function buildSnapshot(states: Map<string, HaState>): Snapshot {
  const vac = states.get(VACUUM.id);
  const battery = num(states.get(VACUUM.battery)) ?? attrNum(vac?.attributes.battery_level);
  const media = MEDIA.map((m) => {
    const s = states.get(m.id);
    return {
      state: s?.state ?? "unavailable",
      volume: attrNum(s?.attributes.volume_level),
      source: typeof s?.attributes.source === "string" ? s.attributes.source : null,
    };
  });
  const w = states.get(SENSORS.weather);
  return {
    lights: LIGHTS.map((l) => parseLight(states.get(l.id))),
    movieActive: states.get(SCRIPTS.movieActive)?.state === "on",
    vacuum: {
      state: vac?.state ?? "unavailable",
      battery: battery === null ? null : Math.round(battery),
    },
    rooms: ROOMS.map((r) => states.get(r.id)?.state === "on"),
    plugs: PLUGS.map((p) => {
      const e = num(states.get(p.energy));
      return {
        on: states.get(p.id)?.state === "on",
        power: num(states.get(p.power)),
        energyWh: e === null ? null : e * p.energyToWh,
      };
    }),
    media,
    weather: {
      condition: w && w.state !== "unavailable" && w.state !== "unknown" ? w.state : null,
      temp: attrNum(w?.attributes.temperature),
    },
    indoor: {
      temp: num(states.get(SENSORS.indoorTemp)),
      humidity: num(states.get(SENSORS.indoorHumidity)),
    },
  };
}

export async function readSnapshot(): Promise<Snapshot> {
  return buildSnapshot(await fetchStates());
}

export async function performAction(a: Action): Promise<void> {
  switch (a.type) {
    case "light.toggle":
      await service("light", "toggle", { entity_id: a.entity });
      break;
    case "light.brightness":
      await service("light", "turn_on", { entity_id: a.entity, brightness_pct: a.pct });
      break;
    case "light.kelvin":
      await service("light", "turn_on", { entity_id: a.entity, color_temp_kelvin: a.kelvin });
      break;
    case "light.color":
      await service("light", "turn_on", {
        entity_id: a.entity,
        ...(a.color === "White"
          ? { color_temp_kelvin: 4000 }
          : { color_name: a.color.toLowerCase() }),
      });
      break;
    case "lights.off":
      await service("light", "turn_off", { entity_id: LIGHT_IDS });
      break;
    case "scene":
      if (a.name === "Bright")
        await service("light", "turn_on", { entity_id: LIGHT_IDS, brightness_pct: 100 });
      else if (a.name === "Evening") {
        await service("light", "turn_on", { entity_id: LIGHTS[0].id, brightness_pct: 40 });
        await service("light", "turn_off", { entity_id: LIGHT_IDS.slice(1) });
      } else await service("script", "turn_on", { entity_id: SCRIPTS.movie }); // turn_on: do not wait for the script to finish
      break;
    case "movie.end":
      await service("script", "turn_on", { entity_id: SCRIPTS.movieOff });
      break;
    case "vacuum":
      if (a.op === "start") {
        const states = await fetchStates();
        if (ROOMS.some((r) => states.get(r.id)?.state === "on"))
          await service("script", "turn_on", { entity_id: SCRIPTS.roomsStart });
        else await service("vacuum", "start", { entity_id: VACUUM.id });
      } else
        await service(
          "vacuum",
          { pause: "pause", dock: "return_to_base", locate: "locate" }[a.op],
          { entity_id: VACUUM.id },
        );
      break;
    case "room.toggle":
      await service("input_boolean", "toggle", { entity_id: a.entity });
      break;
    case "rooms.clear":
      await service("input_boolean", "turn_off", { entity_id: ROOMS.map((r) => r.id) });
      break;
    case "switch.toggle":
      await service("switch", "toggle", { entity_id: a.entity });
      break;
    case "media":
      await service("media_player", a.op, { entity_id: a.entity });
      break;
  }
}

export const errorMessage = (e: unknown) => (e instanceof HomeError ? e.message : "HA unreachable");

// ---- Immich ----
export const immichConfigured = () => env("IMMICH_API_KEY") !== "" && env("IMMICH_URL") !== "";

let previousPhoto: string | null = null;

export async function randomFavorite(): Promise<string> {
  const base = env("IMMICH_URL");
  const headers = { "x-api-key": env("IMMICH_API_KEY") };
  const search = await fetch(`${base}/api/search/metadata`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ isFavorite: true, type: "IMAGE", size: 250, page: 1, withExif: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!search.ok) throw new Error(`Immich search ${search.status}`);
  const items =
    ((await search.json()) as { assets?: { items?: PhotoAsset[] } }).assets?.items ?? [];
  if (!items.length) throw new Error("No favorites");
  const asset = pickAsset(items, previousPhoto);
  if (!asset) throw new Error("No favorites");
  previousPhoto = asset.id;
  const img = await fetch(`${base}/api/assets/${asset.id}/thumbnail?size=preview`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!img.ok) throw new Error(`Immich thumbnail ${img.status}`);
  const raw = Buffer.from(await img.arrayBuffer());
  try {
    // Exactly the screen size, so the page never letterboxes or re-crops it.
    return `data:image/jpeg;base64,${(await cropToScreen(raw)).toString("base64")}`;
  } catch (e) {
    console.error("Screensaver crop failed, sending the uncropped preview:", e);
    const type = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return `data:${type};base64,${raw.toString("base64")}`;
  }
}
