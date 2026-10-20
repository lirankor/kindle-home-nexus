// Bus task 026: the badge's stream quality comes with the panel config (kindle_panel get_config output rows), so a
// snapshot makes no extra call per poll; a new track since the config was read refetches it once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HaState } from "./home.server";

const loaded = vi.hoisted(() => ({
  current: null as unknown,
  next: null as unknown,
  reloads: 0,
}));
vi.mock("./panel-config.server", () => ({
  panelConfigNow: () => loaded.current,
  invalidatePanelConfig: vi.fn(),
  setMusicOutput: vi.fn(),
  ensurePanelConfig: vi.fn(async () => {
    loaded.reloads++;
    if (loaded.next) loaded.current = loaded.next;
    return loaded.current;
  }),
}));

const { playerQuality, resetQualityRefetch } = await import("./media-ha.server");

const AIR = "media_player.ma_amp_airplay";
const FLAC = {
  codec: "flac",
  sample_rate: 44100,
  bit_depth: 16,
  bit_rate: 1086,
  lossless: true,
  realtime: false,
};
const MP3 = { ...FLAC, codec: "mp3", lossless: false, bit_rate: 192 };
const cfg = (now: string, quality: unknown) => ({
  source: "ha",
  at: Date.now(),
  outputs: [{ entity_id: AIR, name: "R-N500 AirPlay", state: "playing", now, quality }],
});
const states = (title: string, artist = "U2") =>
  new Map<string, HaState>([
    [
      AIR,
      {
        entity_id: AIR,
        state: "playing",
        attributes: { media_title: title, media_artist: artist },
      } as HaState,
    ],
  ]);

describe("player quality from the panel config (bus task 026)", () => {
  beforeEach(() => {
    loaded.current = cfg("One · U2", FLAC);
    loaded.next = null;
    loaded.reloads = 0;
    resetQualityRefetch();
  });

  it("same track as when the config was read: its quality, no call", async () => {
    expect(await playerQuality(AIR, states("One"))).toEqual(FLAC);
    expect(loaded.reloads).toBe(0);
  });

  it("a new track: the config is read again once, then the new quality", async () => {
    loaded.next = cfg("Bad · U2", MP3);
    expect(await playerQuality(AIR, states("Bad"))).toEqual(MP3);
    expect(loaded.reloads).toBe(1);
  });

  it("still stale after the refetch: no badge, and no second refetch for the same track", async () => {
    loaded.next = cfg("One · U2", FLAC); // HA's state changed, the config not yet
    expect(await playerQuality(AIR, states("Bad"))).toBeNull();
    expect(await playerQuality(AIR, states("Bad"))).toBeNull();
    expect(loaded.reloads).toBe(1);
  });

  it("no row for the player or no kindle_panel 0.9.3 field: null", async () => {
    expect(await playerQuality("media_player.other", states("One"))).toBeNull();
    loaded.current = cfg("One · U2", undefined);
    expect(await playerQuality(AIR, states("One"))).toBeNull();
  });
});
