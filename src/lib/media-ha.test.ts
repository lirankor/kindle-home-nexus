import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaState } from "./home.server";
import { AMP, RADIO_LISTS } from "./media";
import type { MusicTrack } from "./media";
import {
  BRIDGE,
  panelSource,
  performMediaActionHa,
  playSelectionHa,
  positionOf,
  powerOnFromHa,
  projectStates,
  queueFromHa,
  readMediaSnapshotHa,
  stationByName,
  withRadio,
} from "./media-ha.server";
import type { HaMusicState } from "./media-ha.server";
import { buildMediaSnapshot } from "./media.server";

const track = (title: string, id: string) => ({
  title,
  id,
  uri: `jellyfin://track/${id}`,
  albumId: `alb-${id}`,
  artist: "Eagles",
  album: "Hotel California",
  artUrl: null,
  durationMs: 300_000,
});

const music = (over: Partial<HaMusicState> = {}): HaMusicState => ({
  ok: true,
  amp: {
    available: true,
    on: true,
    state: "on",
    playing: true,
    source: "SERVER",
    volumeDb: -40,
    muted: false,
  },
  powerOn: { running: false, step: "done", error: null },
  nowPlaying: {
    kind: "queue",
    title: "Hotel California",
    artist: "Eagles",
    album: "Hotel California",
    station: null,
    artUrl: null,
  },
  queue: {
    title: "Eagles",
    status: "playing",
    stall: null,
    index: 2,
    count: 40,
    positionMs: 61_000,
    durationMs: 390_000,
    track: track("Hotel California", "t1"),
    next: [track("New Kid in Town", "t2")],
  },
  radio: null,
  player: "media_player.ma_amp_dlna",
  output: "dlna",
  ...over,
});

const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState =>
  ({ entity_id, state, attributes }) as HaState;

describe("pure mappings", () => {
  it("maps MA's queue to the panel's queue progress with album art ids", () => {
    const q = queueFromHa(music())!;
    expect(q.index).toBe(2);
    expect(q.count).toBe(40);
    expect(q.track?.title).toBe("Hotel California");
    expect(q.track?.artItemId).toBe("alb-t1");
    expect(q.nextTracks?.[0]?.title).toBe("New Kid in Town");
    expect(q.stall).toBeNull();
    expect(queueFromHa(music({ queue: null }))).toBeNull();
  });
  it("treats AirPlay as the music path", () => {
    expect(panelSource("AirPlay")).toBe("SERVER");
    expect(panelSource("CD")).toBe("CD");
    expect(panelSource("USB")).toBeNull();
  });
  it("finds catalogue stations and their dial position by name", () => {
    const first = RADIO_LISTS[0]!.stations[0]!;
    expect(stationByName(first.name.toUpperCase())?.id).toBe(first.id);
    expect(positionOf(first.name)).toEqual({ list: RADIO_LISTS[0]!.id, index: 0 });
    expect(positionOf("no such station")).toBeNull();
  });
  it("maps the bridge's power-on steps", () => {
    const s = music({ powerOn: { running: true, step: "boot", error: null } });
    expect(powerOnFromHa(s, 10_000, 4_000)).toMatchObject({
      running: true,
      step: "wait",
      elapsedMs: 6_000,
    });
    expect(
      powerOnFromHa(music({ powerOn: { running: false, step: "idle", error: null } }), 1, 1),
    ).toBeNull();
  });
});

describe("snapshot through the panel's own builder", () => {
  it("shows the bridge as the amp and MA's queue as now playing", () => {
    const states = new Map([
      [BRIDGE, st(BRIDGE, "on", { source: "SERVER", volume_db: -40 })],
      ["media_player.ma_amp_dlna", st("media_player.ma_amp_dlna", "playing")],
    ]);
    const s = music();
    const snap = buildMediaSnapshot(projectStates(states, s), { queue: queueFromHa(s) });
    expect(snap.amp.on).toBe(true);
    expect(snap.amp.playing).toBe(true);
    expect(snap.amp.source).toBe("SERVER");
    expect(snap.amp.volumeDb).toBe(-40);
    expect(snap.nowPlaying.kind).toBe("music");
    expect(snap.nowPlaying.title).toBe("Hotel California");
    expect(snap.nowPlaying.artItemId).toBe("alb-t1");
  });
  it("shows MA radio over AirPlay as radio on the catalogue station", () => {
    const station = RADIO_LISTS[1]!.stations[0]!;
    const states = new Map([[BRIDGE, st(BRIDGE, "on", { source: "AirPlay" })]]);
    const s = music({
      amp: { ...music().amp, source: "AirPlay" },
      nowPlaying: {
        kind: "radio",
        title: station.name,
        artist: null,
        album: null,
        station: station.name,
        artUrl: null,
      },
      queue: null,
      radio: { station: station.name },
    });
    const snap = withRadio(buildMediaSnapshot(projectStates(states, s), {}), s);
    expect(snap.nowPlaying.kind).toBe("radio");
    expect(snap.nowPlaying.stationId).toBe(station.id);
    expect(snap.radio).toEqual({ list: RADIO_LISTS[1]!.id, index: 0 });
  });
  it("an amp in standby is off", () => {
    const states = new Map([[BRIDGE, st(BRIDGE, "off")]]);
    const s = music({ amp: { ...music().amp, on: false, state: "off" }, queue: null });
    const snap = buildMediaSnapshot(projectStates(states, s), {});
    expect(snap.amp.on).toBe(false);
    expect(snap.nowPlaying.kind).toBe("none");
  });
});

describe("HA calls", () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    calls.length = 0;
    process.env["HA_TOKEN"] = "t";
    process.env["HA_BASE_URL"] = "http://ha.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace("http://ha.test", "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path, body });
        let payload: unknown = [];
        if (path === "/api/states")
          payload = [
            { entity_id: BRIDGE, state: "on", attributes: { source: "SERVER", volume_db: -40 } },
            { entity_id: "media_player.ma_amp_dlna", state: "playing", attributes: {} },
            { entity_id: AMP.tv, state: "off", attributes: {} },
          ];
        else if (path.startsWith("/api/services/script/music_state"))
          payload = { changed_states: [], service_response: music() };
        else if (path.startsWith("/api/services/script/music_play_items"))
          payload = {
            changed_states: [],
            service_response: { ok: true, status: "playing", count: 2 },
          };
        else if (path.startsWith("/api/services/script/music_control"))
          payload = { changed_states: [], service_response: { ok: true } };
        else if (path.startsWith("/api/services/script/play_radio"))
          payload = { changed_states: [], service_response: { ok: true, status: "tuned" } };
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hands the panel's chosen tracks to HA in order", async () => {
    const tracks = [{ id: "a" }, { id: "b" }] as MusicTrack[];
    const q = await playSelectionHa({ kind: "mix", id: "s80" }, async () => ({
      title: "80s",
      tracks,
    }));
    const call = calls.find((c) => c.path.startsWith("/api/services/script/music_play_items"))!;
    expect(call.path).toContain("return_response");
    expect(call.body["media_ids"]).toEqual(["jellyfin://track/a", "jellyfin://track/b"]);
    expect(q?.title).toBe("80s");
    expect(q?.count).toBe(2);
  });
  it("routes queue keys through script.music_control and volume to the bridge in dB", async () => {
    const legacy = vi.fn(async () => undefined);
    await performMediaActionHa({ type: "queue", op: "prev" }, legacy);
    expect(calls.at(-1)?.body).toEqual({ op: "previous" });
    await performMediaActionHa({ type: "amp.volume.step", delta: -1 }, legacy);
    expect(calls.at(-1)?.path).toBe("/api/services/yamaha_netbridge/step_volume_db");
    expect(calls.at(-1)?.body).toEqual({ entity_id: BRIDGE, delta_db: -AMP.volumeStepDb });
    await performMediaActionHa({ type: "tv", op: "turn_on" }, legacy);
    expect(legacy).toHaveBeenCalledOnce(); // TV / plug / movie keep their old path
  });
  it("tunes a catalogue station by name through script.play_radio", async () => {
    const station = RADIO_LISTS[0]!.stations[2]!;
    const { tuneRadioHa } = await import("./media-ha.server");
    const pos = await tuneRadioHa(RADIO_LISTS[0]!.id, 2);
    expect(calls.at(-1)?.body).toEqual({ station: station.name });
    expect(pos).toEqual({ list: RADIO_LISTS[0]!.id, index: 2 });
  });
  it("builds the snapshot from HA states + script.music_state", async () => {
    const snap = await readMediaSnapshotHa(buildMediaSnapshot);
    expect(snap.amp.on).toBe(true);
    expect(snap.queue?.track?.title).toBe("Hotel California");
    expect(snap.tv.state).toBe("off");
  });
});
