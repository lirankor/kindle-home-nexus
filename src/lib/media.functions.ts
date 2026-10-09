// Server functions for the media screens. Handlers stay thin: validate, call media.server, shape the result.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseLang } from "@/lib/i18n";
import {
  AMP,
  AMP_SOURCES,
  MUSIC_TABS,
  RADIO_LIST_IDS,
  RADIO_STATION_IDS,
  demoMediaSnapshot,
  demoRadioLists,
} from "@/lib/media";
import type {
  MediaAction,
  MediaActionResult,
  MediaSnapshot,
  MediaSnapshotResult,
  MusicListResult,
  PowerOnStatus,
  QueueProgress,
  RadioListsResult,
  RadioPosition,
} from "@/lib/media";
import { haConfigured } from "./home.server";
import {
  ampConfigured,
  getQueueProgress,
  jellyfinConfigured,
  mediaErrorMessage,
  performMediaAction,
  playSelection,
  powerOnStatus,
  readMediaSnapshot,
  readMusicList,
  readRadioLists,
  startPowerOn,
  tuneRadio,
} from "./media.server";

const sourceSchema = z.enum(AMP_SOURCES);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("amp.power"), on: z.boolean() }),
  z.object({ type: z.literal("amp.source"), source: sourceSchema }),
  z.object({ type: z.literal("amp.volume.step"), delta: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({
    type: z.literal("amp.volume.db"),
    db: z.number().min(AMP.volumeMinDb).max(AMP.volumeMaxDb),
  }),
  z.object({ type: z.literal("amp.volume.set"), level: z.number().min(0).max(1) }),
  z.object({ type: z.literal("amp.reload") }),
  z.object({ type: z.literal("plug"), on: z.boolean() }),
  z.object({ type: z.literal("tv"), op: z.enum(["turn_on", "turn_off", "toggle", "volume_mute"]) }),
  z.object({ type: z.literal("movie"), on: z.boolean() }),
  z.object({ type: z.literal("fm.preset"), preset: z.number().int().min(1).max(40) }),
  z.object({ type: z.literal("fm.frequency"), mhz: z.number().min(87.5).max(108) }),
  z.object({ type: z.literal("radio.step"), delta: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({
    type: z.literal("radio.favourite"),
    stationId: z.enum(RADIO_STATION_IDS),
    add: z.boolean(),
  }),
  z.object({ type: z.literal("radio.playback"), op: z.enum(["play", "stop"]) }),
  z.object({
    type: z.literal("queue"),
    op: z.enum(["next", "prev", "pause", "resume", "toggle", "stop"]),
  }),
  z.object({ type: z.literal("all_off") }),
]);

const flags = () => ({ amp: ampConfigured(), jellyfin: jellyfinConfigured() });
/** Actions that only need the amp's own HTTP APIs or our queue, not Home Assistant. */
const needsHa = (a: MediaAction) =>
  !["fm.frequency", "radio.step", "radio.favourite", "radio.playback", "queue"].includes(a.type);

async function snapshotResult(): Promise<MediaSnapshotResult> {
  const lang = parseLang(process.env["UI_LANGUAGE"]);
  if (!haConfigured())
    return { configured: false, ...flags(), snapshot: demoMediaSnapshot(), lang };
  try {
    return { configured: true, ...flags(), snapshot: await readMediaSnapshot(), lang };
  } catch (e) {
    return { configured: true, ...flags(), error: mediaErrorMessage(e), snapshot: null, lang };
  }
}

export const getMediaSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MediaSnapshotResult> => snapshotResult(),
);

export const runMediaAction = createServerFn({ method: "POST" })
  .validator(actionSchema)
  .handler(async ({ data }): Promise<MediaActionResult> => {
    const action = data as MediaAction;
    if (!haConfigured() && needsHa(action)) return { ok: false, error: "HA not configured" };
    try {
      await performMediaAction(action);
    } catch (e) {
      return { ok: false, error: mediaErrorMessage(e) };
    }
    if (!haConfigured()) return { ok: true, snapshot: demoMediaSnapshot() };
    await new Promise((r) => setTimeout(r, 400)); // let HA publish the new state
    let snapshot: MediaSnapshot | null = null;
    try {
      snapshot = await readMediaSnapshot();
    } catch {
      /* the client will refetch */
    }
    return { ok: true, snapshot };
  });

export const getRadioLists = createServerFn({ method: "GET" }).handler(
  async (): Promise<RadioListsResult> => {
    if (!ampConfigured() && !haConfigured()) return demoRadioLists();
    return readRadioLists();
  },
);

export type TuneResult = { ok: boolean; error?: string; current?: RadioPosition };
export const tuneRadioStation = createServerFn({ method: "POST" })
  .validator(z.object({ list: z.enum(RADIO_LIST_IDS), index: z.number().int().min(0) }))
  .handler(async ({ data }): Promise<TuneResult> => {
    try {
      return { ok: true, current: await tuneRadio(data.list, data.index) };
    } catch (e) {
      return { ok: false, error: mediaErrorMessage(e) };
    }
  });

export const getMusicLists = createServerFn({ method: "GET" })
  .validator(z.object({ tab: z.enum(MUSIC_TABS), page: z.number().int().min(0).default(0) }))
  .handler(async ({ data }): Promise<MusicListResult> => {
    try {
      return await readMusicList(data.tab, data.page);
    } catch (e) {
      return {
        configured: true,
        error: mediaErrorMessage(e),
        tab: data.tab,
        page: data.page,
        pages: 1,
        items: [],
      };
    }
  });

export type PlayResult = { ok: boolean; error?: string; queue?: QueueProgress | null };
export const playMusic = createServerFn({ method: "POST" })
  .validator(
    z.object({ kind: z.enum(["album", "artist", "track", "mix"]), id: z.string().min(1).max(64) }),
  )
  .handler(async ({ data }): Promise<PlayResult> => {
    try {
      return { ok: true, queue: await playSelection(data) };
    } catch (e) {
      return { ok: false, error: mediaErrorMessage(e) };
    }
  });

export const getQueueState = createServerFn({ method: "GET" }).handler(
  async (): Promise<QueueProgress | null> => getQueueProgress(),
);

export type PowerOnResult = { ok: boolean; error?: string; status: PowerOnStatus | null };
export const startAmpPowerOn = createServerFn({ method: "POST" })
  .validator(z.object({ source: sourceSchema.optional() }).default({}))
  .handler(async ({ data }): Promise<PowerOnResult> => {
    if (!haConfigured()) return { ok: false, error: "HA not configured", status: null };
    try {
      return { ok: true, status: await startPowerOn(data.source) };
    } catch (e) {
      return { ok: false, error: mediaErrorMessage(e), status: powerOnStatus() };
    }
  });

export const getPowerOnStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<PowerOnStatus | null> => powerOnStatus(),
);
