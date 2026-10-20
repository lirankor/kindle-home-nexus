import { describe, expect, it } from "vitest";

import { codecLabel, freshQuality, khz, qualityBadge } from "./quality";
import type { StreamQuality } from "./quality";

const q = (over: Partial<StreamQuality>): StreamQuality => ({
  codec: "flac",
  sample_rate: 44100,
  bit_depth: 16,
  bit_rate: 1086,
  lossless: true,
  realtime: false,
  ...over,
});

describe("stream quality badge (bus task 026)", () => {
  it("lossless is HQ at any rate; Hi-Res above 48 kHz or 16 bit", () => {
    expect(qualityBadge(q({}))).toEqual({ tier: "HQ", hiRes: false, detail: "FLAC 44.1/16" });
    expect(qualityBadge(q({ sample_rate: 48000, bit_depth: 16 }))?.hiRes).toBe(false);
    expect(qualityBadge(q({ sample_rate: 96000, bit_depth: 24 }))).toEqual({
      tier: "HQ",
      hiRes: true,
      detail: "FLAC 96/24",
    });
    expect(qualityBadge(q({ sample_rate: 44100, bit_depth: 24 }))?.hiRes).toBe(true);
    expect(qualityBadge(q({ codec: "alac", sample_rate: 176400 }))?.detail).toBe("ALAC 176.4/16");
    // by codec name when the panel's flag is missing / false
    expect(qualityBadge(q({ codec: "wav", lossless: false }))?.tier).toBe("HQ");
    expect(qualityBadge(q({ codec: "s24le", lossless: true, bit_depth: 24 }))?.detail).toBe(
      "PCM 44.1/24",
    );
    expect(qualityBadge(q({ sample_rate: null, bit_depth: null }))?.detail).toBe("FLAC");
  });

  it("lossy is SQ at 192 kbps or more, LQ below", () => {
    const lossy = (codec: string, bit_rate: number | null) =>
      qualityBadge(q({ codec, bit_rate, lossless: false }));
    expect(lossy("mp3", 320)).toEqual({ tier: "SQ", hiRes: false, detail: "MP3 320k" });
    expect(lossy("aac", 256)?.tier).toBe("SQ");
    expect(lossy("mp3", 192)?.tier).toBe("SQ");
    expect(lossy("mp3", 191)?.tier).toBe("LQ");
    expect(lossy("aac", 128)).toEqual({ tier: "LQ", hiRes: false, detail: "AAC 128k" });
    expect(lossy("vorbis", 224)?.detail).toBe("OGG 224k");
    expect(lossy("mpeg", 160)?.detail).toBe("MP3 160k");
    // a lossy file without a rate: LQ, codec only
    expect(lossy("opus", null)).toEqual({ tier: "LQ", hiRes: false, detail: "OPUS" });
  });

  it("radio / live streams: LQ without a known rate, by their rate when the stream tells one", () => {
    const live = (bit_rate: number | null, codec: string | null = "mp3") =>
      qualityBadge(q({ codec, bit_rate, lossless: false, realtime: true }));
    expect(live(null)).toEqual({ tier: "LQ", hiRes: false, detail: "Stream" });
    expect(live(128)).toEqual({ tier: "LQ", hiRes: false, detail: "Stream 128k" });
    expect(live(256, null)).toEqual({ tier: "SQ", hiRes: false, detail: "Stream 256k" });
    expect(live(0)?.detail).toBe("Stream");
    // a lossless live stream is still HQ
    expect(qualityBadge(q({ realtime: true }))?.tier).toBe("HQ");
  });

  it("nothing when Music Assistant reports no stream", () => {
    expect(qualityBadge(null)).toBeNull();
    expect(qualityBadge(undefined)).toBeNull();
    expect(qualityBadge(q({ codec: null, bit_rate: null, lossless: false }))).toBeNull();
    expect(qualityBadge(q({ codec: "?", bit_rate: null, lossless: false }))).toBeNull();
  });

  it("labels", () => {
    expect(codecLabel("flac")).toBe("FLAC");
    expect(codecLabel("?")).toBeNull();
    expect(codecLabel("m4a")).toBe("AAC");
    expect(khz(44100)).toBe("44.1");
    expect(khz(48000)).toBe("48");
    expect(khz(192000)).toBe("192");
  });

  it("a quality read with the config is used only while the player still plays the same line", () => {
    const row = { quality: q({}), now: "Hotel California · Eagles" };
    expect(freshQuality(row, "Hotel California · Eagles")).toEqual({
      quality: row.quality,
      stale: false,
    });
    expect(freshQuality(row, "New Kid in Town · Eagles")).toEqual({ quality: null, stale: true });
    expect(freshQuality(null, "x")).toEqual({ quality: null, stale: false });
    expect(freshQuality({ now: null }, null)).toEqual({ quality: null, stale: false });
  });
});
