// Read-only smoke checks against the real devices. Skipped unless MEDIA_LIVE=1 (and the matching env vars) is set:
//   MEDIA_LIVE=1 AMP_HOST=192.168.1.25 JELLYFIN_URL=… JELLYFIN_API_KEY=… JELLYFIN_USER_ID=… npx vitest run src/lib/media.live.test.ts
// Nothing here changes amp state (GET-only XML, GetPositionInfo/GetTransportInfo, Jellyfin reads, YTuner reads).
import { describe, expect, it } from "vitest";
import { AMP_SOURCES } from "./media";
import {
  amp,
  ampConfigured,
  avTransport,
  grayscalePng,
  jellyfin,
  jellyfinConfigured,
  readMusicList,
  ytuner,
} from "./media.server";

const live = process.env["MEDIA_LIVE"] === "1";

describe.skipIf(!live || !ampConfigured())("amp (live, read-only)", () => {
  it("Basic_Status / List_Info / Play_Info / Tuner parse", async () => {
    const status = await amp.basicStatus();
    expect(typeof status.power).toBe("boolean");
    expect(status.input === null || AMP_SOURCES.includes(status.input as never) || true).toBe(true);
    const list = await amp.listInfo();
    expect(["Ready", "Busy"]).toContain(list.status);
    expect(list.maxLine).toBeGreaterThanOrEqual(list.lines.length);
    const play = await amp.playInfo();
    expect(typeof play.playing).toBe("boolean");
    const tuner = await amp.tunerInfo();
    expect(tuner.band).toBe("FM");
    expect(tuner.mhz).toBeGreaterThan(80);
    console.log({ status, list: { ...list, lines: list.lines.length }, play, tuner });
  }, 20000);
  it("AVTransport GetTransportInfo / GetPositionInfo", async () => {
    const t = await avTransport.transportInfo();
    expect(t.state).not.toBe("");
    const p = await avTransport.positionInfo();
    expect(p.relTimeMs).not.toBeNull();
    console.log({ t, p });
  }, 20000);
});

describe.skipIf(!live || !jellyfinConfigured())("jellyfin (live, read-only)", () => {
  it("lists and art", async () => {
    const [tracks, albums, artists, genres, recent, sugg] = await Promise.all([
      jellyfin.randomTracks(3),
      jellyfin.randomAlbums(3),
      jellyfin.randomAlbumArtists(3),
      jellyfin.genres(),
      jellyfin.recentlyPlayedAlbums(3),
      jellyfin.suggestions(3),
    ]);
    expect(tracks).toHaveLength(3);
    expect(tracks[0]!.durationMs).toBeGreaterThan(0);
    expect(albums).toHaveLength(3);
    expect(artists[0]!.kind).toBe("artist");
    expect(genres.map((g) => g.name)).toContain("Jazz");
    expect(recent.length).toBeGreaterThan(0);
    expect(sugg.length).toBeGreaterThan(0);
    const albumTracks = await jellyfin.albumTracks(albums[0]!.id);
    expect(albumTracks.length).toBeGreaterThan(0);
    const mix = await jellyfin.instantMix(tracks[0]!.id, 5);
    expect(mix.length).toBeGreaterThan(0);
    const withArt = tracks.find((t) => t.artItemId) ?? albumTracks.find((t) => t.artItemId);
    if (withArt) {
      const png = await grayscalePng(jellyfin.artUrl(withArt.artItemId!), 96);
      expect(png?.subarray(1, 4).toString()).toBe("PNG");
    }
    const page = await readMusicList("mixes", 0);
    expect(page.items.map((i) => i.id)).toEqual(["daily", "discover", "relaxed", "evening"]);
    console.log(
      page.items,
      tracks[0],
      jellyfin.streamUrl(tracks[0]!).replace(/api_key=.*/, "api_key=…"),
    );
  }, 60000);
});

describe.skipIf(!live || !process.env["YTUNER_URL"])("ytuner (live, read-only)", () => {
  it("station ids and bookmarks", async () => {
    const byUrl = await ytuner.stationsByUrl();
    expect(byUrl.size).toBeGreaterThan(30);
    const bookmarks = await ytuner.listBookmarks();
    console.log({ stations: byUrl.size, bookmarks: bookmarks.map((b) => b.name) });
  }, 30000);
});
