// Server-only media stack: Yamaha R-N500 XML + UPnP AVTransport clients, YTuner (NET RADIO backend),
// Jellyfin, grayscale image cache, the Jellyfin playback queue and the amp power-on job.
// Env vars are read per request from process.env and never reach the browser. Nothing runs at import time;
// without AMP_HOST / JELLYFIN_* the callers fall back to demo data (see media.functions.ts).
import { createHash } from "node:crypto";
import { makeT, parseLang } from "@/lib/i18n";
import type { Key } from "@/lib/i18n";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { HomeError, fetchStates, ha, haConfigured, service } from "@/lib/home.server";
import { resolveStationArt } from "@/lib/station-art";
import {
  PLAY_CONFIRM_MS,
  STALL_CONFIRM_MS,
  STALL_MAX_RETRIES,
  STALL_REASON,
  SkipCoalescer,
  TransportLock,
  decideResume,
  freshStall,
  rendererIdle,
  stallStep,
} from "@/lib/queue-transport";
import type { StallState } from "@/lib/queue-transport";
import { classifyAmpError, describeProbe, sendWithRetries, waitUntilReady } from "@/lib/power-on";
import type { AmpProbe } from "@/lib/power-on";
import { AMP_XML_GRACE_MS, deriveAmpPower, shouldCyclePlug } from "@/lib/amp-state";
import type { AmpPowerVerdict } from "@/lib/amp-state";
import type { CoverParams, StationArtResult, StationArtSource } from "@/lib/station-art";
import type { HaState } from "@/lib/home.server";
import {
  AMP,
  CATALOG_LOGO_HOSTS,
  FAVOURITES_LIST_ID,
  MIX_IDS,
  MUSIC_PAGE_SIZE,
  RADIO_LISTS,
  SEARCH_MIN_CHARS,
  SEARCH_RESULT_ROWS,
  demoArtistAlbums,
  demoMusicList,
  demoMusicSearch,
  demoTracks,
  findStation,
  isAmpSource,
} from "@/lib/media";
import type {
  AmpSource,
  ArtistAlbumsResult,
  MediaAction,
  MediaSnapshot,
  MixId,
  MusicListItem,
  MusicListResult,
  MusicSearchResult,
  MusicTab,
  MusicTrack,
  NowPlaying,
  PlaySelection,
  PowerOnStatus,
  PowerOnStep,
  QueueProgress,
  QueueState,
  QueueTrack,
  RadioListsResult,
  RadioPosition,
  RadioStationView,
  QueueList,
} from "@/lib/media";
import {
  trackIdFromUri,
  AVT_SERVICE,
  artUrlFor,
  buildDidl,
  decideAdvance,
  decideVerify,
  fmFrequencyXml,
  formatHms,
  inputSelXml,
  netRadioControlXml,
  normalizeStreamUrl,
  parseBasicStatus,
  parseListInfo,
  parseNetRadioPlayInfo,
  parsePositionInfo,
  parseTransportInfo,
  parseTunerPlayInfo,
  parseYtunerStations,
  pickStreamUrl,
  QUEUE_END_STOP_MS,
  queueAdvance,
  queueDue,
  queueJump,
  queueProgress,
  rewriteToBase,
  soapEnvelope,
  soapFaultCode,
  streamMime,
  yamahaCmd,
  yamahaRc,
  stripStream,
} from "@/lib/media-protocol";
import type { ListInfo, NetRadioPlayInfo, PositionInfo, YtunerStation } from "@/lib/media-protocol";

// ---- Config ----
const env = (name: string) => (process.env[name] ?? "").trim().replace(/\/+$/, "");
export const ampConfigured = () => env("AMP_HOST") !== "";
export const jellyfinConfigured = () =>
  env("JELLYFIN_URL") !== "" && env("JELLYFIN_API_KEY") !== "" && env("JELLYFIN_USER_ID") !== "";
const ampBase = () => `http://${env("AMP_HOST")}`;
const ytunerBase = () => env("YTUNER_URL") || "http://ytuner";
/** The host YTuner advertises in every URL (ActAsHost); we must send it as Host when talking to it. */
export const YTUNER_HOST = "radioyamaha.vtuner.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain http GET via node:http: unlike fetch (undici) it lets us set the Host header YTuner keys on. */
export function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 6000,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

export class MediaError extends Error {}
export class UpnpError extends MediaError {
  constructor(public code: string) {
    super(`UPnP ${code}`);
  }
}
export const mediaErrorMessage = (e: unknown) =>
  e instanceof MediaError || e instanceof HomeError ? e.message : "Media error";

// ---- Process-wide runtime (survives HMR via globalThis) ----
type Persisted = {
  queue: QueueState | null;
  lastSource: AmpSource | null;
  radio: RadioPosition | null;
};
type Runtime = {
  persisted: Persisted | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  queueTimer: ReturnType<typeof setInterval> | null;
  queueBusy: boolean;
  /** Ticks since the last check of the amp against our queue clock. */
  queueTicks: number;
  /** Renderer stall watchdog (see queue-transport.ts) and the last replay error for the stall reason. */
  stall: StallState;
  stallReason: string | null;
  /** Unplayable tracks skipped in a row by the watchdog (reset once something plays). */
  stallSkips: number;
  powerOn: PowerOnStatus | null;
  /** The running power-on routine (settles when it reaches done / failed); callers can await it. */
  powerOnJob: Promise<PowerOnStatus | null> | null;
  ytunerIds: { at: number; byUrl: Map<string, YtunerStation> } | null;
  mixes: { day: string; builtAt: number; items: Map<MixId, MusicTrack[]> } | null;
  mixBuilding: Promise<Map<MixId, MusicTrack[]>> | null;
  mixTimer: ReturnType<typeof setInterval> | null;
  lists: Map<string, { at: number; items: MusicListItem[] }>;
  imgNegative: Map<string, number>;
  /** Station art resolution memo (source null = nothing found, retried after ART_RETRY_MS). */
  stationArt?: Map<
    string,
    { at: number; source: StationArtSource | null; standIn?: StationArtResult }
  >;
};
const g = globalThis as unknown as {
  __kindleMediaRuntime?: Runtime;
  __kindleMediaFlushHook?: boolean;
};
const rt: Runtime = (g.__kindleMediaRuntime ??= {
  persisted: null,
  saveTimer: null,
  queueTimer: null,
  queueBusy: false,
  queueTicks: 0,
  stall: freshStall(),
  stallReason: null,
  stallSkips: 0,
  powerOn: null,
  powerOnJob: null,
  ytunerIds: null,
  mixes: null,
  mixBuilding: null,
  mixTimer: null,
  lists: new Map(),
  imgNegative: new Map(),
  stationArt: new Map(),
});
// Fields added after a dev-server HMR reload of an older runtime object.
rt.stall ??= freshStall();
rt.stallReason ??= null;
rt.stallSkips ??= 0;

// ---- Persistence (MEDIA_STATE_DIR, default os.tmpdir()) ----
const stateFile = () => path.join(env("MEDIA_STATE_DIR") || os.tmpdir(), "kindle-media-state.json");
async function loadState(): Promise<Persisted> {
  if (rt.persisted) return rt.persisted;
  let p: Persisted = { queue: null, lastSource: null, radio: null };
  try {
    const raw = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<Persisted>;
    p = {
      queue: raw.queue ?? null,
      lastSource: isAmpSource(raw.lastSource) ? raw.lastSource : null,
      radio: raw.radio ?? null,
    };
    // A queue that was playing when the process died has lost its clock: keep it and re-sync with the amp.
    if (p.queue && p.queue.status === "playing") {
      p.queue = { ...p.queue, startedAt: null, nextPushed: false };
      setTimeout(() => void reconcileQueueWithAmp(), 1500).unref?.();
      ensureQueueTimer();
    }
  } catch {
    /* first run */
  }
  rt.persisted = p;
  return p;
}
function saveState() {
  if (rt.saveTimer) clearTimeout(rt.saveTimer);
  rt.saveTimer = setTimeout(() => {
    rt.saveTimer = null;
    const file = stateFile();
    void mkdir(path.dirname(file), { recursive: true })
      .then(() => writeFile(file, JSON.stringify(rt.persisted ?? {}), "utf8"))
      .catch((e: unknown) => console.error("media state save failed:", e));
  }, 300);
  rt.saveTimer.unref?.();
}
/** Synchronous write, used for queue changes and on shutdown: a debounced save was lost on every deploy. */
function saveStateNow() {
  if (rt.saveTimer) {
    clearTimeout(rt.saveTimer);
    rt.saveTimer = null;
  }
  try {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rt.persisted ?? {}), "utf8");
  } catch (e) {
    console.error("media state save failed:", e);
  }
}
if (!g.__kindleMediaFlushHook) {
  g.__kindleMediaFlushHook = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.once(sig, () => {
      saveStateNow();
      process.kill(process.pid, sig);
    });
}
async function patchState(patch: Partial<Persisted>) {
  const p = await loadState();
  Object.assign(p, patch);
  if ("queue" in patch) saveStateNow();
  else saveState();
  return p;
}

// ---- Amp XML API ----
/** Menu steps on the amp need ≥1.5 s before Menu_Status is meaningful (verified on the device). */
export const STEP_SETTLE_MS = 1500;

async function ampXml(cmd: "GET" | "PUT", inner: string, timeoutMs = 5000): Promise<string> {
  if (!ampConfigured()) throw new MediaError("Amp not configured");
  let res: Response;
  try {
    res = await fetch(`${ampBase()}/YamahaRemoteControl/ctrl`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: yamahaCmd(cmd, inner),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MediaError("Amp unreachable");
  }
  if (!res.ok) throw new MediaError(`Amp HTTP ${res.status}`);
  const text = await res.text();
  const rc = yamahaRc(text);
  if (rc !== 0) throw new MediaError(`Amp RC ${rc}`);
  return text;
}

export const amp = {
  basicStatus: async () =>
    parseBasicStatus(
      await ampXml("GET", "<Main_Zone><Basic_Status>GetParam</Basic_Status></Main_Zone>"),
    ),
  listInfo: async () =>
    parseListInfo(await ampXml("GET", "<NET_RADIO><List_Info>GetParam</List_Info></NET_RADIO>")),
  playInfo: async () =>
    parseNetRadioPlayInfo(
      await ampXml("GET", "<NET_RADIO><Play_Info>GetParam</Play_Info></NET_RADIO>"),
    ),
  tunerInfo: async () =>
    parseTunerPlayInfo(await ampXml("GET", "<Tuner><Play_Info>GetParam</Play_Info></Tuner>")),
  setFmFrequency: (mhz: number) => ampXml("PUT", fmFrequencyXml(mhz)),
  selectInput: (input: AmpSource) => ampXml("PUT", inputSelXml(input)),
  /** Power on / standby through the XML API (works even when HA's yamaha_ynca link is down). */
  power: (on: boolean) =>
    ampXml(
      "PUT",
      `<Main_Zone><Power_Control><Power>${on ? "On" : "Standby"}</Power></Power_Control></Main_Zone>`,
    ),
  /** Main zone volume in dB (0.5 dB steps), same shape as Basic_Status reports it. */
  setVolumeDb: (db: number) => {
    const v = Math.round(Math.max(AMP.volumeMinDb, Math.min(AMP.volumeMaxDb, db)) * 2) / 2;
    return ampXml(
      "PUT",
      `<Main_Zone><Volume><Lvl><Val>${Math.round(v * 10)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume></Main_Zone>`,
    );
  },
  returnToHome: () => ampXml("PUT", netRadioControlXml("<Cursor>Return to Home</Cursor>")),
  /** Select window line k (1..8) of the current page; only used for the fixed top menu. */
  directSel: (k: number) => ampXml("PUT", netRadioControlXml(`<Direct_Sel>Line_${k}</Direct_Sel>`)),
  /** Move the cursor to absolute line n (1-based, any page). */
  jumpLine: (n: number) => ampXml("PUT", netRadioControlXml(`<Jump_Line>${n}</Jump_Line>`)),
  cursorSel: () => ampXml("PUT", netRadioControlXml("<Cursor>Sel</Cursor>")),
  /** NET RADIO stream: Playback Play / Stop (Enter on the radio screen). */
  netRadioPlayback: (op: "play" | "stop") =>
    ampXml(
      "PUT",
      `<NET_RADIO><Play_Control><Playback>${op === "play" ? "Play" : "Stop"}</Playback></Play_Control></NET_RADIO>`,
    ),
  /** Poll List_Info until Menu_Status is Ready (after an initial settle delay). */
  async waitReady(settleMs = STEP_SETTLE_MS, timeoutMs = 12000): Promise<ListInfo> {
    if (settleMs > 0) await sleep(settleMs);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const info = await amp.listInfo();
      if (info.status === "Ready") return info;
      if (Date.now() > until) throw new MediaError("Amp menu busy");
      await sleep(500);
    }
  },
  /** Tune by index: Jump_Line n, wait, Cursor Sel, wait. */
  async jumpLineAndSelect(n: number): Promise<ListInfo> {
    await amp.jumpLine(n);
    await amp.waitReady();
    await amp.cursorSel();
    return amp.waitReady();
  },
};

// ---- UPnP AVTransport (SOAP) ----
async function avt(action: string, args: Record<string, string | number> = {}): Promise<string> {
  if (!ampConfigured()) throw new MediaError("Amp not configured");
  let res: Response;
  try {
    res = await fetch(`${ampBase()}:8080/AVTransport/ctrl`, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${AVT_SERVICE}#${action}"`,
      },
      body: soapEnvelope(action, args),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new MediaError("Amp unreachable");
  }
  const text = await res.text();
  if (!res.ok) throw new UpnpError(soapFaultCode(text) ?? String(res.status));
  return text;
}
export const avTransport = {
  setUri: (url: string, didl: string) =>
    avt("SetAVTransportURI", { CurrentURI: url, CurrentURIMetaData: didl }),
  setNextUri: (url: string, didl: string) =>
    avt("SetNextAVTransportURI", { NextURI: url, NextURIMetaData: didl }),
  play: () => avt("Play", { Speed: 1 }),
  /** Pause answers 501 on pushed streams; Stop is the only way to halt. */
  stop: () => avt("Stop"),
  seek: (ms: number) => avt("Seek", { Unit: "REL_TIME", Target: formatHms(ms) }),
  positionInfo: async () => parsePositionInfo(await avt("GetPositionInfo")),
  transportInfo: async () => parseTransportInfo(await avt("GetTransportInfo")),
};

// ---- YTuner ----
const YT_QS = "ytuner=true&mac=KINDLE&fver=W&dlang=eng&startitems=1&enditems=100";
async function ytunerGet(pathAndQuery: string): Promise<string> {
  let res: { status: number; body: Buffer };
  try {
    res = await httpGet(`${ytunerBase()}${pathAndQuery}`, { Host: YTUNER_HOST });
  } catch {
    throw new MediaError("YTuner unreachable");
  }
  if (res.status === 404) return ""; // an empty bookmark list answers 404 with no body
  if (res.status < 200 || res.status >= 300) throw new MediaError(`YTuner HTTP ${res.status}`);
  return res.body.toString("utf8");
}
export const ytuner = {
  listCategoryStations: async (category: string) =>
    parseYtunerStations(
      await ytunerGet(`/ytuner/mystations/${encodeURIComponent(category)}?${YT_QS}`),
    ),
  listBookmarks: async () => parseYtunerStations(await ytunerGet(`/ytuner/bookmark?${YT_QS}`)),
  /** GET the station's Bookmark URL (rewritten from the advertised host to our base). */
  addBookmark: (station: YtunerStation) =>
    ytunerGet(
      station.bookmark
        ? rewriteToBase(station.bookmark, "")
        : `/setupapp/favxml.asp?id=${encodeURIComponent(station.id)}&fav=add`,
    ),
  /** Not verified on the device yet: mirrors the add URL with fav=del. */
  removeBookmark: (stationId: string) =>
    ytunerGet(`/setupapp/favxml.asp?id=${encodeURIComponent(stationId)}&fav=del`),
  /** Catalog stream URL -> YTuner station, by walking every My Stations category (cached 10 min). */
  async stationsByUrl(): Promise<Map<string, YtunerStation>> {
    if (rt.ytunerIds && Date.now() - rt.ytunerIds.at < 10 * 60_000) return rt.ytunerIds.byUrl;
    const byUrl = new Map<string, YtunerStation>();
    const lists = await Promise.all(
      RADIO_LISTS.map((l) => ytuner.listCategoryStations(l.ytunerCategory)),
    );
    for (const s of lists.flat()) byUrl.set(normalizeStreamUrl(s.url), s);
    rt.ytunerIds = { at: Date.now(), byUrl };
    return byUrl;
  },
};

// ---- Jellyfin ----
type JfItem = {
  Id: string;
  Name: string;
  Type?: string;
  Album?: string;
  AlbumId?: string;
  Artists?: string[];
  AlbumArtist?: string;
  RunTimeTicks?: number;
  Container?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
  AlbumArtists?: { Id: string; Name: string }[];
  ChildCount?: number;
  Genres?: string[];
};
type JfList = { Items?: JfItem[]; TotalRecordCount?: number };

async function jf<T>(
  p: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  if (!jellyfinConfigured()) throw new MediaError("Jellyfin not configured");
  const url = new URL(`${env("JELLYFIN_URL")}${p}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `MediaBrowser Token="${env("JELLYFIN_API_KEY")}"` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MediaError("Jellyfin unreachable");
  }
  if (!res.ok) throw new MediaError(`Jellyfin error ${res.status}`);
  return (await res.json()) as T;
}
const userItems = async (params: Record<string, string | number | boolean>) =>
  (await jf<JfList>(`/Users/${env("JELLYFIN_USER_ID")}/Items`, params)).Items ?? [];

export const toTrack = (i: JfItem): MusicTrack => ({
  id: i.Id,
  title: i.Name,
  artist: i.Artists?.[0] ?? i.AlbumArtist ?? null,
  album: i.Album ?? null,
  albumId: i.AlbumId ?? null,
  durationMs: Math.round((i.RunTimeTicks ?? 0) / 10_000),
  container: i.Container ?? null,
  // Album cover, else the track's own image, else the album artist's picture (as albumArtOf does for the lists):
  // 941 of 2337 albums here have no cover, 573 of 881 album artists have a picture (2026-10-14).
  artItemId:
    i.AlbumId && i.AlbumPrimaryImageTag
      ? i.AlbumId
      : i.ImageTags?.["Primary"]
        ? i.Id
        : (i.AlbumArtists?.[0]?.Id ?? null),
});
const artOf = (i: JfItem) => (i.ImageTags?.["Primary"] ? i.Id : null);
/** Albums without their own cover (about 40 % here) fall back to the album artist's picture. */
const albumArtOf = (i: JfItem) => artOf(i) ?? i.AlbumArtists?.[0]?.Id ?? null;
const albumItem = (i: JfItem): MusicListItem => ({
  kind: "album",
  id: i.Id,
  title: i.Name,
  detail: [i.AlbumArtist, i.ProductionYear].filter(Boolean).join(" · "),
  artItemId: albumArtOf(i),
});
const trackItem = (t: MusicTrack): MusicListItem => ({
  kind: "track",
  id: t.id,
  title: t.title,
  detail: [t.artist, t.album].filter(Boolean).join(" · "),
  artItemId: t.artItemId,
});

export const jellyfin = {
  randomTracks: async (limit: number, extra: Record<string, string> = {}) =>
    (
      await userItems({
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: limit,
        ...extra,
      })
    ).map(toTrack),
  randomAlbums: async (limit: number) =>
    (
      await userItems({
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        SortBy: "Random",
        Limit: limit,
      })
    ).map(albumItem),
  randomAlbumArtists: async (limit: number): Promise<MusicListItem[]> =>
    (
      (
        await jf<JfList>("/Artists/AlbumArtists", {
          userId: env("JELLYFIN_USER_ID"),
          sortBy: "Random",
          limit,
        })
      ).Items ?? []
    ).map((i) => ({ kind: "artist", id: i.Id, title: i.Name, detail: "", artItemId: artOf(i) })),
  /** Jellyfin's searchTerm matches the start of any word in the name ("son" finds "Sons of Anarchy"). */
  searchAlbumArtists: async (term: string, limit: number): Promise<MusicListItem[]> =>
    (
      (
        await jf<JfList>("/Artists/AlbumArtists", {
          userId: env("JELLYFIN_USER_ID"),
          searchTerm: term,
          limit,
        })
      ).Items ?? []
    ).map((i) => ({ kind: "artist", id: i.Id, title: i.Name, detail: "", artItemId: artOf(i) })),
  searchAlbums: async (term: string, limit: number): Promise<MusicListItem[]> =>
    (
      await userItems({
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        searchTerm: term,
        SortBy: "SortName",
        Limit: limit,
      })
    ).map(albumItem),
  albumTracks: async (albumId: string) =>
    (await userItems({ ParentId: albumId, IncludeItemTypes: "Audio", SortBy: "SortName" })).map(
      toTrack,
    ),
  /** The artist's albums, oldest first, with year, first genre and track count. The count comes from
   *  one query over the artist's songs: Jellyfin's `ChildCount` field runs a query per album and took
   *  1.6–6.6 s for seven albums, this takes about 30 ms. */
  artistAlbums: async (artistId: string): Promise<MusicListItem[]> => {
    const [albums, songs] = await Promise.all([
      userItems({
        AlbumArtistIds: artistId,
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        SortBy: "ProductionYear,SortName",
        SortOrder: "Ascending",
        Fields: "Genres,ProductionYear,PremiereDate",
      }),
      userItems({
        AlbumArtistIds: artistId,
        IncludeItemTypes: "Audio",
        Recursive: true,
        EnableImages: false,
        EnableUserData: false,
        Limit: 2000,
      }),
    ]);
    const counts = new Map<string, number>();
    for (const song of songs)
      if (song.AlbumId) counts.set(song.AlbumId, (counts.get(song.AlbumId) ?? 0) + 1);
    return albums.map((i) => ({
      kind: "album",
      id: i.Id,
      title: i.Name,
      detail: "",
      artItemId: albumArtOf(i),
      year: i.ProductionYear ?? null,
      releaseDate: i.PremiereDate?.slice(0, 10) ?? null,
      trackCount: counts.get(i.Id) ?? null,
      genre: i.Genres?.[0] ?? null,
    }));
  },
  artistItem: async (artistId: string): Promise<JfItem> =>
    jf<JfItem>(`/Users/${env("JELLYFIN_USER_ID")}/Items/${encodeURIComponent(artistId)}`),
  /** Everything by the artist (as album artist or performer), shuffled, one screenful of a mix. */
  artistTracks: async (artistId: string, limit: number) =>
    (
      await userItems({
        ArtistIds: artistId,
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: limit,
      })
    ).map(toTrack),
  artistRandomAlbum: async (artistId: string) =>
    (
      await userItems({
        AlbumArtistIds: artistId,
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        SortBy: "Random",
        Limit: 1,
      })
    )[0] ?? null,
  instantMix: async (itemId: string, limit: number) =>
    (
      (
        await jf<JfList>(`/Items/${encodeURIComponent(itemId)}/InstantMix`, {
          userId: env("JELLYFIN_USER_ID"),
          limit,
        })
      ).Items ?? []
    ).map(toTrack),
  suggestions: async (limit: number) =>
    (
      (await jf<JfList>(`/Users/${env("JELLYFIN_USER_ID")}/Suggestions`, { type: "Audio", limit }))
        .Items ?? []
    ).map(toTrack),
  recentlyPlayedAlbums: async (limit: number) =>
    (
      await userItems({
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        Filters: "IsPlayed",
        Limit: limit,
      })
    ).map(albumItem),
  genres: async () =>
    (
      (await jf<JfList>("/Genres", { userId: env("JELLYFIN_USER_ID"), IncludeItemTypes: "Audio" }))
        .Items ?? []
    ).map((i) => ({ id: i.Id, name: i.Name })),
  // ---- Voice bridge (src/routes/api/voice.$.ts) — additive, unused by the Kindle screens ----
  /** One page of album artists for the HA dashboard's dropdown picker: alphabetical, or a random handful
   *  (the Kindle's Artists band); `total` = Jellyfin's TotalRecordCount. */
  listAlbumArtists: async (limit: number, offset: number, random: boolean) => {
    const r = await jf<JfList>("/Artists/AlbumArtists", {
      userId: env("JELLYFIN_USER_ID"),
      sortBy: random ? "Random" : "SortName",
      limit,
      startIndex: offset,
    });
    return {
      total: r.TotalRecordCount ?? 0,
      items: (r.Items ?? []).map((i) => ({ id: i.Id, name: i.Name })),
    };
  },
  /** Same for albums (title, album artist, year). */
  listAlbums: async (limit: number, offset: number, random: boolean) => {
    const r = await jf<JfList>(`/Users/${env("JELLYFIN_USER_ID")}/Items`, {
      IncludeItemTypes: "MusicAlbum",
      Recursive: true,
      SortBy: random ? "Random" : "SortName",
      Limit: limit,
      StartIndex: offset,
    });
    return {
      total: r.TotalRecordCount ?? 0,
      items: (r.Items ?? []).map((i) => ({
        id: i.Id,
        title: i.Name,
        artist: i.AlbumArtist ?? null,
        year: i.ProductionYear ?? null,
      })),
    };
  },
  /** Songs whose title starts with a word of the term. */
  searchTracks: async (term: string, limit: number) =>
    (
      await userItems({
        IncludeItemTypes: "Audio",
        Recursive: true,
        searchTerm: term,
        SortBy: "SortName",
        Limit: limit,
      })
    ).map(toTrack),
  searchPlaylists: async (term: string, limit: number): Promise<{ id: string; title: string }[]> =>
    (
      await userItems({
        IncludeItemTypes: "Playlist",
        Recursive: true,
        searchTerm: term,
        SortBy: "SortName",
        Limit: limit,
      })
    ).map((i) => ({ id: i.Id, title: i.Name })),
  playlistTracks: async (playlistId: string) =>
    (
      (
        await jf<JfList>(`/Playlists/${encodeURIComponent(playlistId)}/Items`, {
          userId: env("JELLYFIN_USER_ID"),
        })
      ).Items ?? []
    ).map(toTrack),
  streamUrl: (t: MusicTrack) =>
    pickStreamUrl(env("JELLYFIN_URL"), env("JELLYFIN_API_KEY"), t.id, t.container),
  /** Primary image, no auth needed (the amp and the image route fetch it directly). */
  artUrl: (itemId: string, width = 200) => artUrlFor(env("JELLYFIN_URL"), itemId, width),
  toQueueTrack: (t: MusicTrack): QueueTrack => ({ ...t, streamUrl: jellyfin.streamUrl(t) }),
};

// ---- Images: remote logo / art -> square PNG (grayscale for the e-ink panel, colour for HA), cached on disk ----
const cacheDir = () => env("MEDIA_CACHE_DIR") || path.join(os.tmpdir(), "kindle-media-cache");
const FETCH_UA = "kindle-home-nexus/1.0 (home server radio panel)";
export function imageHostAllowed(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const allowed = new Set<string>([YTUNER_HOST, ...CATALOG_LOGO_HOSTS.map((h) => h.toLowerCase())]);
  for (const v of [env("AMP_HOST"), env("JELLYFIN_URL"), ytunerBase()]) {
    if (!v) continue;
    try {
      allowed.add(new URL(/^https?:\/\//.test(v) ? v : `http://${v}`).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return allowed.has(host);
}
/** A fetch that did not yield an image: transient (rate limit, 5xx, timeout: worth retrying) or final (not an image). */
type ImageMiss = { transient: boolean };
/** Raw bytes of an allow-listed image URL (YTuner-hosted ones via our base with the vTuner Host header). */
async function fetchImageEx(src: string): Promise<{ bytes: Buffer } | ImageMiss> {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { transient: false };
  }
  if (!imageHostAllowed(url)) return { transient: false };
  try {
    if (url.hostname.toLowerCase() === YTUNER_HOST) {
      const r = await httpGet(rewriteToBase(src, ytunerBase()), { Host: YTUNER_HOST }, 10000);
      return r.status === 200
        ? { bytes: r.body }
        : { transient: r.status === 429 || r.status >= 500 };
    }
    // Follow redirects by hand so every hop is re-checked against the allowlist (no SSRF via a redirect).
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": FETCH_UA, Accept: "image/*,*/*;q=0.5" },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return { transient: false };
        current = new URL(loc, current);
        if (!imageHostAllowed(current)) return { transient: false };
        continue;
      }
      res = r;
      break;
    }
    if (!res) return { transient: false };
    if (!res.ok) return { transient: res.status === 429 || res.status >= 500 };
    return { bytes: Buffer.from(await res.arrayBuffer()) };
  } catch {
    return { transient: true }; // network error / timeout
  }
}
async function fetchImage(src: string): Promise<Buffer | null> {
  const r = await fetchImageEx(src);
  return "bytes" in r ? r.bytes : null;
}
type PngMode = "grayscale" | "colour";
/** Decode (which also validates: an HTML page or a broken file throws), flatten, square-fit. */
async function toSquarePng(raw: Buffer, width: number, mode: PngMode): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return mode === "colour"
      ? await sharp(raw)
          .flatten({ background: "#ffffff" })
          .resize(width, width, { fit: "contain", background: "#ffffff" })
          .png({ compressionLevel: 9 })
          .toBuffer()
      : await sharp(raw)
          // Mid-grey tile + contrast stretch: white or very light logos (Smooth Radio, WDR 5, bigFM) otherwise
          // vanish on the 16-grey e-ink panel.
          .flatten({ background: "#bdbdbd" })
          .resize(width, width, { fit: "contain", background: "#bdbdbd" })
          .grayscale()
          .normalise()
          .png({ compressionLevel: 9 })
          .toBuffer();
  } catch {
    return null; // e.g. .ico files sharp cannot decode: the UI shows a placeholder
  }
}
const cacheKey = (parts: string[]) => createHash("sha1").update(parts.join("|")).digest("hex");
async function cachedPng(key: string, make: () => Promise<Buffer | null>): Promise<Buffer | null> {
  const file = path.join(cacheDir(), `${key}.png`);
  try {
    return await readFile(file);
  } catch {
    /* miss */
  }
  const png = await make();
  if (png)
    await mkdir(cacheDir(), { recursive: true })
      .then(() => writeFile(file, png))
      .catch(() => undefined);
  return png;
}
/** Remote image URL -> square PNG (Jellyfin art). */
const urlPng = (src: string, width: number, mode: PngMode) =>
  cachedPng(cacheKey([src, String(width), mode]), async () => {
    const raw = await fetchImage(src);
    return raw ? toSquarePng(raw, width, mode) : null;
  });
/** Grayscale for the e-ink panel. */
export const grayscalePng = (src: string, width: number) => urlPng(src, width, "grayscale");
/** Colour on white (Home Assistant). */
export const colourPng = (src: string, width: number) => urlPng(src, width, "colour");

// ---- Station art: the catalogue logo when it is a real image, else a cover-forge placeholder, else nothing ----
// (chain in src/lib/station-art.ts; this is the wiring: allow-listed fetch, validation by decoding, disk cache)
const coverForgeUrl = () => env("COVER_FORGE_URL").replace(/\/+$/, "");
export const coverForgeConfigured = () => coverForgeUrl() !== "";
/** cover-forge render — colour PNG, deterministic per station (no seed); null when off, down or not an image. */
async function fetchCover(p: CoverParams): Promise<Buffer | null> {
  if (!coverForgeConfigured()) return null;
  const qs = new URLSearchParams({ artist: p.artist, title: p.title, label: p.label, size: "512" });
  if (p.cat) qs.set("cat", p.cat);
  try {
    const token = env("COVER_FORGE_TOKEN");
    const r = await fetch(`${coverForgeUrl()}/cover.png?${qs}`, {
      headers: { "User-Agent": FETCH_UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
/** The logo bytes, only when sharp can decode them (a web page or a dead link is not a logo). Throws on a
 *  transient miss (Wikimedia's 429, a timeout) so the chain knows the cover is only a stand-in. */
async function fetchLogoValidated(url: string): Promise<Buffer | null> {
  const r = await fetchImageEx(url);
  if (!("bytes" in r)) {
    if (r.transient) throw new Error("transient");
    return null;
  }
  try {
    const { default: sharp } = await import("sharp");
    const m = await sharp(r.bytes).metadata();
    return m.width && m.height ? r.bytes : null;
  } catch {
    return null;
  }
}
/** The band's English display name is the cover's "artist" line. */
const bandLabelOf = (stationId: string): string => {
  const list = RADIO_LISTS.find((l) => l.stations.some((s) => s.id === stationId));
  return list ? makeT("en")(`radio.band.${list.id}` as Key) : "Radio";
};
const ART_RETRY_MS = 60 * 60_000;
/** A stand-in cover (logo fetch failed transiently) is served from memory for this long, then the logo is retried. */
const ART_STANDIN_MS = 10 * 60_000;
/** Resolved art for a station (raw logo / cover bytes), kept on disk; a miss is retried after an hour, a stand-in
 *  cover after ten minutes (it is never written to disk, so a rate-limited logo cannot freeze into a cover). */
async function stationArtRaw(stationId: string): Promise<StationArtResult | null> {
  const station = findStation(stationId);
  if (!station) return null;
  const memo = (rt.stationArt ??= new Map());
  const seen = memo.get(stationId);
  if (seen && seen.source === null && Date.now() - seen.at < ART_RETRY_MS) return null;
  if (seen?.standIn && Date.now() - seen.at < ART_STANDIN_MS) return seen.standIn;
  const key = cacheKey(["station-art", stationId, station.logo ?? "", coverForgeUrl()]);
  const dir = path.join(cacheDir(), "station-art");
  for (const source of ["logo", "cover"] as const) {
    try {
      const bytes = await readFile(path.join(dir, `${key}.${source}`));
      memo.set(stationId, { at: Date.now(), source });
      return { bytes, source };
    } catch {
      /* miss */
    }
  }
  const r = await resolveStationArt(station, bandLabelOf(stationId), {
    fetchLogo: fetchLogoValidated,
    fetchCover,
  });
  memo.set(stationId, {
    at: Date.now(),
    source: r?.source ?? null,
    ...(r?.logoTransient ? { standIn: r } : {}),
  });
  if (r && !r.logoTransient)
    await mkdir(dir, { recursive: true })
      .then(() => writeFile(path.join(dir, `${key}.${r.source}`), r.bytes))
      .catch(() => undefined);
  return r;
}
/** What the voice API tells HA: which art a station has (null = none, HA shows its placeholder). */
export async function stationArtSource(stationId: string): Promise<StationArtSource | null> {
  return (await stationArtRaw(stationId))?.source ?? null;
}
/** A station's art as a square PNG: grayscale for the Kindle (/media/img), colour for HA (/api/voice/art). */
export function stationArtPng(
  stationId: string,
  width: number,
  mode: PngMode = "colour",
): Promise<Buffer | null> {
  const station = findStation(stationId);
  if (!station) return Promise.resolve(null);
  return stationArtRaw(stationId).then((r) => {
    if (!r) return null;
    if (r.logoTransient) return toSquarePng(r.bytes, width, mode); // stand-in: never cached
    return cachedPng(
      cacheKey([
        "station-art",
        stationId,
        station.logo ?? "",
        coverForgeUrl(),
        r.source,
        String(width),
        mode,
      ]),
      () => toSquarePng(r.bytes, width, mode),
    );
  });
}
/** Resolves what the /media/img route accepts: a catalog station id or a Jellyfin item id (no free-form URLs). */
export async function imageFor(q: {
  station?: string | null;
  item?: string | null;
  width: number;
}): Promise<Buffer | null> {
  const width = Math.max(16, Math.min(400, Math.round(q.width)));
  if (q.station) return stationArtPng(q.station, width, "grayscale");
  if (q.item) {
    if (!/^[0-9a-fA-F-]{8,40}$/.test(q.item) || !jellyfinConfigured()) return null;
    const key = `${q.item}@${width}`;
    const neg = rt.imgNegative.get(key);
    if (neg && neg > Date.now()) return null;
    const png = await grayscalePng(jellyfin.artUrl(q.item, Math.max(200, width)), width);
    if (!png) rt.imgNegative.set(key, Date.now() + 60 * 60_000); // no cover: do not retry for an hour
    return png;
  }
  return null;
}

/** Background pre-warm of the resized-image cache so list rows and the amp view show art on first paint. */
export async function warmArt(
  ids: Array<string | null | undefined>,
  width: number,
  concurrency = 2,
) {
  const todo = [...new Set(ids.filter((x): x is string => !!x))];
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++]!;
      await imageFor({ item: id, width }).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
}

// ---- HA helpers for the media devices ----
const attrs = (s?: HaState) => (s?.attributes ?? {}) as Record<string, unknown>;
const attrNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const attrStr = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const stateNum = (s?: HaState) => {
  if (!s || s.state === "unavailable" || s.state === "unknown") return null;
  const n = parseFloat(s.state);
  return Number.isFinite(n) ? n : null;
};
const clampDb = (db: number) =>
  Math.round(Math.max(AMP.volumeMinDb, Math.min(AMP.volumeMaxDb, db)) * 2) / 2;

export const haMedia = {
  // The amp's XML API is used whenever AMP_HOST is set: HA's yamaha_ynca link to the amp drops for
  // minutes after every power cut (verified 2026-10-08), so power, input and volume must not depend on it.
  async selectSource(source: AmpSource) {
    if (ampConfigured()) await amp.selectInput(source);
    else await service("media_player", "select_source", { entity_id: AMP.player, source });
    await patchState({ lastSource: source });
  },
  /** One 5-way press = 2 dB. */
  async volumeStep(delta: 1 | -1) {
    let cur: number | null;
    if (ampConfigured()) cur = (await amp.basicStatus()).volumeDb;
    else cur = stateNum((await fetchStates()).get(AMP.volumeDb));
    if (cur === null) throw new MediaError("Volume unknown");
    await haMedia.volumeDb(cur + delta * AMP.volumeStepDb);
  },
  volumeDb: (db: number) =>
    ampConfigured()
      ? amp.setVolumeDb(db)
      : service("number", "set_value", { entity_id: AMP.volumeDb, value: clampDb(db) }),
  volumeSet: (level: number) =>
    service("media_player", "volume_set", {
      entity_id: AMP.player,
      volume_level: Math.max(0, Math.min(1, level)),
    }),
  turnOn: () =>
    ampConfigured()
      ? amp.power(true)
      : service("media_player", "turn_on", { entity_id: AMP.player }),
  turnOff: () =>
    ampConfigured()
      ? amp.power(false)
      : service("media_player", "turn_off", { entity_id: AMP.player }),
  /** Reconnects yamaha_ynca right after power-on instead of waiting out HA's setup-retry backoff (takes ~45 s). */
  reloadYnca: () =>
    ha("POST", `/api/config/config_entries/entry/${AMP.yncaEntryId}/reload`, {}, 90_000),
  /**
   * Reload only when the entry is waiting in setup_retry: reloading while a setup is in progress
   * cancels it and starts the backoff again (seen in the HA log 2026-10-08).
   */
  async reloadYncaIfRetrying(): Promise<string> {
    const entries = await ha<{ entry_id: string; state: string }[]>(
      "GET",
      "/api/config/config_entries/entry",
    );
    const state = entries.find((e) => e.entry_id === AMP.yncaEntryId)?.state ?? "missing";
    if (state === "setup_retry" || state === "setup_error" || state === "not_loaded") {
      await haMedia.reloadYnca();
      return `reloaded (was ${state})`;
    }
    return state;
  },
  plug: (on: boolean) => service("switch", on ? "turn_on" : "turn_off", { entity_id: AMP.plug }),
  tunerPreset: (n: number) =>
    service("media_player", "play_media", {
      entity_id: AMP.player,
      media_content_type: "music",
      media_content_id: `tun:preset:${n}`,
    }),
  tv: (op: "turn_on" | "turn_off" | "toggle" | "volume_mute") =>
    service("media_player", op, {
      entity_id: AMP.tv,
      ...(op === "volume_mute" ? { is_volume_muted: true } : {}),
    }),
  movie: (on: boolean) =>
    service("script", "turn_on", { entity_id: on ? AMP.movieOn : AMP.movieOff }),
};

// ---- Power-on routine (async job; the UI polls powerOnStatus) ----
export const POWER_ON_POLL_MS = 5000;
export const POWER_ON_TIMEOUT_MS = 4 * 60_000;
/** Plug off for this long before on again when the amp's LAN is asleep (see runPowerOn). */
export const PLUG_CYCLE_OFF_MS = 5000;

/** Resolve true when host:port accepts a TCP connection (one attempt). */
export const tcpOpen = (host: string, port: number, timeoutMs = 3000) =>
  new Promise<boolean>((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
export async function waitForTcp(
  host: string,
  port: number,
  pollMs = POWER_ON_POLL_MS,
  timeoutMs = POWER_ON_TIMEOUT_MS,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await tcpOpen(host, port)) return true;
    await sleep(pollMs);
  }
  return false;
}

export function powerOnStatus(): PowerOnStatus | null {
  const s = rt.powerOn;
  return s ? { ...s, elapsedMs: Date.now() - s.startedAt } : null;
}
const setPowerStep = (step: PowerOnStep, error?: string) => {
  if (!rt.powerOn) return;
  rt.powerOn = {
    ...rt.powerOn,
    step,
    updatedAt: Date.now(),
    running: step !== "done" && step !== "failed",
    ...(error === undefined ? {} : { error }),
  };
};
/** plug on → amp answers on tcp 80 (60–90 s) → Basic_Status answers cleanly (firmware up) → power on (retried)
 *  + last source via XML → reconnect yamaha_ynca (every path). Returns at once; `powerOnDone()` awaits the outcome. */
export async function startPowerOn(source?: AmpSource): Promise<PowerOnStatus> {
  if (rt.powerOn?.running) return powerOnStatus()!;
  const persisted = await loadState();
  const target = source ?? persisted.lastSource;
  const now = Date.now();
  rt.powerOn = {
    running: true,
    step: "plug",
    startedAt: now,
    updatedAt: now,
    elapsedMs: 0,
    source: target,
  };
  rt.powerOnJob = runPowerOn(target).then(() => powerOnStatus());
  return powerOnStatus()!;
}
/** Resolves with the routine's final status (done / failed), or the current status when none runs. */
export function powerOnDone(): Promise<PowerOnStatus | null> {
  return rt.powerOn?.running && rt.powerOnJob ? rt.powerOnJob : Promise.resolve(powerOnStatus());
}
const plog = (msg: string) => console.log(`[power] ${new Date().toISOString()} ${msg}`);
/** Run an amp call and classify its outcome instead of throwing. */
const ampProbe = (call: () => Promise<unknown>): Promise<AmpProbe> =>
  call().then(
    () => ({ kind: "ok" }) as AmpProbe,
    (e: unknown) => classifyAmpError(e),
  );
async function runPowerOn(target: AmpSource | null) {
  // The amp answered HTTP at some point: worth reconnecting HA's yamaha_ynca afterwards whatever happened.
  let ampAnswered = false;
  try {
    // Already on (false "off" reading or the user pressed it anyway): just make sure of the source and finish.
    const live = ampConfigured() ? await amp.basicStatus().catch(() => null) : null;
    if (live?.power) {
      ampAnswered = true;
      if (target && live.input !== target) {
        setPowerStep("source");
        await haMedia.selectSource(target);
      }
      setPowerStep("done");
      return;
    }
    const host = env("AMP_HOST");
    // Plug already on but the amp silent with tcp 80 closed: its LAN is asleep in standby (the R-N500
    // drops it ~15 min after standby, 2026-10-15) — plug(true) would be a no-op and tcp 80 never opens.
    // Only a plug cycle wakes it; never while HA still sees the amp on (then the XML API merely stalls).
    if (host && haConfigured()) {
      const states = await fetchStates().catch(() => null);
      const plug = states?.get(AMP.plug)?.state;
      const cycle = shouldCyclePlug({
        plugOn: plug === "on" ? true : plug === "off" ? false : null,
        tcp80Open: await tcpOpen(host, 80),
        haState: states?.get(AMP.player)?.state ?? null,
      });
      if (cycle) {
        plog("plug on but the amp is silent (tcp 80 closed): cycling the plug");
        await haMedia.plug(false);
        await sleep(PLUG_CYCLE_OFF_MS);
      }
    }
    await haMedia.plug(true);
    setPowerStep("wait");
    if (host) {
      const t0 = Date.now();
      if (!(await waitForTcp(host, 80))) throw new MediaError("Amp did not come up");
      plog(`tcp 80 open after ${Math.round((Date.now() - t0) / 1000)} s`);
      // Port open ≠ firmware ready (2026-10-15: HTTP 409 on the first command). Probe until clean.
      const boot = await waitUntilReady(() => ampProbe(() => amp.basicStatus()), { log: plog });
      ampAnswered = true;
      if (!boot.ready)
        plog(
          `amp still not clean after ${Math.round(boot.elapsedMs / 1000)} s (${describeProbe(boot.last)}): sending power on anyway`,
        );
    } else await sleep(90_000);
    setPowerStep("turn_on");
    // XML when AMP_HOST is set (does not need HA's yamaha_ynca link); 409 / 5xx / timeouts are retried.
    const cmd = await sendWithRetries(() => ampProbe(() => haMedia.turnOn()), { log: plog });
    if (!cmd.ok)
      throw new MediaError(`Amp ${describeProbe(cmd.last)} (power on, ${cmd.attempts} attempts)`);
    ampAnswered = true;
    await sleep(1500);
    if (target) {
      setPowerStep("source");
      await haMedia.selectSource(target);
    }
    setPowerStep("done");
  } catch (e) {
    setPowerStep("failed", mediaErrorMessage(e));
    plog(`power-on failed: ${mediaErrorMessage(e)}`);
  } finally {
    // HA's yamaha_ynca entry sits in setup_retry for minutes after a power cut; reconnect it on every path
    // once the amp answers (2026-10-15 it stayed in setup_retry for 30 min because the failed path skipped this).
    if (haConfigured() && ampAnswered)
      void haMedia
        .reloadYncaIfRetrying()
        .then((r) => console.log("yamaha_ynca after power-on:", r))
        .catch((e) => console.warn("yamaha_ynca reconnect skipped:", e));
  }
}

// ---- Snapshot ----
const matchCatalogStation = (name: string | null): string | null => {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const all = RADIO_LISTS.flatMap((l) => l.stations);
  return (
    all.find((s) => s.name.toLowerCase() === n)?.id ??
    all.find((s) => n.startsWith(s.name.toLowerCase()) || s.name.toLowerCase().startsWith(n))?.id ??
    null
  );
};
const NO_PLAY: NowPlaying = {
  kind: "none",
  title: null,
  artist: null,
  album: null,
  station: null,
  artItemId: null,
  stationId: null,
  preset: null,
};

/** Pure: HA states (+ optional NET RADIO Play_Info) -> snapshot. */
export function buildMediaSnapshot(
  states: Map<string, HaState>,
  extra: {
    playInfo?: NetRadioPlayInfo | null;
    queue?: QueueProgress | null;
    radio?: RadioPosition | null;
    powerOn?: PowerOnStatus | null;
  } = {},
): MediaSnapshot {
  const p = states.get(AMP.player);
  const a = attrs(p);
  const state = p?.state ?? "unavailable";
  const available = state !== "unavailable" && state !== "unknown";
  const on = available && state !== "off" && state !== "standby";
  const source = isAmpSource(a["source"]) ? a["source"] : null;
  const queue = extra.queue ?? null;
  let nowPlaying: NowPlaying = NO_PLAY;
  if (on && source === "NET RADIO") {
    const station = extra.playInfo?.station || attrStr(a["media_channel"]);
    nowPlaying = {
      ...NO_PLAY,
      kind: "radio",
      station,
      title: extra.playInfo?.song || attrStr(a["media_title"]),
      stationId: matchCatalogStation(station),
    };
  } else if (on && source === "SERVER") {
    nowPlaying = {
      ...NO_PLAY,
      kind: "music",
      // While our queue plays, its track is the truth: HA's title lags a few seconds after next/advance.
      title:
        (queue?.status === "playing" ? queue.track?.title : null) ??
        attrStr(a["media_title"]) ??
        queue?.track?.title ??
        null,
      artist:
        (queue?.status === "playing" ? queue.track?.artist : null) ??
        attrStr(a["media_artist"]) ??
        queue?.track?.artist ??
        null,
      album:
        (queue?.status === "playing" ? queue.track?.album : null) ??
        attrStr(a["media_album_name"]) ??
        queue?.track?.album ??
        null,
      artItemId: queue?.track?.artItemId ?? null,
    };
  } else if (on && source === "TUNER") {
    nowPlaying = {
      ...NO_PLAY,
      kind: "fm",
      station: attrStr(a["media_channel"]),
      title: attrStr(a["media_title"]),
      preset: attrNum(a["preset"]),
    };
  } else if (on && source === "CD") nowPlaying = { ...NO_PLAY, kind: "tv" };
  else if (on && source === "PHONO") nowPlaying = { ...NO_PLAY, kind: "phono" };
  const tv = states.get(AMP.tv);
  return {
    amp: {
      available,
      on,
      state,
      source,
      volumeDb: stateNum(states.get(AMP.volumeDb)),
      volume: attrNum(a["volume_level"]),
      muted: a["is_volume_muted"] === true,
    },
    nowPlaying,
    tv: {
      state: tv?.state ?? "unavailable",
      source: attrStr(attrs(tv)["source"]) ?? attrStr(attrs(tv)["app_name"]),
    },
    plugOn: states.get(AMP.plug)?.state === "on",
    movieActive: states.get(AMP.movieActive)?.state === "on",
    queue,
    radio: extra.radio ?? null,
    powerOn: extra.powerOn ?? null,
  };
}

type BasicStatusLike = {
  power: boolean;
  input: string | null;
  volumeDb: number | null;
  muted: boolean;
};
type BasicCache = { at: number; value: BasicStatusLike };
/**
 * Power as the panel shows it (pure rules in amp-state.ts): the XML Basic_Status wins whenever it
 * answers (it says Standby / On directly; HA's yamaha_ynca drops for minutes after every power cut
 * and ~15 min into standby when the R-N500 puts its LAN to sleep), its last good answer within a 10 s
 * grace, then the plug (off = off), then HA; otherwise unknown = off. HA's entity is kept only while
 * it agrees that the amp is on (it carries titles and the playback state); a stale HA "on" with the
 * amp in standby or the plug off is replaced. Returns the verdict for logs and tests.
 */
export function overlayAmpStatus(
  states: Map<string, HaState>,
  basic: BasicStatusLike | null,
  cached: BasicCache | null = null,
  now = Date.now(),
): AmpPowerVerdict {
  const player = states.get(AMP.player);
  const plug = states.get(AMP.plug)?.state;
  const verdict = deriveAmpPower({
    xml: basic ? { power: basic.power, input: basic.input } : null,
    cached: cached ? { at: cached.at, value: cached.value } : null,
    now,
    haState: player?.state ?? null,
    plugOn: plug === "on" ? true : plug === "off" ? false : null,
    graceMs: AMP_XML_GRACE_MS,
  });
  const haOn = !!player && !["unavailable", "unknown", "off", "standby"].includes(player.state);
  const mk = (entity_id: string, state: string, attributes: Record<string, unknown>): HaState =>
    ({ entity_id, state, attributes, last_changed: "", last_updated: "" }) as unknown as HaState;
  const xml = verdict.via === "xml" ? basic : verdict.via === "xml-cached" ? cached?.value : null;
  if (xml) {
    if (verdict.on && haOn) return verdict;
    const volumeLevel =
      xml.volumeDb === null
        ? null
        : (xml.volumeDb - AMP.volumeMinDb) / (AMP.volumeMaxDb - AMP.volumeMinDb);
    states.set(
      AMP.player,
      mk(AMP.player, xml.power ? "on" : "off", {
        source: xml.input,
        ...(volumeLevel === null ? {} : { volume_level: Math.max(0, Math.min(1, volumeLevel)) }),
        is_volume_muted: xml.muted,
        friendly_name: "R-N500 (xml)",
      }),
    );
    if (xml.volumeDb !== null)
      states.set(
        AMP.volumeDb,
        mk(AMP.volumeDb, String(xml.volumeDb), { unit_of_measurement: "dB" }),
      );
  } else if (verdict.via === "plug-off" && haOn)
    states.set(AMP.player, mk(AMP.player, "off", { friendly_name: "R-N500 (plug off)" }));
  return verdict;
}

let basicCache: BasicCache | null = null;
/** Basic_Status now, plus the last good answer (overlayAmpStatus applies the 10 s grace): the amp's
 * XML API stalls for a few seconds after menu changes, and one failed read must not flip the panel. */
async function basicStatusCached(): Promise<{
  live: BasicStatusLike | null;
  cached: BasicCache | null;
}> {
  try {
    const value = await amp.basicStatus();
    basicCache = { at: Date.now(), value };
    return { live: value, cached: basicCache };
  } catch {
    return { live: null, cached: basicCache };
  }
}

let lastVerdictKey = "";
export async function readMediaSnapshot(): Promise<MediaSnapshot> {
  const [states, persisted, xml] = await Promise.all([
    ampConfigured() ? fetchStates().catch(() => new Map<string, HaState>()) : fetchStates(),
    loadState(),
    ampConfigured() ? basicStatusCached() : Promise.resolve({ live: null, cached: null }),
  ]);
  const verdict = overlayAmpStatus(states, xml.live, xml.cached);
  // One line per change, so a stale "on" can be traced to its source afterwards.
  const verdictKey = `${verdict.on ? "on" : "off"}/${verdict.available ? "known" : "unknown"}/${verdict.via}`;
  if (verdictKey !== lastVerdictKey) {
    lastVerdictKey = verdictKey;
    console.log(`[amp] ${new Date().toISOString()} power ${verdictKey}`);
  }
  const player = states.get(AMP.player);
  const source = attrs(player)["source"];
  const on = player !== undefined && !["off", "unavailable", "unknown"].includes(player.state);
  if (on && isAmpSource(source) && source !== persisted.lastSource)
    await patchState({ lastSource: source });
  const playInfo =
    on && source === "NET RADIO" && ampConfigured() ? await amp.playInfo().catch(() => null) : null;
  return buildMediaSnapshot(states, {
    playInfo,
    queue: queueProgress(persisted.queue, Date.now()),
    radio: persisted.radio,
    powerOn: powerOnStatus(),
  });
}

// ---- Radio: lists + tuning by index ----
const bookmarkView = (b: YtunerStation): RadioStationView => {
  const cat = RADIO_LISTS.flatMap((l) => l.stations).find(
    (s) => normalizeStreamUrl(s.url) === normalizeStreamUrl(b.url),
  );
  return cat
    ? { ...cat, ytunerId: b.id, favourite: true }
    : {
        id: `yt:${b.id}`,
        name: b.name,
        url: b.url,
        codec: "",
        bitrate: 0,
        fm: null,
        logo: b.logo,
        ytunerId: b.id,
        favourite: true,
      };
};

export async function readRadioLists(): Promise<RadioListsResult> {
  const persisted = await loadState();
  let byUrl = new Map<string, YtunerStation>();
  let bookmarks: YtunerStation[] = [];
  let error: string | undefined;
  try {
    [byUrl, bookmarks] = await Promise.all([ytuner.stationsByUrl(), ytuner.listBookmarks()]);
  } catch (e) {
    error = mediaErrorMessage(e);
  }
  const favUrls = new Set(bookmarks.map((b) => normalizeStreamUrl(b.url)));
  return {
    configured: true,
    ...(error === undefined ? {} : { error }),
    lists: [
      { id: FAVOURITES_LIST_ID, stations: bookmarks.map(bookmarkView) },
      ...RADIO_LISTS.map((l) => ({
        id: l.id,
        stations: l.stations.map((s) => ({
          ...s,
          ytunerId: byUrl.get(normalizeStreamUrl(s.url))?.id ?? null,
          favourite: favUrls.has(normalizeStreamUrl(s.url)),
        })),
      })),
    ],
    current: persisted.radio,
  };
}

async function radioListSize(list: string): Promise<number> {
  if (list === FAVOURITES_LIST_ID) return (await ytuner.listBookmarks()).length;
  return RADIO_LISTS.find((l) => l.id === list)?.stations.length ?? 0;
}

/**
 * Walk the amp's NET RADIO menu to a station by index (0-based inside the list):
 * input NET RADIO → (Return to Home → Line_1 Stations → Jump_Line category + Sel | Line_2 Favourites)
 * → Jump_Line station + Sel. The menu walk is skipped when List_Info already shows the target list.
 */
export async function tuneRadio(list: string, index: number): Promise<RadioPosition> {
  const size = await radioListSize(list);
  if (index < 0 || index >= size) throw new MediaError("No such station");
  const position = { list, index };
  if (!ampConfigured()) {
    await patchState({ radio: position });
    return position;
  }
  const catIdx = RADIO_LISTS.findIndex((l) => l.id === list);
  const target = list === FAVOURITES_LIST_ID ? "Favourites" : RADIO_LISTS[catIdx]!.ytunerCategory;

  const status = await amp.basicStatus();
  // In standby Input_Sel still reads NET RADIO but List_Info is an empty layer-1 menu.
  if (!status.power) throw new MediaError("Amp is off");
  if (status.input !== "NET RADIO") {
    if (haConfigured()) await haMedia.selectSource("NET RADIO");
    else await amp.selectInput("NET RADIO");
    await amp.waitReady(3000, 20000);
  } else await patchState({ lastSource: "NET RADIO" });

  let info = await amp.listInfo();
  if (info.status !== "Ready") info = await amp.waitReady(0);
  if (info.name !== target) {
    await amp.returnToHome();
    await amp.waitReady();
    if (list === FAVOURITES_LIST_ID) {
      await amp.directSel(2);
      await amp.waitReady();
    } else {
      // Top menu: Line_1 Stations, Line_2 Favourites, Line_3 Radio Browser.
      await amp.directSel(1);
      await amp.waitReady();
      await amp.jumpLineAndSelect(catIdx + 1);
    }
  }
  await amp.jumpLineAndSelect(index + 1);
  await patchState({ radio: position });
  return position;
}

async function radioStep(delta: 1 | -1): Promise<RadioPosition> {
  const persisted = await loadState();
  const cur = persisted.radio ?? { list: RADIO_LISTS[0]?.id ?? "local", index: -1 };
  const size = await radioListSize(cur.list);
  if (size === 0) throw new MediaError("Empty list");
  return tuneRadio(cur.list, (((cur.index + delta) % size) + size) % size);
}

async function setFavourite(stationId: string, add: boolean) {
  const station = findStation(stationId);
  if (!station) throw new MediaError("No such station");
  const yt = (await ytuner.stationsByUrl()).get(normalizeStreamUrl(station.url));
  if (!yt) throw new MediaError("Station unknown to YTuner");
  if (add) await ytuner.addBookmark(yt);
  else await ytuner.removeBookmark(yt.id);
}

// ---- Music lists (Jellyfin) ----
const LIST_TTL_MS = 10 * 60_000;
const MIX_SIZE = 40;
type MixSpec =
  | { kind: "seed" }
  | { kind: "unplayed" }
  | { kind: "genres"; genres: string }
  | { kind: "years"; from: number; to: number }
  | { kind: "artists"; names: string[] };
/** What each mix is built from. Verified against this library on 2026-10-09: genres are sparse
 * (Blues 665, Punk 792, Jazz 405, Heavy Metal 219, Electronic 205, Classical 174 tracks), years are
 * well filled (90s/2000s thousands, 80s ~1.4k, 70s ~750), so party/dance/rock/pop use artist seeds. */
export const MIX_SPECS: Record<MixId, MixSpec> = {
  daily: { kind: "seed" },
  discover: { kind: "unplayed" },
  party: {
    kind: "artists",
    names: [
      "ABBA",
      "Black Eyed Peas",
      "Michael Jackson",
      "Madonna",
      "Bee Gees",
      "Pitbull",
      "Rihanna",
      "Shakira",
      "Daft Punk",
      "Lady Gaga",
      "Bruno Mars",
      "Kool & The Gang",
      "Earth, Wind & Fire",
      "Gloria Gaynor",
      "Ricky Martin",
      "Queen",
    ],
  },
  dancing: {
    kind: "artists",
    names: [
      "Ace Of Base",
      "Snap!",
      "Haddaway",
      "2 Unlimited",
      "Culture Beat",
      "Dr. Alban",
      "Scooter",
      "Activate",
      "La Bouche",
      "Corona",
      "Vengaboys",
      "Eiffel 65",
      "Alice Deejay",
      "Modern Talking",
      "Boney M.",
      "Chic",
      "Donna Summer",
      "David Guetta",
      "Avicii",
      "Calvin Harris",
    ],
  },
  rock: {
    kind: "artists",
    names: [
      "AC-DC",
      "AC/DC",
      "Aerosmith",
      "Led Zeppelin",
      "Deep Purple",
      "Guns N' Roses",
      "Metallica",
      "Scorpions",
      "Pink Floyd",
      "The Rolling Stones",
      "Bon Jovi",
      "Nirvana",
      "Red Hot Chili Peppers",
      "Foo Fighters",
      "Dire Straits",
      "Alice Cooper",
      "ZZ Top",
      "Bruce Springsteen",
      "U2",
      "Queen",
    ],
  },
  pop: {
    kind: "artists",
    names: [
      "Madonna",
      "Michael Jackson",
      "The Beatles",
      "Elton John",
      "George Michael",
      "Robbie Williams",
      "Britney Spears",
      "Coldplay",
      "Oasis",
      "Alanis Morissette",
      "Phil Collins",
      "Sting",
      "Whitney Houston",
      "Celine Dion",
      "Adele",
      "Ed Sheeran",
      "Justin Timberlake",
      "Maroon 5",
      "Roxette",
      "ABBA",
    ],
  },
  s60: { kind: "years", from: 1960, to: 1969 },
  s70: { kind: "years", from: 1970, to: 1979 },
  s80: { kind: "years", from: 1980, to: 1989 },
  s90: { kind: "years", from: 1990, to: 1999 },
  s2000: { kind: "years", from: 2000, to: 2009 },
  relaxed: { kind: "genres", genres: "Ambient|Classical|Jazz|Acoustic" },
  evening: { kind: "genres", genres: "Blues|Jazz|Vocal|Lounge" },
  jazz: { kind: "genres", genres: "Jazz" },
  blues: { kind: "genres", genres: "Blues" },
  punk: { kind: "genres", genres: "Punk" },
  metal: { kind: "genres", genres: "Heavy Metal|Metal" },
  electronic: { kind: "genres", genres: "Electronic|Dance" },
  classical: { kind: "genres", genres: "Classical" },
};
export const MIX_MIN_TRACKS = 15;
export const yearsParam = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join(",");
export function dedupeShuffle<T extends { id: string }>(tracks: T[], size: number): T[] {
  const seen = new Set<string>();
  const out = tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, size);
}
const mixesFile = () => path.join(env("MEDIA_STATE_DIR") || os.tmpdir(), "kindle-mixes.json");
/** Calendar day in Europe/Berlin (the amp's living room), e.g. "2026-10-09". */
export const berlinDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const berlinHour = (d = new Date()) =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      hour12: false,
    }).format(d),
  );

async function artistIds(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    try {
      const r = await jf<JfList>("/Artists", {
        userId: env("JELLYFIN_USER_ID"),
        searchTerm: name,
        limit: 3,
      });
      const hit =
        (r.Items ?? []).find((a) => a.Name.toLowerCase() === name.toLowerCase()) ??
        (r.Items ?? [])[0];
      if (hit && hit.Name.toLowerCase().startsWith(name.toLowerCase().slice(0, 4)))
        ids.push(hit.Id);
    } catch {
      /* skip unknown artist */
    }
    if (ids.length >= 8) break;
  }
  return ids;
}
async function buildMix(id: MixId): Promise<MusicTrack[]> {
  const spec = MIX_SPECS[id];
  switch (spec.kind) {
    case "seed": {
      const seed =
        (await jellyfin.randomTracks(1, { Filters: "IsFavorite" }))[0] ??
        (await jellyfin.randomTracks(1, { Filters: "IsPlayed" }))[0] ??
        (await jellyfin.randomTracks(1))[0];
      return seed ? jellyfin.instantMix(seed.id, MIX_SIZE) : [];
    }
    case "unplayed":
      return jellyfin.randomTracks(MIX_SIZE, { Filters: "IsUnplayed" });
    case "genres":
      return dedupeShuffle(
        await jellyfin.randomTracks(MIX_SIZE, { Genres: spec.genres }),
        MIX_SIZE,
      );
    case "years":
      return dedupeShuffle(
        await jellyfin.randomTracks(MIX_SIZE, { Years: yearsParam(spec.from, spec.to) }),
        MIX_SIZE,
      );
    case "artists": {
      const ids = await artistIds(spec.names);
      if (ids.length === 0) return [];
      const parts = await Promise.all(
        ids.map(async (aid) => {
          const own = await jellyfin.randomTracks(6, { ArtistIds: aid });
          const seed = own[0];
          const mix = seed ? await jellyfin.instantMix(seed.id, 10).catch(() => []) : [];
          return [...own, ...mix];
        }),
      );
      return dedupeShuffle(parts.flat(), MIX_SIZE);
    }
  }
}
function loadMixesFromDisk(): typeof rt.mixes {
  try {
    const f = mixesFile();
    if (!existsSync(f)) return null;
    const raw = JSON.parse(readFileSync(f, "utf8")) as {
      day: string;
      builtAt: number;
      items: Record<string, MusicTrack[]>;
    };
    const items = new Map<MixId, MusicTrack[]>();
    for (const id of MIX_IDS) if (raw.items[id]?.length) items.set(id, raw.items[id]!);
    return items.size ? { day: raw.day, builtAt: raw.builtAt, items } : null;
  } catch {
    return null;
  }
}
/** Builds every mix (sequentially, Jellyfin is a small server), persists them and pre-warms the art. */
export async function buildAllMixes(): Promise<Map<MixId, MusicTrack[]>> {
  if (rt.mixBuilding) return rt.mixBuilding;
  rt.mixBuilding = (async () => {
    const items = new Map<MixId, MusicTrack[]>();
    for (const id of MIX_IDS) {
      try {
        const tracks = await buildMix(id);
        if (tracks.length >= MIX_MIN_TRACKS) items.set(id, tracks);
        else console.log(`mix ${id}: only ${tracks.length} tracks, skipped`);
      } catch (e) {
        console.warn(`mix ${id} failed:`, e);
      }
    }
    const day = berlinDay();
    rt.mixes = { day, builtAt: Date.now(), items };
    try {
      mkdirSync(path.dirname(mixesFile()), { recursive: true });
      writeFileSync(
        mixesFile(),
        JSON.stringify({ day, builtAt: rt.mixes.builtAt, items: Object.fromEntries(items) }),
        "utf8",
      );
    } catch (e) {
      console.warn("mixes save failed:", e);
    }
    rt.lists.delete("mixes");
    console.log(`mixes built for ${day}: ${[...items.keys()].join(", ")}`);
    void warmArt(
      [...items.values()].flatMap((ts) => [
        ts.find((t) => t.artItemId)?.artItemId,
        ...ts.slice(0, 12).map((t) => t.artItemId),
      ]),
      64,
    ).catch(() => undefined);
    return items;
  })().finally(() => {
    rt.mixBuilding = null;
  });
  return rt.mixBuilding;
}
/** Mixes come from the daily build (disk/memory); only the very first run builds on demand. */
async function buildMixes(): Promise<Map<MixId, MusicTrack[]>> {
  if (!rt.mixes) rt.mixes = loadMixesFromDisk();
  if (rt.mixes) {
    if (rt.mixes.day !== berlinDay() && Date.now() - rt.mixes.builtAt > 36 * 3600_000)
      void buildAllMixes();
    return rt.mixes.items;
  }
  return buildAllMixes();
}
/** Startup (+20 s) and every day at 04:00 Berlin time. */
export function scheduleMixBuilds() {
  if (rt.mixTimer || !jellyfinConfigured()) return;
  setTimeout(() => {
    if (!rt.mixes) rt.mixes = loadMixesFromDisk();
    if (!rt.mixes || rt.mixes.day !== berlinDay()) void buildAllMixes();
  }, 20_000).unref?.();
  rt.mixTimer = setInterval(() => {
    if (berlinHour() === 4 && rt.mixes?.day !== berlinDay()) void buildAllMixes();
  }, 10 * 60_000);
  rt.mixTimer.unref?.();
}
scheduleMixBuilds();

async function listItems(tab: MusicTab): Promise<MusicListItem[]> {
  const cached = rt.lists.get(tab);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.items;
  let items: MusicListItem[];
  switch (tab) {
    case "mixes": {
      const mixes = await buildMixes();
      items = MIX_IDS.map((id) => {
        const tracks = mixes.get(id) ?? [];
        return {
          kind: "mix",
          id,
          title: id,
          detail: String(tracks.length),
          artItemId: tracks.find((t) => t.artItemId)?.artItemId ?? null,
        };
      });
      break;
    }
    case "suggested":
      items = (await jellyfin.suggestions(48)).map(trackItem);
      break;
    case "artists":
      items = await jellyfin.randomAlbumArtists(48);
      break;
    case "albums":
      items = await jellyfin.randomAlbums(48);
      break;
    case "recent":
      items = await jellyfin.recentlyPlayedAlbums(48);
      break;
  }
  rt.lists.set(tab, { at: Date.now(), items });
  void warmArt(
    items.map((i) => i.artItemId),
    64,
  ).catch(() => undefined);
  return items;
}

export async function readMusicList(tab: MusicTab, page: number): Promise<MusicListResult> {
  if (!jellyfinConfigured()) return demoMusicList(tab, page);
  const items = await listItems(tab);
  const pages = Math.max(1, Math.ceil(items.length / MUSIC_PAGE_SIZE));
  const p = Math.max(0, Math.min(pages - 1, page));
  return {
    configured: true,
    tab,
    page: p,
    pages,
    items: items.slice(p * MUSIC_PAGE_SIZE, (p + 1) * MUSIC_PAGE_SIZE),
  };
}

/** Search screen: up to two artists, albums fill the rest of the screen (more artists if albums are short). */
export async function readMusicSearch(query: string): Promise<MusicSearchResult> {
  const q = query.trim();
  if (!jellyfinConfigured()) return demoMusicSearch(q);
  if (q.length < SEARCH_MIN_CHARS) return { configured: true, query: q, items: [] };
  const [artists, albums] = await Promise.all([
    jellyfin.searchAlbumArtists(q, SEARCH_RESULT_ROWS),
    jellyfin.searchAlbums(q, SEARCH_RESULT_ROWS),
  ]);
  const leadArtists = artists.slice(
    0,
    Math.min(2, Math.max(0, SEARCH_RESULT_ROWS - albums.length)),
  );
  const items = [...leadArtists, ...albums, ...artists.slice(leadArtists.length)].slice(
    0,
    SEARCH_RESULT_ROWS,
  );
  void warmArt(
    items.map((i) => i.artItemId),
    64,
  ).catch(() => undefined);
  return { configured: true, query: q, items };
}

/** Artist screen: the artist's albums, MUSIC_PAGE_SIZE per page. */
export async function readArtistAlbums(
  artistId: string,
  page: number,
): Promise<ArtistAlbumsResult> {
  if (!jellyfinConfigured()) return demoArtistAlbums(artistId, page);
  const [artist, albums] = await Promise.all([
    jellyfin.artistItem(artistId),
    jellyfin.artistAlbums(artistId),
  ]);
  const pages = Math.max(1, Math.ceil(albums.length / MUSIC_PAGE_SIZE));
  const p = Math.max(0, Math.min(pages - 1, page));
  const items = albums.slice(p * MUSIC_PAGE_SIZE, (p + 1) * MUSIC_PAGE_SIZE);
  void warmArt(
    items.map((i) => i.artItemId),
    64,
  ).catch(() => undefined);
  return {
    configured: true,
    artist: { id: artist.Id, title: artist.Name, artItemId: artOf(artist) },
    page: p,
    pages,
    total: albums.length,
    items,
  };
}

/** Queue title for a mix: its name in the panel's language (the id would show as "rock"). */
const mixTitle = (id: string): string =>
  makeT(parseLang(process.env["UI_LANGUAGE"]))(`music.mix.${id}` as Key);
async function tracksFor(sel: PlaySelection): Promise<{ title: string; tracks: MusicTrack[] }> {
  if (!jellyfinConfigured()) return { title: sel.id, tracks: demoTracks() };
  switch (sel.kind) {
    case "album": {
      const tracks = await jellyfin.albumTracks(sel.id);
      return { title: tracks[0]?.album ?? "", tracks };
    }
    case "artist": {
      // F4 "shuffle" on the artist screen: their tracks across all albums, shuffled.
      const [artist, tracks] = await Promise.all([
        jellyfin.artistItem(sel.id),
        jellyfin.artistTracks(sel.id, MIX_SIZE * 2),
      ]);
      if (!tracks.length) throw new MediaError("No tracks");
      return { title: artist.Name, tracks: dedupeShuffle(tracks, MIX_SIZE) };
    }
    case "track": {
      const mix = await jellyfin.instantMix(sel.id, MIX_SIZE);
      const first = mix.find((t) => t.id === sel.id);
      const rest = mix.filter((t) => t.id !== sel.id);
      return { title: first?.title ?? "", tracks: first ? [first, ...rest] : rest };
    }
    case "mix": {
      const mixes = await buildMixes();
      return { title: mixTitle(sel.id), tracks: mixes.get(sel.id as MixId) ?? [] };
    }
  }
}

// ---- Queue runtime ----
const QUEUE_TICK_MS = 2000;
/** Every 3rd tick (6 s) while playing: ask the amp what it plays and follow it if it moved. */
const QUEUE_VERIFY_TICKS = 3;
const qlog = (msg: string) => console.log(`[queue] ${new Date().toISOString()} ${msg}`);
const trackName = (q: QueueState, i: number) =>
  `${i + 1}/${q.tracks.length} ${q.tracks[i]?.title ?? "?"}`;
const didlFor = (t: QueueTrack) =>
  buildDidl({
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumArtUri: t.artItemId && jellyfinConfigured() ? jellyfin.artUrl(t.artItemId) : null,
    url: t.streamUrl,
    mime: streamMime(t.container),
    durationMs: t.durationMs,
  });

async function ensureServerSource() {
  const status = await amp.basicStatus();
  if (!status.power) throw new MediaError("Amp is off");
  if (status.input === "SERVER") return;
  if (haConfigured()) await haMedia.selectSource("SERVER");
  else await amp.selectInput("SERVER");
}

/** HA's view of the player (yamaha_ynca): the second opinion when the amp's UPnP side is silent. */
async function haPlayerState(): Promise<string | null> {
  if (!haConfigured()) return null;
  return ha<HaState>("GET", `/api/states/${AMP.player}`)
    .then((st) => st.state)
    .catch(() => null);
}

/** After Play the R-N500 takes its time: poll the renderer (HA's state when its UPnP side is silent)
 *  until it reports PLAYING, at most PLAY_CONFIRM_MS. */
async function waitPlaying(timeoutMs = PLAY_CONFIRM_MS): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = await avTransport
      .transportInfo()
      .then((t) => t.state)
      .catch(() => null);
    if (st === "PLAYING") return true;
    if (st === null && (await haPlayerState()) === "playing") return true;
    if (Date.now() >= until) return false;
    await sleep(500);
  }
}

/** SetAVTransportURI (retrying while the amp still answers 501 during the input switch) → Play → wait for
 *  PLAYING → Seek → SetNext. Resolves false when the renderer never confirmed PLAYING (the stall watchdog
 *  takes it from there); throws when a call failed. Callers hold the transport lock. */
async function pushTrack(
  t: QueueTrack,
  next: QueueTrack | undefined,
  seekMs = 0,
): Promise<boolean> {
  if (!ampConfigured()) return true;
  // Both sizes the panel asks for: 240 for the amp view (drawn at once on a skip), 160 for lists.
  void warmArt([t.artItemId, next?.artItemId], 240)
    .then(() => warmArt([t.artItemId, next?.artItemId], 160))
    .catch(() => undefined);
  await ensureServerSource();
  const didl = didlFor(t);
  for (let attempt = 0; ; attempt++) {
    try {
      await avTransport.setUri(t.streamUrl, didl);
      break;
    } catch (e) {
      if (!(e instanceof UpnpError) || attempt >= 15) throw e; // input switch can take 3–6 s, longer after power-on
      await sleep(1000);
    }
  }
  await avTransport.play();
  const started = await waitPlaying();
  if (!started)
    qlog(
      `renderer did not report PLAYING within ${PLAY_CONFIRM_MS / 1000} s of Play for ${t.title}`,
    );
  if (seekMs > 1000) {
    if (!started) await sleep(800);
    await avTransport.seek(seekMs).catch(() => undefined);
  }
  if (next) await avTransport.setNextUri(next.streamUrl, didlFor(next)).catch(() => undefined);
  return started;
}

// ---- Transport discipline (2026-10-15): one renderer call at a time, skips coalesced, stalls watched ----
// 20 "next" presses at 2–3 s used to be 20 SetURI/Play storms; the amp's network side dropped (HA:
// unavailable → idle) while the queue kept "playing" with a running clock and resume was a no-op.
const transport = new TransportLock();
const resetStall = () => {
  rt.stall = freshStall();
  rt.stallReason = null;
  rt.stallSkips = 0;
};
/** A track whose Play was never confirmed: the renderer refused it or is slow. Count the idle time
 *  from the Play (not from the next verify) so the watchdog acts on its next tick. */
const primeStall = () => {
  if (rt.stall.idleSince === null)
    rt.stall = { ...rt.stall, idleSince: Date.now() - STALL_CONFIRM_MS };
};
/** Record that the renderer got index `i` (clock runs from 0; stays frozen when Play was not confirmed). */
async function markPushed(id: string, i: number, started: boolean) {
  const q = rt.persisted?.queue;
  if (!q || q.id !== id || q.index !== i || q.status !== "playing") return; // paused / stopped / moved on
  await setQueue({
    ...q,
    startedAt: started ? Date.now() : null,
    offsetMs: 0,
    nextPushed: i + 1 < q.tracks.length,
    stall: null,
  });
}
/** Debounced skips: one SetURI/Play for the latest index. The amp's HTTP side stalls for a few seconds
 *  right after DLNA activity, so a failed attempt gets one retry before the queue is paused with the reason. */
const skips = new SkipCoalescer(
  transport,
  async (i) => {
    const q = rt.persisted?.queue;
    if (!q || q.status !== "playing" || q.index !== i) return;
    let started: boolean;
    try {
      started = await pushTrack(q.tracks[i]!, q.tracks[i + 1]);
    } catch (e) {
      qlog(`skip to ${trackName(q, i)} failed (${mediaErrorMessage(e)}): one retry`);
      await sleep(1500);
      started = await pushTrack(q.tracks[i]!, q.tracks[i + 1]);
    }
    resetStall();
    await markPushed(q.id, i, started);
    if (!started) primeStall();
    qlog(`skipped to ${trackName(q, i)}${started ? "" : " (renderer not PLAYING yet)"}`);
  },
  (e, i) => {
    const q = rt.persisted?.queue;
    if (!q || q.status !== "playing" || q.index !== i) return;
    const reason = mediaErrorMessage(e);
    qlog(`skip to ${trackName(q, i)} failed (${reason}): queue paused`);
    void setQueue({ ...q, status: "paused", startedAt: null, offsetMs: 0, stall: reason }).catch(
      () => undefined,
    );
  },
);
/** A stall inside the first seconds of a track = the renderer refused the stream, not a hiccup. */
const UNPLAYABLE_MS = 5000;
/** How many refused tracks in a row the watchdog skips before it gives up (a dead amp, not bad files). */
const UNPLAYABLE_MAX_SKIPS = 3;
/** Watchdog: the renderer refused this track twice — skip to the next one (bounded), else pause with the reason. */
async function skipUnplayable(q: QueueState, now: number, seen: string) {
  const n = queueJump(q, q.index + 1, now);
  if (n.status === "ended") {
    qlog(
      `renderer refuses ${trackName(q, q.index)} (${seen}) and it was the last track: queue ended`,
    );
    resetStall();
    if (ampConfigured()) await transport.run(() => avTransport.stop()).catch(() => undefined);
    await setQueue(n);
    return;
  }
  const skipsSoFar = rt.stallSkips + 1;
  resetStall();
  rt.stallSkips = skipsSoFar;
  if (skipsSoFar > UNPLAYABLE_MAX_SKIPS) {
    qlog(`renderer refused ${skipsSoFar} tracks in a row: queue paused (${STALL_REASON})`);
    await setQueue({ ...q, status: "paused", startedAt: null, stall: STALL_REASON });
    return;
  }
  qlog(
    `renderer refuses ${trackName(q, q.index)} (${seen}, never started): skipping to ${trackName(n, n.index)} (${skipsSoFar}/${UNPLAYABLE_MAX_SKIPS})`,
  );
  await setQueue({ ...n, startedAt: null, stall: null });
  await replayCurrent(n.id);
}
/** Stall watchdog replay: the current track again from 0, through the lock; a failure becomes the reason. */
async function replayCurrent(id: string) {
  await transport.run(async () => {
    const q = rt.persisted?.queue;
    if (!q || q.id !== id || q.status !== "playing") return;
    try {
      const started = await pushTrack(q.tracks[q.index]!, q.tracks[q.index + 1]);
      rt.stallReason = started ? null : STALL_REASON;
      await markPushed(id, q.index, started);
      if (!started) primeStall();
    } catch (e) {
      rt.stallReason = mediaErrorMessage(e);
      qlog(`replay of ${trackName(q, q.index)} failed: ${rt.stallReason}`);
    }
  });
}

function ensureQueueTimer() {
  if (rt.queueTimer) return;
  rt.queueTimer = setInterval(() => void queueTick(), QUEUE_TICK_MS);
  rt.queueTimer.unref?.();
}

async function setQueue(q: QueueState | null) {
  await patchState({ queue: q });
  return queueProgress(q, Date.now());
}

export async function getQueueProgress(): Promise<QueueProgress | null> {
  return queueProgress((await loadState()).queue, Date.now());
}
export async function getQueueList(): Promise<QueueList | null> {
  const q = (await loadState()).queue;
  return q
    ? { title: q.title, index: q.index, status: q.status, tracks: q.tracks.map(stripStream) }
    : null;
}
/** Playlist screen: play the queue from `index` (Enter / F4 on a row). */
export async function queueJumpTo(index: number): Promise<QueueProgress | null> {
  const q = (await loadState()).queue;
  if (!q) throw new MediaError("No queue");
  if (!q.tracks[index]) throw new MediaError("No such track");
  return skipTo(q, index, Date.now());
}

/** next / previous / a playlist row: the index moves now (panel and voice answer show the target, clock
 *  frozen at 0:00); the renderer call follows SKIP_DEBOUNCE_MS after the last press, never overlapping. */
async function skipTo(q: QueueState, index: number, now: number): Promise<QueueProgress | null> {
  const n = queueJump(q, index, now);
  if (n.status === "ended") {
    skips.cancel();
    if (ampConfigured()) void transport.run(() => avTransport.stop()).catch(() => undefined);
    return setQueue(n);
  }
  ensureQueueTimer();
  if (!ampConfigured())
    return setQueue({ ...n, nextPushed: index + 1 < n.tracks.length, stall: null });
  const p = await setQueue({ ...n, startedAt: null, stall: null });
  skips.request(index);
  return p;
}

export async function startQueue(
  title: string,
  tracks: QueueTrack[],
  startIndex = 0,
): Promise<QueueProgress> {
  const playable = tracks.filter((t) => t.durationMs > 0 || !jellyfinConfigured());
  if (!playable.length) throw new MediaError("Nothing to play");
  const index = Math.max(0, Math.min(playable.length - 1, startIndex));
  const q: QueueState = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    tracks: playable,
    index,
    status: "playing",
    startedAt: Date.now(),
    offsetMs: 0,
    nextPushed: index + 1 < playable.length,
    stall: null,
  };
  skips.cancel();
  const started = await transport.run(() => pushTrack(playable[index]!, playable[index + 1]));
  q.startedAt = started ? Date.now() : null;
  resetStall();
  if (!started) primeStall();
  ensureQueueTimer();
  return (await setQueue(q))!;
}

export async function playSelection(sel: PlaySelection): Promise<QueueProgress> {
  const { title, tracks } = await tracksFor(sel);
  const queueTracks: QueueTrack[] = jellyfinConfigured()
    ? tracks.map(jellyfin.toQueueTrack)
    : tracks.map((t) => ({ ...t, streamUrl: "" }));
  return startQueue(title, queueTracks, 0);
}

export async function queueCommand(
  op: "next" | "prev" | "pause" | "resume" | "toggle" | "stop",
): Promise<QueueProgress | null> {
  const q = (await loadState()).queue;
  if (!q) throw new MediaError("No queue");
  const now = Date.now();
  const progress = queueProgress(q, now)!;
  const pause = async () => {
    skips.cancel();
    // Our state first (the panel must never show a running clock on a stopped amp), then the renderer.
    const p = await setQueue({
      ...q,
      status: "paused",
      startedAt: null,
      offsetMs: progress.positionMs,
    });
    if (ampConfigured()) await transport.run(() => avTransport.stop());
    return p;
  };
  const resume = () => resumeQueue(q);
  switch (op) {
    case "next":
      return skipTo(q, q.index + 1, now);
    case "prev":
      return skipTo(q, progress.positionMs > 5000 ? q.index : Math.max(0, q.index - 1), now);
    case "pause":
      return q.status === "playing" ? pause() : progress;
    case "resume":
      return resume();
    case "toggle":
      return q.status === "playing" ? pause() : resume();
    case "stop": {
      skips.cancel();
      const p = await setQueue({
        ...q,
        status: "stopped",
        startedAt: null,
        offsetMs: 0,
        stall: null,
      });
      if (ampConfigured()) await transport.run(() => avTransport.stop()).catch(() => undefined);
      return p;
    }
  }
}

/** Resume. From paused / stopped / ended: push the current (or first) track at its offset, as before. On a
 *  queue the app believes is playing: ask the renderer — PLAYING → nothing (just restart a frozen clock),
 *  anything else → re-send play for the current track from 0. This used to be a silent no-op. */
async function resumeQueue(q: QueueState): Promise<QueueProgress | null> {
  skips.cancel();
  ensureQueueTimer();
  return transport.run(async () => {
    const cur = rt.persisted?.queue;
    if (!cur || cur.id !== q.id) return queueProgress(cur ?? null, Date.now());
    const upnp =
      cur.status === "playing" && ampConfigured()
        ? await avTransport
            .transportInfo()
            .then((t) => t.state)
            .catch(() => null)
        : null;
    const d = ampConfigured()
      ? decideResume(cur.status, cur.startedAt !== null, upnp)
      : cur.status === "playing"
        ? "noop"
        : "resume";
    const t = Date.now();
    switch (d) {
      case "noop":
        return queueProgress(cur, t);
      case "unfreeze":
        resetStall();
        return setQueue({ ...cur, startedAt: t, stall: null });
      case "replay": {
        qlog(
          `resume: renderer ${upnp ?? "silent"} while we show ${trackName(cur, cur.index)} playing: replaying from 0`,
        );
        const started = await pushTrack(cur.tracks[cur.index]!, cur.tracks[cur.index + 1]);
        resetStall();
        return setQueue({
          ...cur,
          startedAt: started ? Date.now() : null,
          offsetMs: 0,
          nextPushed: cur.index + 1 < cur.tracks.length,
          stall: null,
        });
      }
      case "resume": {
        const base = cur.status === "ended" ? queueJump(cur, 0, t) : cur;
        const started = await pushTrack(
          base.tracks[base.index]!,
          base.tracks[base.index + 1],
          base.offsetMs,
        );
        resetStall();
        return setQueue({
          ...base,
          status: "playing",
          startedAt: started ? Date.now() : null,
          nextPushed: base.index + 1 < base.tracks.length,
          stall: null,
        });
      }
    }
  });
}

/** Every 2 s while playing: once our clock says the track is over, confirm with GetPositionInfo and advance. */
/**
 * After a process restart: find out what the amp is really doing and continue the persisted queue from
 * there (same mix, right index and position); push the next track if the amp stopped at a track end.
 */
async function reconcileQueueWithAmp() {
  const q = rt.persisted?.queue;
  if (!q || q.status !== "playing" || q.startedAt !== null || rt.queueBusy) return;
  if (!ampConfigured()) {
    await setQueue({ ...q, status: "stopped" });
    return;
  }
  rt.queueBusy = true;
  try {
    const [pos, tr] = await Promise.all([
      avTransport.positionInfo().catch(() => null),
      avTransport.transportInfo().catch(() => null),
    ]);
    const playingId = pos ? trackIdFromUri(pos.trackUri) : null;
    const idx = playingId ? q.tracks.findIndex((t) => t.id === playingId) : -1;
    const now = Date.now();
    if (idx >= 0 && tr?.state === "PLAYING") {
      const after = q.tracks[idx + 1];
      if (after)
        await avTransport.setNextUri(after.streamUrl, didlFor(after)).catch(() => undefined);
      await setQueue({
        ...q,
        index: idx,
        offsetMs: pos?.relTimeMs ?? 0,
        startedAt: now,
        nextPushed: after !== undefined,
      });
      console.log(`queue re-synced with the amp at track ${idx + 1}/${q.tracks.length}`);
    } else if (idx >= 0 && tr?.state === "STOPPED" && q.tracks[idx + 1]) {
      const n = {
        ...q,
        index: idx + 1,
        offsetMs: 0,
        startedAt: now,
        nextPushed: q.tracks[idx + 2] !== undefined,
      };
      const started = await transport.run(() =>
        pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]),
      );
      await setQueue({ ...n, startedAt: started ? Date.now() : null });
      console.log(`queue continued after restart: track ${n.index + 1}/${q.tracks.length}`);
    } else {
      await setQueue({ ...q, status: "stopped", startedAt: null });
      console.log("queue stopped after restart: amp is not playing it");
    }
  } catch (e) {
    console.error("queue reconcile failed:", e);
    await setQueue({ ...q, status: "stopped", startedAt: null }).catch(() => undefined);
  } finally {
    rt.queueBusy = false;
  }
}

async function queueTick() {
  // A skip is pending or a renderer call is in flight: the amp is between states, do not judge it now.
  if (rt.queueBusy || skips.busy) return;
  const q = rt.persisted?.queue;
  if (!q || q.status !== "playing") return;
  const now = Date.now();
  const due = queueDue(q, now);
  rt.queueTicks += 1;
  // Every 3rd tick normally; every tick while the clock is frozen or an idle episode is being timed.
  const verify =
    ampConfigured() &&
    (rt.queueTicks >= QUEUE_VERIFY_TICKS || q.startedAt === null || rt.stall.idleSince !== null);
  if (!due && !verify) return;
  rt.queueTicks = 0;
  rt.queueBusy = true;
  try {
    const [pos, tr, haState] = ampConfigured()
      ? await Promise.all([
          avTransport.positionInfo().catch(() => null),
          avTransport.transportInfo().catch(() => null),
          due ? Promise.resolve(null) : haPlayerState(),
        ])
      : [null, null, null];
    if (!due) {
      await verifyQueue(q, pos, tr?.state ?? null, haState, now);
      return;
    }
    const d = decideAdvance(q, pos, tr?.state ?? null);
    if (d.kind === "wait") {
      qlog(`due but amp at ${Math.round(d.relTimeMs / 1000)} s of ${trackName(q, q.index)}: wait`);
      await setQueue({ ...q, offsetMs: d.relTimeMs, startedAt: now });
    } else if (d.kind === "amp-advanced") {
      const n = { ...queueAdvance(q, now), offsetMs: d.relTimeMs, startedAt: now };
      const after = n.tracks[n.index + 1];
      if (after && ampConfigured())
        await avTransport.setNextUri(after.streamUrl, didlFor(after)).catch(() => undefined);
      await setQueue({ ...n, nextPushed: after !== undefined });
      qlog(`amp advanced to ${trackName(n, n.index)} at ${Math.round(d.relTimeMs / 1000)} s`);
    } else {
      const n = queueAdvance(q, now);
      if (n.status === "ended") {
        if (ampConfigured()) await transport.run(() => avTransport.stop()).catch(() => undefined);
        await setQueue(n);
        qlog("ended after the last track");
      } else {
        qlog(
          `pushing ${trackName(n, n.index)} (amp: ${tr?.state ?? "?"}, ${pos?.trackUri ? "uri " + (trackIdFromUri(pos.trackUri) ?? "foreign") : "no uri"})`,
        );
        const started = await transport.run(() =>
          pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]),
        );
        await setQueue({ ...n, startedAt: started ? Date.now() : null });
      }
    }
  } catch (e) {
    console.error("queue advance failed:", e);
  } finally {
    rt.queueBusy = false;
  }
}

/** Between track ends: follow the amp when it moved on its own, fix clock drift, watch for a stall. */
async function verifyQueue(
  q: QueueState,
  pos: PositionInfo | null,
  state: string | null,
  haState: string | null,
  now: number,
) {
  const d = decideVerify(q, pos, state, now);
  if (d.kind === "foreign") {
    // Host and path only: a URI from another controller may carry a token in its query.
    const shown = d.uri.replace(/\?.*$/, "");
    qlog(`amp plays something else (${shown}): queue stopped`);
    resetStall();
    await setQueue({ ...q, status: "stopped", startedAt: null, offsetMs: 0 });
    return;
  }
  // Stall watchdog: idle with time left in the track (STOPPED at the very end is the due path's business).
  const ours = queueProgress(q, now)!;
  const nearEnd = ours.durationMs > 0 && ours.positionMs >= ours.durationMs - QUEUE_END_STOP_MS;
  const idle = !nearEnd && rendererIdle(state, haState);
  const step = stallStep(rt.stall, idle, now);
  rt.stall = step.state;
  const seen = `${state ?? "no UPnP"} / HA ${haState ?? "?"}`;
  switch (step.action) {
    case "freeze":
      qlog(
        `renderer idle (${seen}) at ${Math.round(ours.positionMs / 1000)} s of ${trackName(q, q.index)}: clock frozen, watching`,
      );
      await setQueue({ ...q, startedAt: null, offsetMs: ours.positionMs });
      return;
    case "replay":
      // A track that never got past its first seconds even after a replay is one the amp refuses
      // (ogg → Jellyfin transcode, WMA; seen 2026-10-15): move on instead of replaying it again.
      if (ours.positionMs < UNPLAYABLE_MS && step.state.retries >= 2) {
        await skipUnplayable(q, now, seen);
        return;
      }
      qlog(
        `renderer still idle (${seen}): replaying ${trackName(q, q.index)} from 0, retry ${step.state.retries}/${STALL_MAX_RETRIES}`,
      );
      await replayCurrent(q.id);
      return;
    case "give-up": {
      const reason = rt.stallReason ?? STALL_REASON;
      rt.stallReason = null;
      qlog(`renderer stayed idle after ${STALL_MAX_RETRIES} replays: queue paused (${reason})`);
      await setQueue({ ...q, status: "paused", startedAt: null, stall: reason });
      return;
    }
    case "clear":
      qlog(
        `renderer playing again (${seen}) at ${Math.round((pos?.relTimeMs ?? ours.positionMs) / 1000)} s`,
      );
      rt.stallSkips = 0;
      break;
    case "none":
      if (idle) {
        // Idle again inside the backoff window: keep the clock frozen where it is.
        if (q.startedAt !== null)
          await setQueue({ ...q, startedAt: null, offsetMs: ours.positionMs });
        return;
      }
  }
  if (d.kind === "stopped") return; // an idle the watchdog is already timing
  if (d.kind === "follow") {
    const n = { ...queueJump(q, d.index, now), offsetMs: d.relTimeMs, startedAt: now };
    const after = n.tracks[n.index + 1];
    if (after) await avTransport.setNextUri(after.streamUrl, didlFor(after)).catch(() => undefined);
    await setQueue({ ...n, nextPushed: after !== undefined });
    qlog(
      `amp moved from ${trackName(q, q.index)} to ${trackName(n, n.index)} at ${Math.round(d.relTimeMs / 1000)} s: following`,
    );
  } else if (d.kind === "resync") {
    qlog(
      `clock off on ${trackName(q, q.index)}: ours ${Math.round(ours.positionMs / 1000)} s, amp ${Math.round(d.relTimeMs / 1000)} s: resync`,
    );
    await setQueue({ ...q, offsetMs: d.relTimeMs, startedAt: now });
  } else if (q.startedAt === null) {
    // Frozen clock (a skip whose Play was never confirmed, or an idle episode that cleared) while the
    // renderer plays our track: run it again from the amp's position.
    const rel =
      pos && trackIdFromUri(pos.trackUri) === q.tracks[q.index]?.id ? pos.relTimeMs : null;
    await setQueue({ ...q, startedAt: now, offsetMs: rel ?? q.offsetMs });
  }
}

// ---- Action dispatch ----
export async function performMediaAction(a: MediaAction): Promise<void> {
  switch (a.type) {
    case "amp.power": {
      // The panel's snapshot can be up to 10 s old: decide from the amp's live state so that F4 on an
      // amp that is really in standby always powers it on (seen 2026-10-08: "off" sent to a standby amp).
      const live = ampConfigured() ? await amp.basicStatus().catch(() => null) : null;
      if (live && !live.power) {
        await startPowerOn();
        break;
      }
      if (a.on) await haMedia.turnOn();
      else {
        // A queue left "playing" on an amp in standby would only be paused by the stall watchdog ~40 s later.
        if (rt.persisted?.queue?.status === "playing")
          await queueCommand("pause").catch(() => undefined);
        await haMedia.turnOff();
      }
      break;
    }
    case "amp.source":
      await haMedia.selectSource(a.source);
      break;
    case "amp.volume.step":
      await haMedia.volumeStep(a.delta);
      break;
    case "amp.volume.db":
      await haMedia.volumeDb(a.db);
      break;
    case "amp.volume.set":
      await haMedia.volumeSet(a.level);
      break;
    case "amp.reload":
      await haMedia.reloadYnca();
      break;
    case "plug":
      await haMedia.plug(a.on);
      break;
    case "tv":
      await haMedia.tv(a.op);
      break;
    case "movie":
      await haMedia.movie(a.on);
      break;
    case "fm.preset":
      await haMedia.tunerPreset(a.preset);
      break;
    case "fm.frequency":
      await amp.setFmFrequency(a.mhz);
      break;
    case "radio.step":
      await radioStep(a.delta);
      break;
    case "all_off":
      // Tolerant of entities that are already off or unavailable; the plug always goes off last.
      await haMedia.tv("turn_off").catch((e) => console.warn("all_off: TV off failed:", e));
      if (rt.persisted?.queue?.status === "playing")
        await queueCommand("pause").catch(() => undefined);
      await haMedia.turnOff().catch((e) => console.warn("all_off: amp off failed:", e));
      await sleep(3000);
      await haMedia.plug(false);
      break;
    case "radio.favourite":
      await setFavourite(a.stationId, a.add);
      break;
    case "radio.playback":
      await amp.netRadioPlayback(a.op);
      break;
    case "queue":
      await queueCommand(a.op);
      break;
    case "queue.jump":
      await queueJumpTo(a.index);
      break;
  }
}
