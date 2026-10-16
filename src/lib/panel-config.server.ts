// Loads the panel configuration from Home Assistant (kindle_panel.get_config), seeds it on the first start, and
// applies it to the shared constants. Without the kindle_panel integration the panel runs on DEFAULT_CONFIG plus
// the env it always had, exactly as before.
import { HomeError, ha, haConfigured } from "./home.server";
import { applyHomeConfig } from "./home";
import { parseLang } from "./i18n";
import { applyMediaConfig } from "./media";
import { DEFAULT_CONFIG, mergePanelConfig, panelView } from "./panel-config";
import type { PanelConfig, PanelView } from "./panel-config";
import { loadMarks } from "./photo.server";

const TTL_MS = 30_000;
const MISSING_RETRY_MS = 60_000;

type Loaded = { config: PanelConfig; source: "ha" | "default"; at: number };
let current: Loaded | null = null;
let missingUntil = 0;
let inflight: Promise<Loaded> | null = null;

const env = (name: string) => (process.env[name] ?? "").trim();
const envInt = (name: string, fallback: number) => {
  const n = parseInt(env(name), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const hhmm = (v: string, fallback: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback);

/** What this panel ran with before HA held its config: the household defaults plus the env it was started with. */
export function defaultFromEnv(): PanelConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.language = parseLang(env("UI_LANGUAGE"));
  c.media.music_backend = env("MUSIC_BACKEND").toLowerCase() === "ha" ? "ha" : "app";
  c.schedule = {
    radio_duty: env("RADIO_DUTY_ENABLED") !== "0",
    day_wake_min: envInt("DAY_WAKE_MIN", c.schedule.day_wake_min),
    night_start: hhmm(env("NIGHT_START"), c.schedule.night_start),
    night_end: hhmm(env("NIGHT_END"), c.schedule.night_end),
    night_wake_min: envInt("NIGHT_WAKE_MIN", c.schedule.night_wake_min),
    timezone: env("SLEEP_TZ") || c.schedule.timezone,
  };
  c.screensaver.photo_minutes = c.schedule.day_wake_min;
  return c;
}

type GetConfig = { seeded: boolean; marks_seeded: boolean; config: Partial<PanelConfig> };

async function call<T>(service: string, data: Record<string, unknown> = {}): Promise<T> {
  const r = await ha<{ service_response?: T }>(
    "POST",
    `/api/services/kindle_panel/${service}?return_response`,
    data,
    15_000,
  );
  if (r.service_response === undefined)
    throw new HomeError(`kindle_panel.${service} gave no answer`);
  return r.service_response;
}

/** The marks this panel collected before HA held them (F1 = keep). */
async function localMarks(): Promise<Record<string, string>> {
  const m = await loadMarks().catch(() => ({ marked: [] as { id: string; at: string }[] }));
  return Object.fromEntries(m.marked.map((x) => [x.id, x.at]));
}

async function load(): Promise<Loaded> {
  const fallback = (): Loaded => ({ config: defaultFromEnv(), source: "default", at: Date.now() });
  if (!haConfigured() || Date.now() < missingUntil) return fallback();
  let got: GetConfig;
  try {
    got = await call<GetConfig>("get_config");
  } catch {
    missingUntil = Date.now() + MISSING_RETRY_MS; // kindle_panel not installed (HA answers 400) or HA down
    return current ?? fallback();
  }
  if (!got.seeded || !got.marks_seeded) {
    // First start against HA: hand over what this panel has, so nothing on the screen changes.
    const seed: Record<string, unknown> = { kept: await localMarks() };
    if (!got.seeded) seed["config"] = defaultFromEnv();
    try {
      const r = await call<Record<string, unknown>>("seed", seed);
      console.log("[panel] seeded Home Assistant:", JSON.stringify(r));
      got = await call<GetConfig>("get_config");
    } catch (e) {
      console.warn("[panel] seeding Home Assistant failed:", e);
      return current ?? fallback();
    }
  }
  return { config: mergePanelConfig(got.config), source: "ha", at: Date.now() };
}

function apply(l: Loaded) {
  applyHomeConfig(l.config);
  applyMediaConfig(l.config.media);
}

/** The current config (cached for 30 s), applied to the shared constants. */
export async function ensurePanelConfig(): Promise<Loaded> {
  if (current && Date.now() - current.at < TTL_MS) return current;
  inflight ??= load()
    .then((l) => {
      apply(l);
      current = l;
      return l;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** For tests and the HA config-change event. */
export function invalidatePanelConfig() {
  if (current) current.at = 0;
  missingUntil = 0;
}

export const panelViewNow = (): PanelView =>
  current ? panelView(current.config, current.source) : panelView(defaultFromEnv(), "default");

export const panelConfigNow = (): Loaded | null => current;
