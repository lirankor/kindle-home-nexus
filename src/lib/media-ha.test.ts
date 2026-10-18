import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaState } from "./home.server";
import { AMP, RADIO_LISTS, catalogLogoHosts, findStation, rememberMaStation } from "./media";
import type { MusicTrack } from "./media";
import {
  movingView,
  MOVE_GIVE_UP_MS,
  musicOutputFrom,
  nowLineOf,
  outputFields,
  panelSource,
  performMediaActionHa,
  playSelectionHa,
  positionOf,
  powerOnFromHa,
  powerOnView,
  POWER_ON_GIVE_UP_MS,
  POWER_ON_FINAL_MS,
  type PowerAttempt,
  projectStates,
  queueFromHa,
  readMediaSnapshotHa,
  stationByName,
  streamOptionFor,
  withRadio,
  maStationId,
  radioTrackOf,
} from "./media-ha.server";
import type { HaMusicState } from "./media-ha.server";
import { buildMediaSnapshot } from "./media.server";

/** The owner's receiver (yamaha_netbridge), as HA's music_state reports it for the house default output. */
const BRIDGE = "media_player.r_n500";
const jf = (id: string) => id.padStart(32, "0"); // Jellyfin-style 32-hex ids
const track = (title: string, id: string) => ({
  title,
  id: jf(id === "t1" ? "1" : "2"),
  uri: `jellyfin://track/${id}`,
  albumId: jf(id === "t1" ? "a1" : "a2"),
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
  outputPlayer: "media_player.ma_amp_dlna",
  powerDevice: BRIDGE,
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
    expect(q.track?.artItemId).toBe(jf("a1"));
    expect(q.nextTracks?.[0]?.title).toBe("New Kid in Town");
    expect(q.stall).toBeNull();
    expect(queueFromHa(music({ queue: null }))).toBeNull();
  });
  it("treats AirPlay as the music path", () => {
    expect(panelSource("AirPlay")).toBe("SERVER");
    expect(panelSource("CD")).toBe("CD");
    expect(panelSource("USB")).toBe("USB"); // any input of the receiver (task 015)
    expect(panelSource(null)).toBeNull();
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

describe("power-on shown from the key press (Q13)", () => {
  const off = (step = "idle", running = false, error: string | null = null) =>
    music({
      amp: { ...music().amp, on: false, state: "off", playing: false },
      powerOn: { running, step, error },
    });
  const fresh = (startedAt = 1_000): PowerAttempt => ({
    startedAt,
    error: null,
    final: null,
    finalAt: 0,
  });
  it("shows turning on while the bridge is still idle, the bridge's steps while it reports them", () => {
    let v = powerOnView(off(), 1_500, null, fresh());
    expect(v.status).toMatchObject({ running: true, step: "turn_on", elapsedMs: 500 });
    v = powerOnView(off("boot", true), 3_000, 1_000, v.attempt);
    expect(v.status).toMatchObject({ running: true, step: "wait" });
    expect(v.attempt).not.toBeNull();
  });
  it("ends with done once the amp reports on, and keeps the final status for both readers", () => {
    let v = powerOnView(off(), 2_000, null, fresh());
    v = powerOnView(music(), 4_000, null, v.attempt); // a 3 s wake: the bridge never showed a step
    expect(v.status).toMatchObject({ running: false, step: "done" });
    expect(powerOnView(music(), 5_000, null, v.attempt).status?.step).toBe("done");
    const later = powerOnView(music(), 4_000 + POWER_ON_FINAL_MS + 1, null, v.attempt);
    expect(later.attempt).toBeNull(); // back to the bridge's own status
    expect(later.status).toEqual(powerOnFromHa(music(), 4_000 + POWER_ON_FINAL_MS + 1, null));
  });
  it("fails on a refused turn_on, a bridge failure, or after the give-up time", () => {
    expect(powerOnView(off(), 2_000, null, { ...fresh(), error: "refused" }).status).toMatchObject({
      running: false,
      step: "failed",
      error: "refused",
    });
    // A "failed" left over from an earlier attempt does not end this one; one after the bridge ran does.
    expect(powerOnView(off("failed", false, "old"), 2_000, null, fresh()).status).toMatchObject({
      running: true,
      step: "turn_on",
    });
    const ran = powerOnView(off("boot", true), 2_000, null, fresh()).attempt;
    expect(powerOnView(off("failed", false, "no answer"), 3_000, null, ran).status).toMatchObject({
      step: "failed",
      error: "no answer",
    });
    expect(powerOnView(off(), 1_000 + POWER_ON_GIVE_UP_MS + 1, null, fresh()).status).toMatchObject(
      { step: "failed" },
    );
  });
  it("without an attempt it is the bridge's status as before", () => {
    expect(powerOnView(off(), 1, null, null)).toEqual({ status: null, attempt: null });
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
    expect(snap.nowPlaying.artItemId).toBe(jf("a1"));
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
  it("MA radio the bridge's list lacks gets the favourites' ma: id and the ICY line (bus task 024)", () => {
    const states = new Map([[BRIDGE, st(BRIDGE, "on", { source: "AirPlay" })]]);
    const s = music({
      amp: { ...music().amp, source: "AirPlay" },
      nowPlaying: {
        kind: "radio",
        title: "Kol Rega FM",
        artist: "עידן עמדי",
        album: null,
        station: "Kol Rega FM",
        artUrl: "https://cdn.example/logo.png",
        logo: "https://cdn.example/logo.png",
        track: "קול זיכרון ישן",
      },
      queue: null,
      radio: { station: "Kol Rega FM" },
    });
    const snap = withRadio(buildMediaSnapshot(projectStates(states, s), {}), s);
    expect(snap.nowPlaying.stationId).toBe("ma:kol-rega-fm");
    expect(snap.nowPlaying.stationId).toBe(maStationId("Kol Rega FM"));
    expect(snap.nowPlaying.station).toBe("Kol Rega FM");
    expect(snap.nowPlaying.title).toBe("קול זיכרון ישן");
    expect(snap.nowPlaying.artist).toBe("עידן עמדי");
    expect(snap.nowPlaying.artItemId).toBeNull();
  });
  it("radio ICY: a track equal to the station (or none) leaves the second line empty", () => {
    const base = { kind: "radio" as const, album: null, artUrl: null, station: "Galgalatz" };
    expect(radioTrackOf({ ...base, title: "Galgalatz", artist: null })).toEqual({
      title: null,
      artist: null,
    });
    expect(radioTrackOf({ ...base, title: "Galgalatz", artist: "x", track: null })).toEqual({
      title: null,
      artist: null,
    });
    expect(radioTrackOf({ ...base, title: "Galgalatz", artist: null, track: "Song" })).toEqual({
      title: "Song",
      artist: null,
    });
    // an older music_state without `track`: the title when it differs from the station
    expect(radioTrackOf({ ...base, title: "Song", artist: "A" })).toEqual({
      title: "Song",
      artist: "A",
    });
  });
  it("an MA station is served by its ma: id once remembered (the /media/img path)", () => {
    expect(findStation("ma:kol-rega-fm-2")).toBeUndefined();
    rememberMaStation("ma:kol-rega-fm-2", "Kol Rega FM 2", "https://logos.example/k.png");
    expect(findStation("ma:kol-rega-fm-2")?.logo).toBe("https://logos.example/k.png");
    expect(catalogLogoHosts()).toContain("logos.example");
    rememberMaStation("ma:bad", "Bad", "javascript:alert(1)");
    expect(findStation("ma:bad")?.logo).toBeNull();
    rememberMaStation("plain-id", "Not MA", "https://x.example/a.png");
    expect(findStation("plain-id")).toBeUndefined();
  });
  it("the receiver playing its own input (bridge 0.2.0: state on + foreign_state) is playing (Q18)", () => {
    const amp = { ...music().amp, source: "NET RADIO", playing: false };
    const s = music({ amp, queue: null });
    const at = (foreign: string, state = "on") =>
      buildMediaSnapshot(
        projectStates(
          new Map([
            [
              BRIDGE,
              { ...st(BRIDGE, state), attributes: { source: "NET RADIO", foreign_state: foreign } },
            ],
          ]),
          s,
        ),
        {},
      );
    expect(at("playing").amp.state).toBe("playing");
    expect(at("playing").amp.playing).toBe(true);
    expect(at("stopped").amp.state).toBe("on");
    expect(at("stopped").amp.playing).toBe(false);
    expect(at("playing", "off").amp.on).toBe(false); // standby wins over a stale foreign_state
  });
  it("an amp in standby is off", () => {
    const states = new Map([[BRIDGE, st(BRIDGE, "off")]]);
    const s = music({ amp: { ...music().amp, on: false, state: "off" }, queue: null });
    const snap = buildMediaSnapshot(projectStates(states, s), {});
    expect(snap.amp.on).toBe(false);
    expect(snap.nowPlaying.kind).toBe("none");
  });
});

describe("the panel's music output (bus task 014)", () => {
  const amp = {
    id: "amp",
    type: "receiver" as const,
    name: "Yamaha R-N500",
    power_device: BRIDGE,
    stream_output: "select.r_n500_stream_output",
    players: ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
  };
  it("an output among a receiver's players brings that receiver along", () => {
    const o = musicOutputFrom("media_player.ma_amp_airplay", [amp]);
    expect(o).toEqual({
      player: "media_player.ma_amp_airplay",
      powerDevice: BRIDGE,
      streamOutput: "select.r_n500_stream_output",
      players: ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
    });
    expect(outputFields(o)).toEqual({
      player: "media_player.ma_amp_airplay",
      power_device: BRIDGE,
      stream_output: "select.r_n500_stream_output",
    });
  });
  it("any other MA player or group: no receiver, no wake step", () => {
    const o = musicOutputFrom("media_player.ma_kitchen_group", [amp]);
    expect(o?.powerDevice).toBeNull();
    expect(outputFields(o)).toEqual({
      player: "media_player.ma_kitchen_group",
      power_device: "",
      stream_output: "",
    });
    expect(musicOutputFrom(null, [amp])).toBeNull();
    expect(outputFields(null)).toEqual({}); // none chosen: HA's house default
  });
  it("the stream select option is the one named in the player's entity id", () => {
    expect(streamOptionFor("media_player.ma_amp_airplay", ["dlna", "airplay"])).toBe("airplay");
    expect(streamOptionFor("media_player.ma_amp_dlna", ["dlna", "airplay"])).toBe("dlna");
    expect(streamOptionFor("media_player.ma_kitchen", ["dlna", "airplay"])).toBeNull();
  });
  it("an output without a receiver shows Music Assistant's screens (SERVER) and reads the player itself", () => {
    const k = "media_player.ma_kitchen";
    const s = music({ player: k, outputPlayer: k, powerDevice: null, output: null });
    const states = new Map([[k, st(k, "playing", { volume_level: 0.3 })]]);
    const snap = buildMediaSnapshot(projectStates(states, s, musicOutputFrom(k, [amp])), {
      queue: queueFromHa(s),
    });
    expect(snap.amp.on).toBe(true);
    expect(snap.amp.source).toBe("SERVER");
    expect(snap.nowPlaying.title).toBe("Hotel California");
  });
});

describe("the screen follows the chosen output strictly (bus task 021)", () => {
  const amp = {
    id: "amp",
    type: "receiver" as const,
    name: "Yamaha R-N500",
    power_device: BRIDGE,
    stream_output: "select.r_n500_stream_output",
    players: ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
  };
  it("DLNA chosen and idle while the amp's AirPlay player plays: not playing", () => {
    const dlna = "media_player.ma_amp_dlna";
    const s = music({ player: dlna, outputPlayer: dlna, powerDevice: BRIDGE, output: "dlna" });
    const states = new Map([
      [BRIDGE, st(BRIDGE, "on", { source: "AirPlay", volume_db: -47 })],
      [dlna, st(dlna, "idle")],
      ["media_player.ma_amp_airplay", st("media_player.ma_amp_airplay", "playing")],
    ]);
    const projected = projectStates(states, s, musicOutputFrom(dlna, [amp]));
    expect(projected.get(AMP.player)?.state).toBe("on");
    expect(projected.get(AMP.dlna)?.state).toBe("idle");
    // the AirPlay player chosen: playing
    const a = "media_player.ma_amp_airplay";
    const sa = music({ player: a, outputPlayer: a, powerDevice: BRIDGE, output: "dlna" });
    expect(projectStates(states, sa, musicOutputFrom(a, [amp])).get(AMP.player)?.state).toBe(
      "playing",
    );
  });
  it("art of an MA library track is an ma: token for the image route", () => {
    const s = music();
    s.queue!.track = {
      ...s.queue!.track!,
      id: "8969",
      albumId: "1963",
      artUrl: "http://192.168.1.15:8095/imageproxy/b018?size=0",
    };
    expect(queueFromHa(s)?.track?.artItemId).toMatch(/^ma:/);
  });
  it("now line and the move's life: arrives when the target plays, fails after the give-up time", () => {
    expect(
      nowLineOf(st("x", "playing", { media_title: "Holiday", media_artist: "Scorpions" })),
    ).toBe("Holiday · Scorpions");
    expect(nowLineOf(st("x", "idle"))).toBeNull();
    const m = { entity: "media_player.ma_amp_dlna", name: "R-N500 DLNA", startedAt: 1000 };
    const row = (state: string) => [{ entity_id: m.entity, name: m.name, state }];
    expect(movingView(m, row("idle"), 2000)).toEqual(m);
    expect(movingView(m, row("playing"), 2000)).toBeNull();
    const failed = movingView(m, row("idle"), 1000 + MOVE_GIVE_UP_MS + 1);
    expect(failed?.failed).toBe("did not start playing");
    expect(movingView(failed, row("idle"), 1000 + MOVE_GIVE_UP_MS + 60_000)).toBeNull();
  });
});

describe("HA calls", () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let bridgeForeign: string | null = null;
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
        if (path === `/api/states/${BRIDGE}`)
          payload = {
            entity_id: BRIDGE,
            state: "on",
            attributes: { source: "NET RADIO", foreign_state: bridgeForeign },
          };
        else if (path === "/api/states")
          payload = [
            { entity_id: BRIDGE, state: "on", attributes: { source: "SERVER", volume_db: -40 } },
            { entity_id: "media_player.ma_amp_dlna", state: "playing", attributes: {} },
            { entity_id: AMP.tv, state: "off", attributes: {} },
          ];
        else if (path.startsWith("/api/services/script/music_state"))
          payload = { changed_states: [], service_response: music() };
        else if (path.startsWith("/api/services/script/play_music"))
          payload = {
            changed_states: [],
            service_response:
              body["query"] === "s80"
                ? { ok: false, error: "nothing found for 80s" }
                : {
                    ok: true,
                    status: "playing",
                    chosen: { kind: "mix", mt: "playlist", title: "Daily mix" },
                  },
          };
        else if (path.startsWith("/api/services/script/music_play_items"))
          payload = {
            changed_states: [],
            service_response: { ok: true, status: "playing", count: 2 },
          };
        else if (path.startsWith("/api/services/script/music_control"))
          payload = { changed_states: [], service_response: { ok: true } };
        else if (path === "/api/services/kindle_panel/play_index") payload = [];
        else if (path.startsWith("/api/services/kindle_panel/get_queue"))
          return new Response("{}", { status: 400 });
        else if (path.startsWith("/api/services/script/play_radio"))
          payload = { changed_states: [], service_response: { ok: true, status: "tuned" } };
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plays a mix as the nightly MA playlist through script.play_music (bus task 018)", async () => {
    const tracksFor = vi.fn(async () => ({ title: "x", tracks: [] as MusicTrack[] }));
    const q = await playSelectionHa({ kind: "mix", id: "daily" }, tracksFor);
    const call = calls.find((c) => c.path.startsWith("/api/services/script/play_music"))!;
    expect(call.body).toMatchObject({ query: "daily", kind: "mix", fallback: false });
    expect(q?.title).toBe("Daily mix");
    expect(tracksFor).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.startsWith("/api/services/script/music_play_items"))).toBe(
      false,
    );
  });
  it("names the list after the mix when music_state reports one, not after the player", async () => {
    const { queueListFrom } = await import("./media-ha.server");
    const base = music();
    const s = { ...base, queue: { ...base.queue!, title: "Daily mix", kind: "mix" as const } };
    const full = {
      queue_id: "q",
      name: "R-N500 DLNA",
      total: 1,
      current_index: 0,
      items: [
        {
          index: 0,
          id: "t0",
          title: "Song",
          artist: "A",
          album: null,
          album_id: null,
          image: null,
          duration: 1,
        },
      ],
    };
    expect(queueListFrom(s, full, null)?.title).toBe("Daily mix");
    expect(queueListFrom(base, full, null)?.title).toBe("R-N500 DLNA");
  });
  it("hands the panel's chosen tracks to HA in order (a mix MA has no playlist for)", async () => {
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
  it("the radio stop key stops the receiver's own NET RADIO on the bridge, MA's radio through MA (Q18)", async () => {
    bridgeForeign = "playing";
    await performMediaActionHa({ type: "radio.playback", op: "stop" }, vi.fn());
    expect(calls.at(-1)?.path).toBe("/api/services/media_player/media_stop");
    expect(calls.at(-1)?.body).toEqual({ entity_id: BRIDGE });
    bridgeForeign = "stopped";
    await performMediaActionHa({ type: "radio.playback", op: "stop" }, vi.fn());
    expect(calls.at(-1)?.path).toContain("/api/services/script/music_control");
    expect(calls.at(-1)?.body).toEqual({ op: "stop" });
    bridgeForeign = null;
  });
  it("jumps with kindle_panel.play_index on the active MA player", async () => {
    await performMediaActionHa({ type: "queue.jump", index: 12 }, vi.fn());
    const call = calls.find((c) => c.path === "/api/services/kindle_panel/play_index")!;
    expect(call.body).toEqual({ entity_id: "media_player.ma_amp_dlna", index: 12 });
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

describe("full playlist (kindle_panel) with fallback to the list the panel sent", () => {
  const sent = {
    title: "80s",
    // music() reports index 2 of 40, title "Hotel California"
    tracks: Array.from(
      { length: 40 },
      (_, i) => ({ id: `s${i}`, title: i === 2 ? "Hotel California" : `Song ${i}` }) as MusicTrack,
    ),
  };
  it("uses kindle_panel's whole queue when it answers", async () => {
    const { queueListFrom } = await import("./media-ha.server");
    const full = {
      queue_id: "q",
      name: "Eagles",
      total: 40,
      current_index: 2,
      items: Array.from({ length: 40 }, (_, i) => ({
        index: i,
        id: `t${i}`,
        title: `Song ${i}`,
        artist: "Eagles",
        album: null,
        album_id: `alb${i}`,
        image: `http://192.168.1.15:8095/imageproxy?path=${i}`,
        duration: 200,
      })),
    };
    const l = queueListFrom(music(), full, sent)!;
    expect(l.tracks).toHaveLength(40);
    expect(l.index).toBe(2);
    expect(l.tracks[2]?.artItemId).toMatch(/^ma:/); // no Jellyfin ids in this fake: MA image token
  });
  it("falls back to the list the panel sent, positioned on MA's current track", async () => {
    const { queueListFrom } = await import("./media-ha.server");
    const l = queueListFrom(music(), null, sent)!;
    expect(l.title).toBe("80s");
    expect(l.index).toBe(2);
    expect(l.tracks).toHaveLength(40);
    expect(l.tracks[2]?.id).toBe("s2");
  });
  it("shows MA's current + next window for music started elsewhere", async () => {
    const { queueListFrom } = await import("./media-ha.server");
    const l = queueListFrom(music(), null, null)!;
    expect(l.tracks.map((t) => t.title)).toEqual(["Hotel California", "New Kid in Town"]);
  });
});

describe("art for items without a Jellyfin id", () => {
  it("prefers Jellyfin ids, else an ma: token the image route accepts only for MA's LAN image proxy", async () => {
    const { artToken } = await import("./media-ha.server");
    const { maImageAllowed } = await import("./media.server");
    expect(artToken(["123", "c".repeat(32)], "http://x/imageproxy")).toBe("c".repeat(32));
    const t = artToken(["123"], "http://192.168.1.15:8095/imageproxy?path=abc")!;
    expect(t.startsWith("ma:")).toBe(true);
    const url = new URL(Buffer.from(t.slice(3), "base64url").toString("utf8"));
    expect(maImageAllowed(url)).toBe(true);
    expect(maImageAllowed(new URL("http://evil.example.com/imageproxy?path=x"))).toBe(false);
    expect(maImageAllowed(new URL("http://192.168.1.15:8095/api/other"))).toBe(false);
  });
});
