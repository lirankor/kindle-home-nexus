import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseLang } from "@/lib/i18n";
import { isNight, nightWindowFromEnv, photoMinutesFromEnv } from "@/lib/night-window";
import { LIGHT_IDS, MEDIA_IDS, MEDIA_OPS, ROOM_IDS, SWITCH_IDS } from "@/lib/home";
import type { Action, ActionResult, Snapshot, SnapshotResult } from "@/lib/home";
import {
  errorMessage,
  haConfigured,
  immichConfigured,
  markFavorite,
  performAction,
  randomFavorite,
  readSnapshot,
} from "./home.server";

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("light.toggle"), entity: z.enum(LIGHT_IDS) }),
  z.object({
    type: z.literal("light.brightness"),
    entity: z.enum(LIGHT_IDS),
    pct: z.number().int().min(1).max(100),
  }),
  z.object({
    type: z.literal("light.kelvin"),
    entity: z.enum(LIGHT_IDS),
    kelvin: z.number().int().min(1500).max(9000),
  }),
  z.object({
    type: z.literal("light.color"),
    entity: z.enum(LIGHT_IDS),
    color: z.enum(["White", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"]),
  }),
  z.object({ type: z.literal("lights.off") }),
  z.object({ type: z.literal("scene"), name: z.enum(["Bright", "Evening", "Movie"]) }),
  z.object({ type: z.literal("movie.end") }),
  z.object({ type: z.literal("vacuum"), op: z.enum(["start", "pause", "dock", "locate"]) }),
  z.object({ type: z.literal("room.toggle"), entity: z.enum(ROOM_IDS) }),
  z.object({ type: z.literal("rooms.clear") }),
  z.object({ type: z.literal("switch.toggle"), entity: z.enum(SWITCH_IDS) }),
  z.object({ type: z.literal("media"), entity: z.enum(MEDIA_IDS), op: z.enum(MEDIA_OPS) }),
]);

async function snapshotResult(): Promise<SnapshotResult> {
  // Read per request so UI_LANGUAGE can change without a rebuild.
  const lang = parseLang(process.env["UI_LANGUAGE"]);
  const photoMinutes = photoMinutesFromEnv();
  if (!haConfigured()) return { configured: false, snapshot: null, lang, photoMinutes };
  try {
    return { configured: true, snapshot: await readSnapshot(), lang, photoMinutes };
  } catch (e) {
    return { configured: true, error: errorMessage(e), snapshot: null, lang, photoMinutes };
  }
}

export const getSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<SnapshotResult> => snapshotResult(),
);

export const runAction = createServerFn({ method: "POST" })
  .validator(actionSchema)
  .handler(async ({ data }): Promise<ActionResult> => {
    if (!haConfigured()) return { ok: false, error: "HA not configured" };
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
  result: SnapshotResult;
};

// The photo shown last, kept so the night window (NIGHT_START–NIGHT_END local, see night-window.ts)
// can serve the same picture again: no photo rotation at night while the Kindle sleeps. An explicit
// F1 (mark) / F4 (skip) on the saver passes `force` and always gets a new one.
let lastPhoto: { image: string; assetId: string; marked: number } | null = null;

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
    if (!immichConfigured()) return { image: null, sample: true, result: await readings };
    try {
      if (!data.force && lastPhoto && isNight(new Date(), nightWindowFromEnv()))
        return { ...lastPhoto, sample: false, result: await readings };
      const [photo, result] = await Promise.all([randomFavorite(), readings]);
      lastPhoto = { image: photo.image, assetId: photo.assetId, marked: photo.marked };
      return {
        image: photo.image,
        assetId: photo.assetId,
        marked: photo.marked,
        sample: false,
        result,
      };
    } catch (e) {
      console.error("Immich screensaver failed:", e);
      return { image: null, sample: true, note: "Immich unreachable", result: await readings };
    }
  });

/** F1 on the screensaver: mark the shown favourite as good on e-ink. It is never shown again. */
export const markScreensaverPhoto = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }))
  .handler(async ({ data }): Promise<{ ok: boolean; marked: number; error?: string }> => {
    try {
      return { ok: true, marked: await markFavorite(data.id) };
    } catch (e) {
      return { ok: false, marked: 0, error: errorMessage(e) };
    }
  });
