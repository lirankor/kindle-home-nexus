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
import { applyMediaOptimistic, applyQueueSkip } from "@/lib/media-ui";
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
