// Loads the panel configuration from Home Assistant (kindle_panel.get_config), seeds it on the first start, and
// applies it to the shared constants. Without the kindle_panel integration the panel runs on DEFAULT_CONFIG plus
// the env it always had, exactly as before.
import { HomeError, ha, haConfigured } from "./home.server";
import { applyHomeConfig } from "./home";
import { parseLang } from "./i18n";
import { applyMediaConfig } from "./media";
import { DEFAULT_CONFIG, mergePanelConfig, panelView } from "./panel-config";
import type { PanelConfig, PanelView } from "./panel-config";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadMarks, marksFile } from "./photo.server";

const TTL_MS = 30_000;
const MISSING_RETRY_MS = 60_000;

type Loaded = { config: PanelConfig; source: "ha" | "default"; at: number };
let current: Loaded | null = null;
let missingUntil = 0;
let missingStrikes = 0; // consecutive "kindle_panel not there" answers (HA answers 400 for an unknown service)
let inflight: Promise<Loaded> | null = null;
let marksWarned = false;

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
    // RADIO_DUTY_ENABLED, or the older SLEEP_ENABLED the bridge also honours
    radio_duty: (env("RADIO_DUTY_ENABLED") || env("SLEEP_ENABLED")) !== "0",
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

/** The marks this panel collected before HA held them (F1 = keep). null when they cannot be read (state dir not
 *  mounted, unreadable file): then the marks are not handed over yet, and HA keeps asking for them. */
async function localMarks(): Promise<Record<string, string> | null> {
  const file = marksFile();
  const stateDir = (process.env["MEDIA_STATE_DIR"] ?? "").trim();
  try {
    await access(path.dirname(file));
  } catch {
    return null;
  }
  try {
    await access(file);
  } catch {
    // The state dir is there and nothing was ever marked. Without MEDIA_STATE_DIR the file would be in the temp
    // dir, which always exists: then "no file" proves nothing, keep asking.
    return stateDir ? {} : null;
  }
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    JSON.parse(raw);
  } catch {
    return null;
  }
  const m = await loadMarks(file);
  return Object.fromEntries(m.marked.map((x) => [x.id, x.at]));
}

/** HA is running and has no kindle_panel config entry. The entries list needs an admin token (the panel's token is
 *  one); without it, HA running with no kindle_panel component loaded counts as removed. */
async function panelRemoved(): Promise<boolean> {
  try {
    const entries = await ha<unknown[]>(
      "GET",
      "/api/config/config_entries/entry?domain=kindle_panel",
    );
    return Array.isArray(entries) && entries.length === 0;
  } catch {
    try {
      const c = await ha<{ state?: string; components?: string[] }>("GET", "/api/config");
      return c.state === "RUNNING" && !(c.components ?? []).includes("kindle_panel");
    } catch {
      return false;
    }
  }
}

/** While HA is unreachable the last config from HA stays (an HA restart must not flip the screen to the defaults);
 *  defaults only when nothing was ever loaded, or when kindle_panel is really gone (rollback). */
const keepLast = (): Loaded | null => (current ? { ...current, at: Date.now() } : null);

async function load(): Promise<Loaded> {
  const fallback = (): Loaded => ({ config: defaultFromEnv(), source: "default", at: Date.now() });
  if (!haConfigured()) return fallback();
  if (Date.now() < missingUntil) return keepLast() ?? fallback();
  let got: GetConfig;
  try {
    got = await call<GetConfig>("get_config");
    missingStrikes = 0;
  } catch (e) {
    missingUntil = Date.now() + MISSING_RETRY_MS;
    // HA answers 400 for an unknown service, also while it is still starting or the entry is being retried; only
    // count it when HA is up and has no Kindle Panel entry at all. Twice in a row (≥ 1 min apart): the integration
    // was removed (rollback), back to defaults + env.
    if (
      e instanceof HomeError &&
      e.status === 400 &&
      (await panelRemoved()) &&
      ++missingStrikes >= 2
    )
      return fallback();
    return keepLast() ?? fallback();
  }
  if (!got.seeded || !got.marks_seeded) {
    // First start against HA: hand over what this panel has, so nothing on the screen changes.
    const seed: Record<string, unknown> = {};
    if (!got.seeded) seed["config"] = defaultFromEnv();
    if (!got.marks_seeded) {
      const kept = await localMarks();
      if (kept) seed["kept"] = kept;
      else if (!marksWarned) {
        marksWarned = true;
        console.warn(
          `[panel] photo marks not readable (${marksFile()}); not handed to Home Assistant yet`,
        );
      }
    }
    if (Object.keys(seed).length) {
      try {
        const r = await call<Record<string, unknown>>("seed", seed);
        console.log("[panel] seeded Home Assistant:", JSON.stringify(r));
        got = await call<GetConfig>("get_config");
      } catch (e) {
        console.warn("[panel] seeding Home Assistant failed:", e);
        return keepLast() ?? fallback();
      }
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
  missingStrikes = 0;
}

export const panelViewNow = (): PanelView =>
  current ? panelView(current.config, current.source) : panelView(defaultFromEnv(), "default");

export const panelConfigNow = (): Loaded | null => current;
