import { describe, expect, it } from "vitest";
import { RADIO_LISTS, demoMediaSnapshot, demoRadioLists } from "./media";
import type { RadioStationView } from "./media";
import {
  DIAL,
  dialPosition,
  dialSegments,
  estimateWidth,
  findStationPosition,
  planDialLabels,
  playingPosition,
  shortName,
  stationDetail,
  stationLabel,
  stationX,
  toggleFavouriteInLists,
  volumeDial,
  wrapIndex,
  DIAL_COMPACT,
  fractionX,
} from "./radio-dial";

const view = (s: (typeof RADIO_LISTS)[number]["stations"][number]): RadioStationView => ({
  ...s,
  ytunerId: null,
  favourite: false,
});

describe("radio dial helpers", () => {
  it("shortens names to about ten characters, at a word boundary when that keeps enough", () => {
    expect(shortName("1LIVE")).toBe("1LIVE");
    expect(shortName("Capital FM London")).toBe("Capital FM");
    expect(shortName("Deutschlandfunk Kultur")).toBe("Deutschlan…");
    expect(shortName("Your Classical Relax")).toBe("Your Class…");
    expect(shortName("Radio Paradise")).toBe("Radio Para…");
  });

  it("labels the local band with FM MHz and the others with names", () => {
    const first = RADIO_LISTS.find((l) => l.id === "local")!.stations[0]!;
    expect(stationLabel(first, "local")).toBe("88.8");
    expect(stationLabel({ name: "Deutschlandfunk Nova", fm: null }, "local")).toBe("Deutschlan…");
    expect(stationLabel(first, "english")).toBe("WDR 5");
    expect(stationDetail({ bitrate: 128, codec: "MP3" })).toBe("128k · MP3");
    expect(stationDetail({ bitrate: 0, codec: "" })).toBe("");
    expect(stationDetail({ bitrate: 56, codec: "" })).toBe("56k");
  });

  it("wraps indexes and finds a station in the user's band before favourites", () => {
    expect(wrapIndex(12, 12)).toBe(0);
    expect(wrapIndex(-1, 12)).toBe(11);
    expect(wrapIndex(0, 0)).toBe(-1);
    const lists = demoRadioLists().lists;
    const live = lists.find((l) => l.id === "local")!.stations[0]!;
    lists[0]!.stations = [live];
    expect(findStationPosition(lists, live.id, "local")).toEqual({ list: "local", index: 0 });
    expect(findStationPosition(lists, live.id, null)).toEqual({ list: "favourites", index: 0 });
    expect(findStationPosition(lists, live.id, "english")).toEqual({
      list: "favourites",
      index: 0,
    });
    expect(findStationPosition(lists, "nope", null)).toBeNull();
  });

  it("derives the dial position from the user's state, else from what plays", () => {
    const lists = demoRadioLists().lists;
    const s = demoMediaSnapshot();
    expect(dialPosition(null, lists, s)).toEqual({ list: "local", index: 0 });
    expect(dialPosition({ list: "english", indexByList: { english: 3 } }, lists, s)).toEqual({
      list: "english",
      index: 3,
    });
    // Out-of-range remembered index is clamped; unknown band falls back to the playing station.
    expect(dialPosition({ list: "israel", indexByList: { israel: 99 } }, lists, s).index).toBe(5);
    expect(dialPosition({ list: "music", indexByList: {} }, lists, s)).toEqual({
      list: "local",
      index: 0,
    });
    // Server cursor is used when the station id is unknown to the catalog.
    s.nowPlaying.stationId = null;
    s.radio = { list: "english", index: 2 };
    expect(playingPosition(lists, s, null)).toEqual({ list: "english", index: 2 });
    s.radio = { list: "music", index: 0 };
    expect(playingPosition(lists, s, null)).toBeNull();
  });

  it("always labels the current station and never overlaps labels on one side", () => {
    const english = RADIO_LISTS.find((l) => l.id === "english")!.stations.map(view);
    const texts = english.map((s) => stationLabel(s, "english"));
    for (const current of [0, 5, english.length - 1]) {
      const labels = planDialLabels(texts, current, [0, estimateWidth("Favourites", DIAL.namePx)]);
      const cur = labels.find((l) => l.index === current);
      expect(cur?.current).toBe(true);
      // Beside the needle, not under it; and no other label crosses the needle.
      expect(cur?.anchor).toBe(current === english.length - 1 ? "end" : "start");
      const nx = stationX(current, english.length);
      for (const l of labels) {
        if (l.current) continue;
        const w = estimateWidth(l.text, DIAL.labelPx);
        expect(l.x - w / 2 > nx + DIAL.needleW / 2 || l.x + w / 2 < nx - DIAL.needleW / 2).toBe(
          true,
        );
      }
      expect(labels.length).toBeGreaterThanOrEqual(5);
      for (const side of ["above", "below"] as const) {
        const spans = labels
          .filter((l) => l.side === side)
          .map((l) => {
            const w = estimateWidth(l.text, l.current ? DIAL.currentPx : DIAL.labelPx);
            const left = l.anchor === "middle" ? l.x - w / 2 : l.anchor === "start" ? l.x : l.x - w;
            return [left, left + w] as const;
          })
          .sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < spans.length; i++)
          expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![1]);
        for (const [a, b] of spans) {
          expect(a).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThanOrEqual(DIAL.width);
        }
      }
    }
    // Almost all twelve FM numbers fit (the band name takes the top-left), alternating sides.
    const local = RADIO_LISTS.find((l) => l.id === "local")!.stations.map(view);
    const fm = planDialLabels(
      local.map((s) => stationLabel(s, "local")),
      0,
      [0, estimateWidth("דיסלדורף", DIAL.namePx)],
    );
    expect(fm.length).toBeGreaterThanOrEqual(9);
    expect(fm.filter((l) => l.side === "above").length).toBeGreaterThan(3);
    expect(fm.filter((l) => l.side === "below").length).toBeGreaterThan(3);
    expect(planDialLabels([], 0, null)).toEqual([]);
  });

  it("spreads stations evenly and draws solid ends, dashes and a stop per station", () => {
    expect(stationX(0, 12)).toBe(DIAL.x0);
    expect(stationX(11, 12)).toBe(DIAL.x1);
    expect(stationX(0, 1)).toBe((DIAL.x0 + DIAL.x1) / 2);
    const segs = dialSegments([stationX(0, 3), stationX(1, 3), stationX(2, 3)]);
    expect(segs[0]).toEqual({ x: 0, w: DIAL.endBlock });
    expect(segs.at(-4)).toEqual({ x: DIAL.width - DIAL.endBlock, w: DIAL.endBlock });
    expect(segs.slice(-3).every((s) => s.w === DIAL.stop)).toBe(true);
    expect(segs.length).toBeGreaterThan(20);
  });

  it("toggles a station in the favourites band optimistically", () => {
    const result = demoRadioLists();
    const live = result.lists.find((l) => l.id === "local")!.stations[0]!;
    const added = toggleFavouriteInLists(result, live, true);
    expect(added.lists[0]!.stations.map((s) => s.id)).toEqual([live.id]);
    expect(added.lists[0]!.stations[0]!.favourite).toBe(true);
    expect(added.lists.find((l) => l.id === "local")!.stations[0]!.favourite).toBe(true);
    const removed = toggleFavouriteInLists(added, live, false);
    expect(removed.lists[0]!.stations).toEqual([]);
    expect(removed.lists.find((l) => l.id === "local")!.stations[0]!.favourite).toBe(false);
  });

  it("maps the volume to the bar with ticks below and the value beside the needle", () => {
    const v = volumeDial(-44.5);
    expect(v.stops).toHaveLength(6);
    expect(v.stops[0]).toBeCloseTo(fractionX(0.5 / 97), 5); // -80 sits just right of the -80.5 minimum
    expect(v.stops[5]).toBe(DIAL.x1);
    expect(v.labels.map((l) => l.text)).toEqual([
      "-80",
      "-60",
      "-40",
      "-20",
      "0",
      "+16.5",
      "-44.5",
    ]);
    expect(v.labels.slice(0, 6).every((l) => l.side === "below" && !l.current)).toBe(true);
    expect(v.needleX).toBeCloseTo(fractionX((-44.5 + 80.5) / 97), 5);
    expect(v.labels[6]).toMatchObject({ side: "above", anchor: "start", current: true });
    // Full volume: the value goes to the left of the needle.
    expect(volumeDial(16.5).labels[6]?.anchor).toBe("end");
    // Unknown volume: ticks only.
    const off = volumeDial(null, DIAL_COMPACT);
    expect(off.needleX).toBeNull();
    expect(off.labels).toHaveLength(6);
    expect(off.stops[5]).toBe(DIAL_COMPACT.x1);
  });
});
