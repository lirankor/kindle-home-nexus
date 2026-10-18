import { describe, expect, it } from "vitest";
import type { HaState } from "./home.server";
import { AMP } from "./media";
import { nodeCalls, nodeView } from "./media-nodes.server";
import type { MediaNode } from "./panel-config";

const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState =>
  ({ entity_id, state, attributes }) as HaState;
const amp: MediaNode = {
  id: "amp",
  type: "receiver",
  name: "Yamaha R-N500",
  power_device: "media_player.r_n500",
  plug: "switch.media_plug",
  stream_output: "select.r_n500_stream_output",
};
const tv: MediaNode = {
  id: "tv",
  type: "tv",
  name: "Sony TV",
  entity: "media_player.tv",
  movie_on: "script.movie_mode",
  movie_off: "script.movie_mode_off",
  movie_active: "input_boolean.movie",
};
const states = (amp: HaState) =>
  new Map<string, HaState>(
    [
      amp,
      st("switch.media_plug", "on"),
      st("select.r_n500_stream_output", "dlna", { options: ["dlna", "airplay"] }),
      st("media_player.tv", "on", { source: "HDMI 1", source_list: ["HDMI 1", "Netflix"] }),
      st("input_boolean.movie", "on"),
      st("number.vol", "-30", { unit_of_measurement: "dB", min: -80, max: -20, step: 0.5 }),
    ].map((s) => [s.entity_id, s]),
  );
const bridge = st("media_player.r_n500", "on", {
  source: "SERVER",
  source_list: ["SERVER", "NET RADIO", "CD"],
  volume_db: -44.5,
  power_on_step: "done",
});

describe("media nodes", () => {
  it("reads a receiver and a TV generically from their entities", () => {
    const m = states(bridge);
    expect(nodeView(amp, m)).toMatchObject({
      on: true,
      source: "SERVER",
      sources: ["SERVER", "NET RADIO", "CD"],
      volumeDb: -44.5,
      stream: "dlna",
      streams: ["dlna", "airplay"],
      movie: false,
    });
    expect(nodeView(tv, m)).toMatchObject({
      on: true,
      source: "HDMI 1",
      sources: ["HDMI 1", "Netflix"],
      movie: true,
      movieActive: true,
    });
    // the plug off: the receiver is off, whatever its entity last said
    m.set("switch.media_plug", st("switch.media_plug", "off"));
    expect(nodeView(amp, m)).toMatchObject({ on: false, state: "off", available: true });
  });
  it("inputs: the entity's own list and order, rows rename or hide entries (task 015)", () => {
    const m = states(bridge);
    const rx: MediaNode = {
      ...amp,
      inputs: [
        { input: "CD", name: "Bluetooth & TV", name_he: "בלוטות׳ וטלוויזיה" },
        { input: "NET RADIO", hidden: true },
        { input: "LINE9", name: "Not listed by the receiver" },
      ],
    };
    const v = nodeView(rx, m);
    expect(v.sources).toEqual(["SERVER", "CD"]);
    expect(v.inputNames).toEqual({
      CD: { name: "Bluetooth & TV", name_he: "בלוטות׳ וטלוויזיה" },
      LINE9: { name: "Not listed by the receiver" },
    });
    // a TV takes rows the same way; without rows every input shows with the device's title
    expect(nodeView({ ...tv, inputs: [{ input: "Netflix", hidden: true }] }, m).sources).toEqual([
      "HDMI 1",
    ]);
    expect(nodeView(tv, m)).toMatchObject({ sources: ["HDMI 1", "Netflix"], inputNames: {} });
    // selecting sends the device's own title
    expect(nodeCalls(rx, { type: "node", id: "amp", op: "source", source: "CD" }, m)).toEqual([
      {
        domain: "media_player",
        service: "select_source",
        data: { entity_id: "media_player.r_n500", source: "CD" },
      },
    ]);
  });
  it("power on: plug first when it is off, then turn_on in the background; off waits", () => {
    const m = states(bridge);
    m.set("switch.media_plug", st("switch.media_plug", "off"));
    expect(nodeCalls(amp, { type: "node", id: "amp", op: "power", on: true }, m)).toEqual([
      { domain: "switch", service: "turn_on", data: { entity_id: "switch.media_plug" } },
      {
        domain: "media_player",
        service: "turn_on",
        data: { entity_id: "media_player.r_n500" },
        background: true,
      },
    ]);
    expect(nodeCalls(amp, { type: "node", id: "amp", op: "power", on: false }, m)).toEqual([
      { domain: "media_player", service: "turn_off", data: { entity_id: "media_player.r_n500" } },
    ]);
  });
  it("volume: dB steps on yamaha_netbridge, a dB number within its range, else volume_up/down", () => {
    expect(
      nodeCalls(amp, { type: "node", id: "amp", op: "volume", delta: 1 }, states(bridge)),
    ).toEqual([
      {
        domain: "yamaha_netbridge",
        service: "step_volume_db",
        data: { entity_id: "media_player.r_n500", delta_db: AMP.volumeStepDb },
      },
    ]);
    const plain = st("media_player.r_n500", "on", {});
    const withNumber = { ...amp, volume: "number.vol" };
    expect(
      nodeCalls(withNumber, { type: "node", id: "amp", op: "volume", delta: 1 }, states(plain)),
    ).toEqual([
      { domain: "number", service: "set_value", data: { entity_id: "number.vol", value: -28 } },
    ]);
    expect(
      nodeCalls(tv, { type: "node", id: "tv", op: "volume", delta: -1 }, states(plain)),
    ).toEqual([
      { domain: "media_player", service: "volume_down", data: { entity_id: "media_player.tv" } },
    ]);
  });
  it("source, stream output and movie mode", () => {
    const m = states(bridge);
    expect(
      nodeCalls(tv, { type: "node", id: "tv", op: "source", source: "Netflix" }, m)[0],
    ).toEqual({
      domain: "media_player",
      service: "select_source",
      data: { entity_id: "media_player.tv", source: "Netflix" },
    });
    expect(
      nodeCalls(amp, { type: "node", id: "amp", op: "stream", option: "airplay" }, m)[0]?.data,
    ).toEqual({ entity_id: "select.r_n500_stream_output", option: "airplay" });
    expect(nodeCalls(tv, { type: "node", id: "tv", op: "movie", on: false }, m)[0]?.data).toEqual({
      entity_id: "script.movie_mode_off",
    });
    expect(() =>
      nodeCalls(tv, { type: "node", id: "tv", op: "stream", option: "dlna" }, m),
    ).toThrow();
  });

  it("NET RADIO stations from the bridge's station select (task 016)", () => {
    const withRadio: MediaNode = { ...amp, net_radio: "select.r_n500_net_radio_station" };
    const sel = st("select.r_n500_net_radio_station", "Local · WDR 5", {
      options: ["Local · WDR 5", "Israel · Galgalatz"],
      stations: [
        { id: "wdr-5", name: "WDR 5", group: "Local", fm_mhz: 88.8 },
        { id: "galgalatz", name: "Galgalatz", group: "Israel", fm_mhz: null },
      ],
    });
    const radioAmp = st("media_player.r_n500", "on", {
      source: "NET RADIO",
      source_list: ["SERVER", "NET RADIO"],
      media_title: "Some Song",
      media_artist: "WDR 5",
    });
    const s = states(radioAmp);
    s.set(sel.entity_id, sel);
    const v = nodeView(withRadio, s);
    expect(v.stations).toEqual([
      { option: "Local · WDR 5", name: "WDR 5", group: "Local", fm: 88.8 },
      { option: "Israel · Galgalatz", name: "Galgalatz", group: "Israel", fm: null },
    ]);
    expect(v.station).toBe("Local · WDR 5");
    expect([v.nowArtist, v.nowTitle]).toEqual(["WDR 5", "Some Song"]);
    expect(nodeView(amp, s).stations).toBeUndefined(); // no select configured: nothing changes
    expect(
      nodeCalls(
        withRadio,
        { type: "node", id: "amp", op: "station", option: "Israel · Galgalatz" },
        s,
      ),
    ).toEqual([
      {
        domain: "select",
        service: "select_option",
        data: { entity_id: "select.r_n500_net_radio_station", option: "Israel · Galgalatz" },
        background: true,
      },
    ]);
    expect(() =>
      nodeCalls(amp, { type: "node", id: "amp", op: "station", option: "x" }, s),
    ).toThrow();
  });
});
