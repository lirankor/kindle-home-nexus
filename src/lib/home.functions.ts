import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseLang } from "@/lib/i18n";
import { LIGHT_IDS, MEDIA_IDS, MEDIA_OPS, ROOM_IDS, SWITCH_IDS } from "@/lib/home";
import type { Action, ActionResult, Snapshot, SnapshotResult } from "@/lib/home";
import {
  errorMessage,
  haConfigured,
  immichConfigured,
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
  if (!haConfigured()) return { configured: false, snapshot: null, lang };
  try {
    return { configured: true, snapshot: await readSnapshot(), lang };
  } catch (e) {
    return { configured: true, error: errorMessage(e), snapshot: null, lang };
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
  sample: boolean;
  note?: string;
  result: SnapshotResult;
};

export const getScreensaver = createServerFn({ method: "GET" }).handler(
  async (): Promise<ScreensaverResult> => {
    const readings = snapshotResult();
    if (!immichConfigured()) return { image: null, sample: true, result: await readings };
    try {
      const [image, result] = await Promise.all([randomFavorite(), readings]);
      return { image, sample: false, result };
    } catch (e) {
      console.error("Immich screensaver failed:", e);
      return { image: null, sample: true, note: "Immich unreachable", result: await readings };
    }
  },
);
