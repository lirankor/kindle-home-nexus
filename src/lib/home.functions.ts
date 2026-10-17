import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseLang } from "@/lib/i18n";
import { isNight, nightWindowFromEnv, photoMinutesFromEnv } from "@/lib/night-window";
import { LIGHTS, MEDIA, MEDIA_OPS, PLUGS, ROOMS, SCENES, sceneKey } from "@/lib/home";
import type { Action, ActionResult, Snapshot, SnapshotResult } from "@/lib/home";
import { ensurePanelConfig, panelViewNow } from "@/lib/panel-config.server";
import {
  errorMessage,
  haConfigured,
  immichConfigured,
  markFavorite,
  performAction,
  randomFavorite,
  readSnapshot,
} from "./home.server";
import { onlinePhoto } from "./unsplash.server";
import { NoHaPhoto, haMarkPhoto, haPickPhoto, haPhotosActive } from "./photo-ha.server";
import { MarkRouter } from "./photo.server";

/** Shape only; whether the entity is one of the configured ones is checked in the handler (the configuration
 *  comes from Home Assistant and can change at runtime). */
const entityId = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);
/** The configured entity an action targets, or null when the action is not entity-specific. */
function actionEntityKnown(a: Action): boolean {
  switch (a.type) {
    case "light.toggle":
    case "light.brightness":
    case "light.kelvin":
    case "light.color":
      return LIGHTS.some((l) => l.id === a.entity);
    case "room.toggle":
      return ROOMS.some((r) => r.id === a.entity);
    case "switch.toggle":
      return PLUGS.some((p) => p.id === a.entity);
    case "scene":
      return SCENES.some((s) => sceneKey(s) === a.key);
    case "media":
      return MEDIA.some((m) => m.id === a.entity);
    default:
      return true;
  }
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("light.toggle"), entity: entityId }),
  z.object({
    type: z.literal("light.brightness"),
    entity: entityId,
    pct: z.number().int().min(1).max(100),
  }),
  z.object({
    type: z.literal("light.kelvin"),
    entity: entityId,
    kelvin: z.number().int().min(1500).max(9000),
  }),
  z.object({
    type: z.literal("light.color"),
    entity: entityId,
    color: z.enum(["White", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"]),
  }),
  z.object({ type: z.literal("lights.off") }),
  z.object({ type: z.literal("scene"), key: z.string().min(1).max(255) }),
  z.object({ type: z.literal("movie.end") }),
  z.object({ type: z.literal("vacuum"), op: z.enum(["start", "pause", "dock", "locate"]) }),
  z.object({ type: z.literal("room.toggle"), entity: entityId }),
  z.object({ type: z.literal("rooms.clear") }),
  z.object({ type: z.literal("switch.toggle"), entity: entityId }),
  z.object({ type: z.literal("media"), entity: entityId, op: z.enum(MEDIA_OPS) }),
]);

async function snapshotResult(): Promise<SnapshotResult> {
  // Read per request so UI_LANGUAGE can change without a rebuild.
  const cfg = await ensurePanelConfig();
  const lang = cfg.source === "ha" ? cfg.config.language : parseLang(process.env["UI_LANGUAGE"]);
  const photoMinutes =
    cfg.source === "ha" ? cfg.config.screensaver.photo_minutes : photoMinutesFromEnv();
  const panel = panelViewNow();
  if (!haConfigured()) return { configured: false, snapshot: null, lang, photoMinutes, panel };
  try {
    return { configured: true, snapshot: await readSnapshot(), lang, photoMinutes, panel };
  } catch (e) {
    return { configured: true, error: errorMessage(e), snapshot: null, lang, photoMinutes, panel };
  }
}

export const getSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<SnapshotResult> => snapshotResult(),
);

export const runAction = createServerFn({ method: "POST" })
  .validator(actionSchema)
  .handler(async ({ data }): Promise<ActionResult> => {
    if (!haConfigured()) return { ok: false, error: "HA not configured" };
    await ensurePanelConfig();
    if (!actionEntityKnown(data as Action)) return { ok: false, error: "Unknown entity" };
    try {
      await performAction(data as Action);
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
    await new Promise((r) => setTimeout(r, 400)); // let HA publish the new state
    let snapshot: Snapshot | null = null;
    try {
      snapshot = await readSnapshot();
    } catch {
      /* the client will refetch */
    }
    return { ok: true, snapshot };
  });

export type ScreensaverResult = {
  image: string | null;
  /** Immich asset behind `image`; F1 marks it as a good e-ink photo. */
  assetId?: string | null;
  /** How many favourites have been marked so far. */
  marked?: number;
  sample: boolean;
  note?: string;
  /** Photographer of an Unsplash fallback photo (credited on the screen). */
  credit?: string;
  result: SnapshotResult;
};

// The photo shown last, kept so the night window (NIGHT_START–NIGHT_END local, see night-window.ts)
// can serve the same picture again: no photo rotation at night while the Kindle sleeps. An explicit
// F1 (mark) / F4 (skip) on the saver passes `force` and always gets a new one.
let lastPhoto: { image: string; assetId: string | null; marked: number; credit?: string } | null =
  null;

// Which store judges a photo (Q15): the one whose picker served it. A photo from Home Assistant is marked in HA
// (kindle_panel); a photo from the app's own Immich fallback (HA gave no photo) is marked in the local marks file,
// whose kept / skipped lists are exactly what that fallback filters on and counts in the footer. The local marks
// are not copied to HA later (HA was seeded once); they only matter while the fallback runs.
const markRouter = new MarkRouter();
const rememberServed = (id: string | null, via: "ha" | "local") => markRouter.remember(id, via);

export const getScreensaver = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const force = !!(
      input &&
      typeof input === "object" &&
      (input as { force?: unknown }).force === true
    );
    return { force };
  })
  .handler(async ({ data }): Promise<ScreensaverResult> => {
    const readings = snapshotResult();
    const cfg = await ensurePanelConfig();
    const viaHa = haPhotosActive(cfg);
    const saver = cfg.config.screensaver;
    const night =
      cfg.source === "ha"
        ? nightWindowFromEnv({
            NIGHT_START: cfg.config.schedule.night_start,
            NIGHT_END: cfg.config.schedule.night_end,
            SLEEP_TZ: cfg.config.schedule.timezone,
          })
        : nightWindowFromEnv();
    if (!data.force && lastPhoto && isNight(new Date(), night))
      return { ...lastPhoto, sample: false, result: await readings };
    // No picture library gives a photo: black-and-white art from Unsplash, else the bundled sample.
    const fallback = async (note?: string): Promise<ScreensaverResult> => {
      const online =
        saver.fallback === "unsplash"
          ? await onlinePhoto({ key: saver.unsplash_key, query: saver.unsplash_query })
          : null;
      if (online) {
        lastPhoto = { image: online.image, assetId: null, marked: 0, credit: online.credit };
        return { ...lastPhoto, sample: false, result: await readings };
      }
      return { image: null, sample: true, ...(note ? { note } : {}), result: await readings };
    };
    if (!viaHa && !immichConfigured()) return fallback();
    try {
      const local = () =>
        randomFavorite().then((p) => {
          rememberServed(p.assetId, "local");
          return p;
        });
      const pickHa = () =>
        haPickPhoto(lastPhoto?.assetId ?? null).then(
          (p) => {
            rememberServed(p.assetId, "ha");
            return p;
          },
          (e: unknown) => {
            // HA has no photos at all (HA's Immich entry not added yet, or not loaded) or HA is unreachable (e.g.
            // restarting): the panel's own Immich connection, as before. "Everything skipped" (candidates > 0) is
            // respected, no fallback.
            const allSkipped = e instanceof NoHaPhoto && e.candidates > 0;
            if (!allSkipped && immichConfigured()) {
              const why = e instanceof Error ? e.message : String(e);
              console.warn(
                `[screensaver] no photo from Home Assistant (${why}); using Immich directly`,
              );
              return local();
            }
            throw e;
          },
        );
      const [photo, result] = await Promise.all([viaHa ? pickHa() : local(), readings]);
      lastPhoto = { image: photo.image, assetId: photo.assetId, marked: photo.marked };
      return {
        image: photo.image,
        assetId: photo.assetId,
        marked: photo.marked,
        sample: false,
        result,
      };
    } catch (e) {
      console.error("Screensaver photo failed:", e);
      return fallback(viaHa ? "No photo from Home Assistant" : "Immich unreachable");
    }
  });

/** F1 on the screensaver: keep (looks good on e-ink); F4: skip for good. A photo Home Assistant served is marked in
 *  HA (kindle_panel); a photo from the app's own Immich (no HA config, or the fallback while HA gives no photo) is
 *  marked in the local marks file, which that picker filters on and counts. */
export const markScreensaverPhoto = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.string().min(1).max(512),
      verdict: z.enum(["keep", "skip"]).default("keep"),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; marked: number; error?: string }> => {
    try {
      const cfg = await ensurePanelConfig();
      if (markRouter.storeFor(data.id, haPhotosActive(cfg)) === "ha")
        return { ok: true, marked: await haMarkPhoto(data.id, data.verdict) };
      if (!/^[A-Za-z0-9-]{1,64}$/.test(data.id)) return { ok: false, marked: 0, error: "bad id" };
      return { ok: true, marked: await markFavorite(data.id, data.verdict) };
    } catch (e) {
      return { ok: false, marked: 0, error: errorMessage(e) };
    }
  });
