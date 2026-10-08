// Pure protocol helpers for the media stack (no I/O): Yamaha XML command/response parsing,
// UPnP AVTransport SOAP + DIDL-Lite building, YTuner station XML, Jellyfin stream URL choice and
// the playback-queue arithmetic. Everything here is unit-tested without a network.
import type { QueueProgress, QueueState, QueueTrack } from "./media";

// ---- Tiny XML helpers (tag based, namespace-agnostic, no XML library) ----
export const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Raw inner content of the first `<name …>…</name>` anywhere in the document (null if absent). */
export function xmlBlock(xml: string, name: string): string | null {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${escapeRe(name)}>`,
  );
  const m = re.exec(xml);
  if (m) return m[1] ?? "";
  return new RegExp(`<(?:[\\w-]+:)?${escapeRe(name)}(?:\\s[^>]*)?/>`).test(xml) ? "" : null;
}
/** All inner contents of `<name>…</name>` in document order. */
export function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${escapeRe(name)}>`,
    "g",
  );
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? "");
  return out;
}
/** Unescaped, trimmed text of the first `<name>` (null if the tag is absent, "" if empty). */
export const xmlText = (xml: string, name: string): string | null => {
  const b = xmlBlock(xml, name);
  return b === null ? null : xmlUnescape(b.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
};
const xmlInt = (xml: string, name: string): number | null => {
  const t = xmlText(xml, name);
  if (t === null || t === "") return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
};

// ---- Yamaha XML API (POST /YamahaRemoteControl/ctrl) ----
export const yamahaCmd = (cmd: "GET" | "PUT", inner: string) =>
  `<YAMAHA_AV cmd="${cmd}">${inner}</YAMAHA_AV>`;
/** `RC="0"` means accepted; any other return code is an error. */
export const yamahaRc = (xml: string): number => {
  const m = /RC="(\d+)"/.exec(xml);
  return m ? parseInt(m[1] ?? "0", 10) : -1;
};

/** `<Val>-445</Val><Exp>1</Exp>` -> -44.5 */
export function scaledValue(block: string | null): number | null {
  if (block === null) return null;
  const val = xmlInt(block, "Val");
  const exp = xmlInt(block, "Exp") ?? 0;
  return val === null ? null : val / 10 ** exp;
}

export type BasicStatus = {
  power: boolean;
  input: string | null;
  volumeDb: number | null;
  muted: boolean;
};
export function parseBasicStatus(xml: string): BasicStatus {
  const volume = xmlBlock(xml, "Volume");
  return {
    power: xmlText(xml, "Power") === "On",
    input: xmlText(xml, "Input_Sel"),
    volumeDb: scaledValue(volume === null ? null : xmlBlock(volume, "Lvl")),
    muted: volume !== null && xmlText(volume, "Mute") === "On",
  };
}

export type ListLine = { line: number; text: string; attribute: string };
export type ListInfo = {
  /** Ready | Busy */
  status: string;
  layer: number;
  name: string;
  currentLine: number;
  maxLine: number;
  lines: ListLine[];
};
export function parseListInfo(xml: string): ListInfo {
  const lines: ListLine[] = [];
  for (let i = 1; i <= 8; i++) {
    const b = xmlBlock(xml, `Line_${i}`);
    if (b === null) continue;
    const text = xmlText(b, "Txt") ?? "";
    const attribute = xmlText(b, "Attribute") ?? "";
    // Empty "Unselectable" lines are placeholders (menu not loaded / input not NET RADIO).
    if (text !== "") lines.push({ line: i, text, attribute });
  }
  return {
    status: xmlText(xml, "Menu_Status") ?? "",
    layer: xmlInt(xml, "Menu_Layer") ?? 0,
    name: xmlText(xml, "Menu_Name") ?? "",
    currentLine: xmlInt(xml, "Current_Line") ?? 0,
    maxLine: xmlInt(xml, "Max_Line") ?? 0,
    lines,
  };
}

export type NetRadioPlayInfo = {
  ready: boolean;
  playing: boolean;
  station: string;
  song: string;
  album: string;
};
export function parseNetRadioPlayInfo(xml: string): NetRadioPlayInfo {
  return {
    ready: xmlText(xml, "Feature_Availability") === "Ready",
    playing: xmlText(xml, "Playback_Info") === "Play",
    station: xmlText(xml, "Station") ?? "",
    song: xmlText(xml, "Song") ?? "",
    album: xmlText(xml, "Album") ?? "",
  };
}

export type TunerPlayInfo = {
  ready: boolean;
  band: string;
  /** Current FM frequency in MHz (e.g. 102.8). */
  mhz: number | null;
  preset: number | null;
  tuned: boolean;
  stereo: boolean;
  programService: string;
  radioText: string;
};
export function parseTunerPlayInfo(xml: string): TunerPlayInfo {
  const freq = xmlBlock(xml, "Freq");
  const current = freq === null ? null : (xmlBlock(freq, "Current") ?? xmlBlock(freq, "FM"));
  const signal = xmlBlock(xml, "Signal_Info") ?? "";
  return {
    ready: xmlText(xml, "Feature_Availability") === "Ready",
    band: xmlText(xml, "Band") ?? "",
    mhz: scaledValue(current),
    preset: xmlInt(xml, "Preset_Sel"),
    tuned: xmlText(signal, "Tuned") === "Assert",
    stereo: xmlText(signal, "Stereo") === "Assert",
    programService: xmlText(xml, "Program_Service") ?? "",
    radioText: xmlText(xml, "Radio_Text_A") ?? "",
  };
}

/** Direct FM tuning: 102.8 MHz -> Val 10280 Exp 2 (never a seek, which drops HA for a minute). */
export const fmFrequencyXml = (mhz: number) =>
  `<Tuner><Play_Control><Tuning><Freq><FM><Val>${Math.round(mhz * 100)}</Val><Exp>2</Exp><Unit>MHz</Unit></FM></Freq></Tuning></Play_Control></Tuner>`;
export const netRadioControlXml = (inner: string) =>
  `<NET_RADIO><List_Control>${inner}</List_Control></NET_RADIO>`;
export const inputSelXml = (input: string) =>
  `<Main_Zone><Input><Input_Sel>${xmlEscape(input)}</Input_Sel></Input></Main_Zone>`;

// ---- UPnP AVTransport (SOAP) ----
export const AVT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";

export type DidlMeta = {
  title: string;
  artist?: string | null;
  album?: string | null;
  albumArtUri?: string | null;
  url: string;
  mime?: string;
  durationMs?: number | null;
};
/** DIDL-Lite the amp shows on its display (and YNCA then mirrors into HA). Values are XML-escaped once here. */
export function buildDidl(m: DidlMeta): string {
  const mime = m.mime ?? "audio/mpeg";
  const dur = m.durationMs ? ` duration="${formatHms(m.durationMs)}"` : "";
  const opt = (tag: string, v: string | null | undefined) =>
    v ? `<${tag}>${xmlEscape(v)}</${tag}>` : "";
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(m.title)}</dc:title>` +
    opt("upnp:artist", m.artist) +
    opt("dc:creator", m.artist) +
    opt("upnp:album", m.album) +
    opt("upnp:albumArtURI", m.albumArtUri) +
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
    `<res protocolInfo="http-get:*:${mime}:*"${dur}>${xmlEscape(m.url)}</res>` +
    "</item></DIDL-Lite>"
  );
}

/** SOAP body; argument values are escaped here, so a DIDL argument ends up escaped twice (as UPnP requires). */
export function soapEnvelope(action: string, args: Record<string, string | number>): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVT_SERVICE}"><InstanceID>0</InstanceID>${body}</u:${action}></s:Body></s:Envelope>`
  );
}
export const soapFaultCode = (xml: string): string | null =>
  xmlText(xml, "errorCode") ?? (xmlBlock(xml, "Fault") === null ? null : "fault");

/** "0:03:21" or "0:03:21.500" -> ms */
export function parseHms(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const [, h, mi, se, frac] = m;
  const ms = frac ? Math.round(parseFloat(`0.${frac}`) * 1000) : 0;
  return ((+h! * 60 + +mi!) * 60 + +se!) * 1000 + ms;
}
/** ms -> "H:MM:SS" (the Seek target format the amp accepts) */
export function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export type PositionInfo = {
  track: number;
  trackUri: string;
  durationMs: number | null;
  relTimeMs: number | null;
};
export const parsePositionInfo = (xml: string): PositionInfo => ({
  track: xmlInt(xml, "Track") ?? 0,
  trackUri: xmlText(xml, "TrackURI") ?? "",
  durationMs: parseHms(xmlText(xml, "TrackDuration")),
  relTimeMs: parseHms(xmlText(xml, "RelTime")),
});
export type TransportInfo = { state: string; status: string };
export const parseTransportInfo = (xml: string): TransportInfo => ({
  state: xmlText(xml, "CurrentTransportState") ?? "",
  status: xmlText(xml, "CurrentTransportStatus") ?? "",
});

// ---- YTuner (vTuner emulation) ----
export type YtunerStation = {
  id: string;
  name: string;
  url: string;
  logo: string | null;
  bookmark: string | null;
  /** Category ("My Stations" folder) the station belongs to. */
  format: string;
};
/** Stations of a ListOfItems document; "Display" items (e.g. "No station(s) found") are skipped. */
export function parseYtunerStations(xml: string): YtunerStation[] {
  return xmlBlocks(xml, "Item")
    .filter((item) => xmlText(item, "ItemType") === "Station")
    .map((item) => ({
      id: xmlText(item, "StationId") ?? "",
      name: xmlText(item, "StationName") ?? "",
      url: xmlText(item, "StationUrl") ?? "",
      logo: xmlText(item, "Logo") || null,
      bookmark: xmlText(item, "Bookmark") || null,
      format: xmlText(item, "StationFormat") ?? "",
    }))
    .filter((s) => s.id !== "");
}
/** Replace the scheme+host YTuner advertises (radioyamaha.vtuner.com) with the base we can reach. */
export function rewriteToBase(url: string, base: string): string {
  const u = new URL(url);
  return `${base.replace(/\/+$/, "")}${u.pathname}${u.search}`;
}
/** Stream URLs compared loosely: scheme, trailing slash and case of the host do not matter. */
export const normalizeStreamUrl = (url: string) =>
  url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

// ---- Jellyfin ----
/** Containers the R-N500 plays natively from a static stream; everything else is transcoded to mp3. */
const NATIVE_CONTAINERS = ["mp3", "flac", "aac", "m4a", "wma", "asf", "wav"];
export function pickStreamUrl(
  base: string,
  apiKey: string,
  trackId: string,
  container: string | null,
) {
  const root = base.replace(/\/+$/, "");
  const c = (container ?? "").toLowerCase().split(",")[0] ?? "";
  // No "&" in the URL the amp gets: the R-N500 takes the stream URL from the DIDL metadata, double-escapes
  // "&" and mangles SetNextAVTransportURI when the URL contains one (verified 2026-10-08). Jellyfin serves
  // audio streams without an api key, so static streams need a single query parameter only.
  if (NATIVE_CONTAINERS.includes(c))
    return `${root}/Audio/${trackId}/stream.${c === "mp3" ? "mp3" : c}?static=true`;
  // Transcode (ogg/opus/unknown) needs the key and several parameters; the amp still plays it, only the
  // gapless next-track handoff falls back to the queue timer for these.
  return `${root}/Audio/${trackId}/universal?container=mp3&audioCodec=mp3&maxStreamingBitrate=320000&api_key=${encodeURIComponent(apiKey)}`;
}
export const streamMime = (container: string | null) => {
  const c = (container ?? "").toLowerCase().split(",")[0] ?? "";
  if (c === "flac") return "audio/flac";
  if (c === "wav") return "audio/wav";
  if (c === "aac" || c === "m4a") return "audio/mp4";
  if (c === "wma" || c === "asf") return "audio/x-ms-wma";
  return "audio/mpeg";
};
export const artUrlFor = (base: string, itemId: string, width = 200) =>
  `${base.replace(/\/+$/, "")}/Items/${itemId}/Images/Primary?maxWidth=${width}`;
/** Jellyfin item id inside a stream URL the amp reports back as TrackURI. */
export const trackIdFromUri = (uri: string): string | null => {
  const m = /\/Audio\/([^/?]+)\//.exec(uri);
  return m ? (m[1] ?? null) : null;
};

// ---- Queue arithmetic (the amp never reports STOPPED at the end of a pushed track) ----
export const QUEUE_END_SLACK_MS = 400;

export function queueProgress(q: QueueState | null, now: number): QueueProgress | null {
  if (!q) return null;
  const track = q.tracks[q.index] ?? null;
  const durationMs = track?.durationMs ?? 0;
  const raw =
    q.status === "playing" && q.startedAt !== null ? q.offsetMs + (now - q.startedAt) : q.offsetMs;
  const positionMs = Math.max(0, durationMs > 0 ? Math.min(durationMs, raw) : raw);
  return {
    title: q.title,
    index: q.index,
    count: q.tracks.length,
    track: track ? stripStream(track) : null,
    positionMs,
    durationMs,
    status: q.status,
  };
}
export const stripStream = (t: QueueTrack) => {
  const { streamUrl: _omit, ...rest } = t;
  return rest;
};

/** True once our clock says the current track is over. */
export function queueDue(q: QueueState, now: number): boolean {
  const p = queueProgress(q, now);
  return (
    q.status === "playing" &&
    p !== null &&
    p.durationMs > 0 &&
    q.offsetMs + (now - (q.startedAt ?? now)) >= p.durationMs - QUEUE_END_SLACK_MS
  );
}

/** Start playing index i at offset 0 (does not touch tracks). */
export const queueJump = (q: QueueState, index: number, now: number): QueueState =>
  index < 0 || index >= q.tracks.length
    ? { ...q, status: "ended", startedAt: null, offsetMs: 0, nextPushed: false }
    : { ...q, index, status: "playing", startedAt: now, offsetMs: 0, nextPushed: false };
export const queueAdvance = (q: QueueState, now: number) => queueJump(q, q.index + 1, now);

export type AdvanceDecision =
  /** The amp already moved to the next track by itself (SetNextAVTransportURI worked): sync our clock. */
  | { kind: "amp-advanced"; relTimeMs: number }
  /** Still on the old track past its end: push the next one ourselves. */
  | { kind: "push-next" }
  /** Position says the track is not actually over yet (buffering / slow start): resync and wait. */
  | { kind: "wait"; relTimeMs: number };
/** Reconcile our timer with GetPositionInfo once the timer says the track is due. */
export function decideAdvance(q: QueueState, pos: PositionInfo | null): AdvanceDecision {
  if (!pos) return { kind: "push-next" };
  const playingId = trackIdFromUri(pos.trackUri);
  const next = q.tracks[q.index + 1];
  const cur = q.tracks[q.index];
  if (next && playingId === next.id) return { kind: "amp-advanced", relTimeMs: pos.relTimeMs ?? 0 };
  if (
    cur &&
    playingId === cur.id &&
    pos.relTimeMs !== null &&
    cur.durationMs > 0 &&
    pos.relTimeMs < cur.durationMs - 3000
  )
    return { kind: "wait", relTimeMs: pos.relTimeMs };
  return { kind: "push-next" };
}
