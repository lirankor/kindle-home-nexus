import { describe, expect, it } from "vitest";

import { albumDateLabel } from "@/lib/media-ui";

describe("albumDateLabel", () => {
  it("shows the full date when the tags know the day", () => {
    expect(albumDateLabel({ year: 1973, releaseDate: "1973-04-17" }, "en")).toBe("17 Apr 1973");
    expect(albumDateLabel({ year: 1973, releaseDate: "1973-04-17" }, "he")).toMatch(/1973/);
  });
  it("falls back to the year for 1 January placeholders and year-only tags", () => {
    expect(albumDateLabel({ year: 1976, releaseDate: "1976-01-01" }, "en")).toBe("1976");
    expect(albumDateLabel({ year: 1992, releaseDate: null }, "en")).toBe("1992");
    expect(albumDateLabel({ year: null, releaseDate: "2007-01-01" }, "en")).toBe("2007");
    expect(albumDateLabel({ year: null, releaseDate: null }, "en")).toBeNull();
  });
});

import { demoMediaSnapshot, demoTracks } from "@/lib/media";
import {
  ampElsewhereHint,
  ampPowerSlot,
  applyMediaOptimistic,
  applyQueueSkip,
  isNetRadioNode,
} from "@/lib/media-ui";
import type { QueueProgress } from "@/lib/media";

const queueAt = (index: number, positionMs = 0): QueueProgress => {
  const tracks = demoTracks().slice(0, 4);
  const track = tracks[index]!;
  return {
    title: "Mix",
    index,
    count: 4,
    track,
    positionMs,
    durationMs: track.durationMs,
    status: "playing",
    prevTrack: tracks[index - 1] ?? null,
    nextTracks: tracks.slice(index + 1, index + 4),
  };
};

describe("applyQueueSkip", () => {
  const tracks = demoTracks().slice(0, 4);
  it("next moves onto the first upcoming track and shifts the neighbours", () => {
    const q = applyQueueSkip(queueAt(1, 30000), "next");
    expect(q.index).toBe(2);
    expect(q.track?.id).toBe(tracks[2]!.id);
    expect(q.positionMs).toBe(0);
    expect(q.durationMs).toBe(tracks[2]!.durationMs);
    expect(q.prevTrack?.id).toBe(tracks[1]!.id);
    expect(q.nextTracks?.map((t) => t.id)).toEqual([tracks[3]!.id]);
  });
  it("two quick nexts still know the track; a third does not and keeps track null", () => {
    const q2 = applyQueueSkip(applyQueueSkip(queueAt(0), "next"), "next");
    expect(q2.index).toBe(2);
    expect(q2.track?.id).toBe(tracks[2]!.id);
    const q3 = applyQueueSkip(q2, "next");
    expect(q3.index).toBe(3);
    expect(q3.track?.id).toBe(tracks[3]!.id);
    const q4 = applyQueueSkip({ ...q3, nextTracks: [], count: 6 }, "next");
    expect(q4.index).toBe(4);
    expect(q4.track).toBeNull();
  });
  it("next past the last track ends the queue", () => {
    const q = applyQueueSkip(queueAt(3), "next");
    expect(q.status).toBe("ended");
    expect(q.index).toBe(3);
  });
  it("prev restarts the track after 5 s, otherwise goes back one", () => {
    const restart = applyQueueSkip(queueAt(2, 9000), "prev");
    expect(restart.index).toBe(2);
    expect(restart.positionMs).toBe(0);
    const back = applyQueueSkip(queueAt(2, 2000), "prev");
    expect(back.index).toBe(1);
    expect(back.track?.id).toBe(tracks[1]!.id);
    expect(back.prevTrack).toBeNull();
    expect(back.nextTracks?.map((t) => t.id)).toEqual([tracks[2]!.id, tracks[3]!.id]);
    expect(applyQueueSkip(queueAt(0, 1000), "prev").index).toBe(0);
  });
});

describe("applyMediaOptimistic queue skips", () => {
  it("next rewrites the now-playing lines from the upcoming track", () => {
    const s = demoMediaSnapshot();
    s.amp.on = true;
    s.amp.source = "SERVER";
    s.nowPlaying = { ...s.nowPlaying, kind: "music", title: "Old", artist: "A", album: "B" };
    s.queue = queueAt(1);
    const after = applyMediaOptimistic(s, { type: "queue", op: "next" });
    const third = demoTracks()[2]!;
    expect(after.nowPlaying.title).toBe(third.title);
    expect(after.nowPlaying.artist).toBe(third.artist);
    expect(after.nowPlaying.album).toBe(third.album);
    expect(after.queue?.index).toBe(2);
    // Unknown neighbour: the lines stay until the server answers.
    const blind = applyMediaOptimistic(
      { ...s, queue: { ...queueAt(1), nextTracks: [] } },
      { type: "queue", op: "next" },
    );
    expect(blind.nowPlaying.title).toBe("Old");
    expect(blind.queue?.track).toBeNull();
  });
});

describe("ampPowerSlot (Media tab F3 / amp view F4)", () => {
  const snap = (on: boolean, available = true) => {
    const s = demoMediaSnapshot();
    s.amp = { ...s.amp, on, available, state: on ? "playing" : available ? "off" : "unavailable" };
    return s;
  };
  it("keeps the usual action while the amp is on or before the first snapshot", () => {
    expect(ampPowerSlot(snap(true), false)).toBe("open");
    expect(ampPowerSlot(snap(true), true)).toBe("open");
    expect(ampPowerSlot(null, false)).toBe("open");
  });
  it("offers Power on while the amp is off (plug on + standby) or unknown, pressed while the routine runs", () => {
    expect(ampPowerSlot(snap(false), false)).toBe("powerOn");
    expect(ampPowerSlot(snap(false, false), false)).toBe("powerOn");
    expect(ampPowerSlot(snap(false), true)).toBe("powering");
  });
});

describe("bus task 025: the amp's own input on the MA music screen", () => {
  const ha = (source: string) => {
    const s = demoMediaSnapshot();
    s.amp.source = source;
    s.output = {
      entity: "media_player.ma_amp_airplay",
      name: "R-N500 AirPlay",
      valid: true,
      outputs: [],
      keys: ["none", "none", "none", "none"],
    };
    return s;
  };
  it("names the amp's input and the Media key of the amp node (read from media.keys)", () => {
    expect(ampElsewhereHint(ha("NET RADIO"), "he")).toBe(
      "המגבר על NET RADIO · מגבר ימאהה ← F2 במדיה",
    );
    expect(ampElsewhereHint(ha("TUNER"), "en")).toBe("Amp on TUNER · Amplifier → F2 on Media");
    const s = ha("NET RADIO");
    s.keys = ["music", "none", "none", "amp"];
    expect(ampElsewhereHint(s, "en")).toBe("Amp on NET RADIO · Amplifier → F4 on Media");
    s.keys = ["music", "none", "none", "none"];
    expect(ampElsewhereHint(s, "en")).toBe("Amp on NET RADIO · open it on the Media tab");
  });
  it("says nothing on Music Assistant's path, with the amp off, or without an output (app backend)", () => {
    expect(ampElsewhereHint(ha("SERVER"), "he")).toBeNull();
    const off = ha("NET RADIO");
    off.amp.on = false;
    expect(ampElsewhereHint(off, "he")).toBeNull();
    const app = demoMediaSnapshot();
    expect(ampElsewhereHint(app, "he")).toBeNull();
  });
  it("a receiver with the bridge's station select is the dial's node", () => {
    expect(isNetRadioNode({ type: "receiver", stations: [] })).toBe(true);
    expect(isNetRadioNode({ type: "receiver" })).toBe(false);
    expect(isNetRadioNode({ type: "tv", stations: [] })).toBe(false);
  });
});
