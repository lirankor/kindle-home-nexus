// Stream quality badge (bus task 026): the letters on the music screen, from what Music Assistant streams for the
// current queue item (kindle_panel >= 0.9.3: `quality` on get_config's output rows, from MA's
// streamdetails.audio_format). Pure; unit tested.

/** What kindle_panel reports (Hz, bits, kbps); null fields = MA does not know. */
export type StreamQuality = {
  codec: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bit_rate: number | null;
  lossless: boolean;
  realtime: boolean;
};

export type QualityTier = "HQ" | "SQ" | "LQ";
export type QualityBadge = {
  tier: QualityTier;
  /** HQ above CD quality (sample rate > 48 kHz or bit depth > 16): the small caption under the letters. */
  hiRes: boolean;
  /** One short line beside the letters: "FLAC 44.1/16", "MP3 320k", "AAC 128k", "Stream 128k". */
  detail: string;
};

/** Lossy at this rate or more is SQ (MP3 320, AAC 256, Vorbis q6+ …); below it LQ. */
export const SQ_MIN_KBPS = 192;

const LOSSLESS = new Set([
  "flac",
  "alac",
  "wav",
  "aiff",
  "pcm",
  "wavpack",
  "ape",
  "tak",
  "dsf",
  "s16le",
  "s24le",
  "s32le",
  "f32le",
  "s16be",
  "s24be",
  "s32be",
]);
/** MA's codec names as people read them. */
const CODEC_LABEL: Record<string, string> = {
  mpeg: "MP3",
  mp4a: "AAC",
  m4a: "AAC",
  mp4: "AAC",
  vorbis: "OGG",
  wavpack: "WV",
};

const pos = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export const codecLabel = (codec: string | null | undefined): string | null => {
  const c = (codec ?? "").trim().toLowerCase();
  if (!c || c === "?" || c === "unknown") return null;
  if (/^[sf]\d\d[lb]e$/.test(c)) return "PCM";
  return CODEC_LABEL[c] ?? c.toUpperCase();
};

/** 44100 → "44.1", 48000 → "48", 96000 → "96", 176400 → "176.4". */
export const khz = (hz: number): string => String(Math.round(hz / 100) / 10);

export const isLossless = (q: Pick<StreamQuality, "codec" | "lossless">): boolean =>
  q.lossless === true || LOSSLESS.has((q.codec ?? "").trim().toLowerCase());

/** The badge for a stream, null when Music Assistant reports none (no badge). */
export function qualityBadge(q: StreamQuality | null | undefined): QualityBadge | null {
  if (!q || typeof q !== "object") return null;
  const rate = pos(q.bit_rate);
  const sr = pos(q.sample_rate);
  const depth = pos(q.bit_depth);
  const codec = codecLabel(q.codec);
  if (isLossless(q)) {
    const fmt = sr ? `${khz(sr)}${depth ? `/${depth}` : ""}` : "";
    return {
      tier: "HQ",
      hiRes: (sr ?? 0) > 48_000 || (depth ?? 0) > 16,
      detail: [codec ?? "Lossless", fmt].filter(Boolean).join(" "),
    };
  }
  const kbps = rate ? `${Math.round(rate)}k` : "";
  if (q.realtime) {
    // a live stream (radio): its rate when the stream tells one; without it LQ
    return {
      tier: rate !== null && rate >= SQ_MIN_KBPS ? "SQ" : "LQ",
      hiRes: false,
      detail: ["Stream", kbps].filter(Boolean).join(" "),
    };
  }
  if (!codec && rate === null) return null; // nothing known about it
  return {
    tier: rate !== null && rate >= SQ_MIN_KBPS ? "SQ" : "LQ",
    hiRes: false,
    detail: [codec ?? "Stream", kbps].filter(Boolean).join(" "),
  };
}

/** Pure: the quality from kindle_panel's output rows, only while it still describes what the player plays now.
 *  The rows come with the panel config (cached up to 30 s); `cachedNow` is the row's "Title · Artist" at that time,
 *  `liveNow` the player's line from the current HA state. A different line = a new track since then: stale. */
export function freshQuality(
  row: { quality?: StreamQuality | null; now?: string | null } | null | undefined,
  liveNow: string | null,
): { quality: StreamQuality | null; stale: boolean } {
  if (!row) return { quality: null, stale: false };
  if ((row.now ?? null) !== liveNow) return { quality: null, stale: true };
  return { quality: row.quality ?? null, stale: false };
}
