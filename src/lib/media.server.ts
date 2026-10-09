// Server-only media stack: Yamaha R-N500 XML + UPnP AVTransport clients, YTuner (NET RADIO backend),
// Jellyfin, grayscale image cache, the Jellyfin playback queue and the amp power-on job.
// Env vars are read per request from process.env and never reach the browser. Nothing runs at import time;
// without AMP_HOST / JELLYFIN_* the callers fall back to demo data (see media.functions.ts).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { HomeError, fetchStates, ha, haConfigured, service } from "@/lib/home.server";
import type { HaState } from "@/lib/home.server";
import {
  AMP,
  CATALOG_LOGO_HOSTS,
  FAVOURITES_LIST_ID,
  MIX_IDS,
  MUSIC_PAGE_SIZE,
  RADIO_LISTS,
  demoMusicList,
  demoTracks,
  findStation,
  isAmpSource,
} from "@/lib/media";
import type {
  AmpSource,
  MediaAction,
  MediaSnapshot,
  MixId,
  MusicListItem,
  MusicListResult,
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
import type { ListInfo, NetRadioPlayInfo, YtunerStation } from "@/lib/media-protocol";

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
  powerOn: PowerOnStatus | null;
  ytunerIds: { at: number; byUrl: Map<string, YtunerStation> } | null;
  mixes: { day: string; builtAt: number; items: Map<MixId, MusicTrack[]> } | null;
  mixBuilding: Promise<Map<MixId, MusicTrack[]>> | null;
  mixTimer: ReturnType<typeof setInterval> | null;
  lists: Map<string, { at: number; items: MusicListItem[] }>;
  imgNegative: Map<string, number>;
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
  powerOn: null,
  ytunerIds: null,
  mixes: null,
  mixBuilding: null,
  mixTimer: null,
  lists: new Map(),
  imgNegative: new Map(),
});

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
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
  AlbumArtists?: { Id: string; Name: string }[];
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
  artItemId:
    i.AlbumId && i.AlbumPrimaryImageTag ? i.AlbumId : i.ImageTags?.["Primary"] ? i.Id : null,
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
  albumTracks: async (albumId: string) =>
    (await userItems({ ParentId: albumId, IncludeItemTypes: "Audio", SortBy: "SortName" })).map(
      toTrack,
    ),
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
      (await jf<JfList>(`/Items/${itemId}/InstantMix`, { userId: env("JELLYFIN_USER_ID"), limit }))
        .Items ?? []
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
  streamUrl: (t: MusicTrack) =>
    pickStreamUrl(env("JELLYFIN_URL"), env("JELLYFIN_API_KEY"), t.id, t.container),
  /** Primary image, no auth needed (the amp and the image route fetch it directly). */
  artUrl: (itemId: string, width = 200) => artUrlFor(env("JELLYFIN_URL"), itemId, width),
  toQueueTrack: (t: MusicTrack): QueueTrack => ({ ...t, streamUrl: jellyfin.streamUrl(t) }),
};

// ---- Images: remote logo / art -> square grayscale PNG, cached on disk ----
const cacheDir = () => env("MEDIA_CACHE_DIR") || path.join(os.tmpdir(), "kindle-media-cache");
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
/** Fetch (YTuner-hosted URLs go via our base with the vTuner Host header), flatten, square-fit, grayscale PNG. */
export async function grayscalePng(src: string, width: number): Promise<Buffer | null> {
  const url = new URL(src);
  if (!imageHostAllowed(url)) return null;
  const file = path.join(
    cacheDir(),
    `${createHash("sha1").update(`${src}|${width}`).digest("hex")}.png`,
  );
  try {
    return await readFile(file);
  } catch {
    /* miss */
  }
  let raw: Buffer;
  try {
    if (url.hostname.toLowerCase() === YTUNER_HOST) {
      const r = await httpGet(rewriteToBase(src, ytunerBase()), { Host: YTUNER_HOST }, 10000);
      if (r.status !== 200) return null;
      raw = r.body;
    } else {
      // Follow redirects by hand so every hop is re-checked against the allowlist (no SSRF via a redirect).
      let current = url;
      let res: Response | null = null;
      for (let hop = 0; hop < 4; hop++) {
        const r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10000) });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get("location");
          if (!loc) return null;
          current = new URL(loc, current);
          if (!imageHostAllowed(current)) return null;
          continue;
        }
        res = r;
        break;
      }
      if (!res || !res.ok) return null;
      raw = Buffer.from(await res.arrayBuffer());
    }
  } catch {
    return null;
  }
  let png: Buffer;
  try {
    const { default: sharp } = await import("sharp");
    png = await sharp(raw)
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
  await mkdir(cacheDir(), { recursive: true })
    .then(() => writeFile(file, png))
    .catch(() => undefined);
  return png;
}
/** Resolves what the /media/img route accepts: a catalog station id or a Jellyfin item id (no free-form URLs). */
export async function imageFor(q: {
  station?: string | null;
  item?: string | null;
  width: number;
}): Promise<Buffer | null> {
  const width = Math.max(16, Math.min(400, Math.round(q.width)));
  if (q.station) {
    const logo = findStation(q.station)?.logo;
    return logo ? grayscalePng(logo, width) : null;
  }
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
/** plug on → amp answers on tcp 80 (60–90 s) → power on + last source via XML → (background) reconnect yamaha_ynca. Returns at once. */
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
  void runPowerOn(target);
  return powerOnStatus()!;
}
async function runPowerOn(target: AmpSource | null) {
  try {
    // Already on (false "off" reading or the user pressed it anyway): just make sure of the source and finish.
    const live = ampConfigured() ? await amp.basicStatus().catch(() => null) : null;
    if (live?.power) {
      if (target && live.input !== target) {
        setPowerStep("source");
        await haMedia.selectSource(target);
      }
      setPowerStep("done");
      return;
    }
    await haMedia.plug(true);
    setPowerStep("wait");
    const host = env("AMP_HOST");
    if (host) {
      if (!(await waitForTcp(host, 80))) throw new MediaError("Amp did not come up");
    } else await sleep(90_000);
    setPowerStep("turn_on");
    await haMedia.turnOn(); // XML when AMP_HOST is set; does not need HA's yamaha_ynca link
    await sleep(1500);
    if (target) {
      setPowerStep("source");
      await haMedia.selectSource(target);
    }
    setPowerStep("done");
    // HA's yamaha_ynca entry reconnects in the background; the panel works from the XML API meanwhile.
    if (haConfigured())
      void haMedia
        .reloadYncaIfRetrying()
        .then((r) => console.log("yamaha_ynca after power-on:", r))
        .catch((e) => console.warn("yamaha_ynca reconnect skipped:", e));
  } catch (e) {
    setPowerStep("failed", mediaErrorMessage(e));
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

/**
 * HA's amp entity is unavailable for minutes after every amp power cut (yamaha_ynca backoff). When
 * AMP_HOST is set, Basic_Status from the XML API stands in for it so the panel keeps showing the truth.
 */
export function overlayAmpStatus(
  states: Map<string, HaState>,
  basic: { power: boolean; input: string | null; volumeDb: number | null; muted: boolean } | null,
): void {
  if (!basic) return;
  const player = states.get(AMP.player);
  if (player && player.state !== "unavailable" && player.state !== "unknown") return;
  const volumeLevel =
    basic.volumeDb === null
      ? null
      : (basic.volumeDb - AMP.volumeMinDb) / (AMP.volumeMaxDb - AMP.volumeMinDb);
  const mk = (entity_id: string, state: string, attributes: Record<string, unknown>): HaState =>
    ({ entity_id, state, attributes, last_changed: "", last_updated: "" }) as unknown as HaState;
  states.set(
    AMP.player,
    mk(AMP.player, basic.power ? "on" : "off", {
      source: basic.input,
      ...(volumeLevel === null ? {} : { volume_level: Math.max(0, Math.min(1, volumeLevel)) }),
      is_volume_muted: basic.muted,
      friendly_name: "R-N500 (xml)",
    }),
  );
  if (basic.volumeDb !== null)
    states.set(
      AMP.volumeDb,
      mk(AMP.volumeDb, String(basic.volumeDb), { unit_of_measurement: "dB" }),
    );
}

type BasicCache = { at: number; value: Awaited<ReturnType<typeof amp.basicStatus>> };
const BASIC_CACHE_MS = 30_000;
let basicCache: BasicCache | null = null;
/** Basic_Status with a 30 s last-good fallback: the amp's XML API stalls for a few seconds after menu
 * changes, and one failed read must not make the panel believe the amp is off (seen 2026-10-08). */
async function basicStatusCached() {
  try {
    const value = await amp.basicStatus();
    basicCache = { at: Date.now(), value };
    return value;
  } catch {
    return basicCache && Date.now() - basicCache.at < BASIC_CACHE_MS ? basicCache.value : null;
  }
}

export async function readMediaSnapshot(): Promise<MediaSnapshot> {
  const [states, persisted, basic] = await Promise.all([
    ampConfigured() ? fetchStates().catch(() => new Map<string, HaState>()) : fetchStates(),
    loadState(),
    ampConfigured() ? basicStatusCached() : Promise.resolve(null),
  ]);
  overlayAmpStatus(states, basic);
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

async function tracksFor(sel: PlaySelection): Promise<{ title: string; tracks: MusicTrack[] }> {
  if (!jellyfinConfigured()) return { title: sel.id, tracks: demoTracks() };
  switch (sel.kind) {
    case "album": {
      const tracks = await jellyfin.albumTracks(sel.id);
      return { title: tracks[0]?.album ?? "", tracks };
    }
    case "artist": {
      const album = await jellyfin.artistRandomAlbum(sel.id);
      if (!album) throw new MediaError("No album");
      return { title: album.Name, tracks: await jellyfin.albumTracks(album.Id) };
    }
    case "track": {
      const mix = await jellyfin.instantMix(sel.id, MIX_SIZE);
      const first = mix.find((t) => t.id === sel.id);
      const rest = mix.filter((t) => t.id !== sel.id);
      return { title: first?.title ?? "", tracks: first ? [first, ...rest] : rest };
    }
    case "mix": {
      const mixes = await buildMixes();
      return { title: sel.id, tracks: mixes.get(sel.id as MixId) ?? [] };
    }
  }
}

// ---- Queue runtime ----
const QUEUE_TICK_MS = 2000;
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

/** SetAVTransportURI (retrying while the amp still answers 501 during the input switch) → Play → SetNext. */
async function pushTrack(t: QueueTrack, next: QueueTrack | undefined, seekMs = 0) {
  if (!ampConfigured()) return;
  void warmArt([t.artItemId, next?.artItemId], 160).catch(() => undefined);
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
  if (seekMs > 1000) {
    await sleep(800);
    await avTransport.seek(seekMs).catch(() => undefined);
  }
  if (next) await avTransport.setNextUri(next.streamUrl, didlFor(next)).catch(() => undefined);
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
  const n = queueJump(q, index, Date.now());
  await pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]);
  ensureQueueTimer();
  return setQueue({ ...n, startedAt: Date.now(), nextPushed: n.index + 1 < n.tracks.length });
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
  };
  await pushTrack(playable[index]!, playable[index + 1]);
  q.startedAt = Date.now();
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
  const jumpTo = async (i: number) => {
    const n = queueJump(q, i, now);
    if (n.status === "ended") {
      await avTransport.stop().catch(() => undefined);
      return setQueue(n);
    }
    await pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]);
    return setQueue({ ...n, startedAt: Date.now(), nextPushed: n.index + 1 < n.tracks.length });
  };
  const pause = async () => {
    if (ampConfigured()) await avTransport.stop();
    return setQueue({ ...q, status: "paused", startedAt: null, offsetMs: progress.positionMs });
  };
  const resume = async () => {
    const base = q.status === "ended" ? queueJump(q, 0, now) : q;
    await pushTrack(base.tracks[base.index]!, base.tracks[base.index + 1], base.offsetMs);
    ensureQueueTimer();
    return setQueue({
      ...base,
      status: "playing",
      startedAt: Date.now(),
      nextPushed: base.index + 1 < base.tracks.length,
    });
  };
  switch (op) {
    case "next":
      return jumpTo(q.index + 1);
    case "prev":
      return jumpTo(progress.positionMs > 5000 ? q.index : Math.max(0, q.index - 1));
    case "pause":
      return q.status === "playing" ? pause() : progress;
    case "resume":
      return q.status === "playing" ? progress : resume();
    case "toggle":
      return q.status === "playing" ? pause() : resume();
    case "stop":
      if (ampConfigured()) await avTransport.stop().catch(() => undefined);
      return setQueue({ ...q, status: "stopped", startedAt: null, offsetMs: 0 });
  }
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
      await pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]);
      await setQueue({ ...n, startedAt: Date.now() });
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
  if (rt.queueBusy) return;
  const q = rt.persisted?.queue;
  if (!q || q.status !== "playing") return;
  const now = Date.now();
  if (!queueDue(q, now)) return;
  rt.queueBusy = true;
  try {
    const [pos, tr] = ampConfigured()
      ? await Promise.all([
          avTransport.positionInfo().catch(() => null),
          avTransport.transportInfo().catch(() => null),
        ])
      : [null, null];
    const d = decideAdvance(q, pos, tr?.state ?? null);
    if (d.kind === "wait") {
      await setQueue({ ...q, offsetMs: d.relTimeMs, startedAt: now });
    } else if (d.kind === "amp-advanced") {
      const n = { ...queueAdvance(q, now), offsetMs: d.relTimeMs, startedAt: now };
      const after = n.tracks[n.index + 1];
      if (after && ampConfigured())
        await avTransport.setNextUri(after.streamUrl, didlFor(after)).catch(() => undefined);
      await setQueue({ ...n, nextPushed: after !== undefined });
    } else {
      const n = queueAdvance(q, now);
      if (n.status === "ended") {
        if (ampConfigured()) await avTransport.stop().catch(() => undefined);
        await setQueue(n);
      } else {
        await pushTrack(n.tracks[n.index]!, n.tracks[n.index + 1]);
        await setQueue({ ...n, startedAt: Date.now() });
      }
    }
  } catch (e) {
    console.error("queue advance failed:", e);
  } finally {
    rt.queueBusy = false;
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
      else await haMedia.turnOff();
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
