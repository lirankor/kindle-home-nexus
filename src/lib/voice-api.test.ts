// Pure matching helpers of the voice bridge (src/lib/voice-match.ts, used by src/routes/api/voice.$.ts); no network.
import { describe, expect, it } from "vitest";
import {
  matchScore,
  matchStation,
  mixFor,
  norm,
  pickBest,
  queueSummary,
  stripFiller,
} from "./voice-match";
import type { Candidate } from "./voice-match";
import { demoQueue } from "./media";

describe("voice bridge matching", () => {
  it("normalises articles, case and punctuation", () => {
    expect(norm("The Eagles!")).toBe("eagles");
    expect(norm("  Kan  Bet ")).toBe("kan bet");
    expect(norm("Café Del Mar")).toBe("cafe del mar");
  });
  it("scores exact > prefix > contained > words", () => {
    expect(matchScore("Eagles", "the eagles")).toBe(100);
    expect(matchScore("Hotel California", "hotel")).toBe(80);
    expect(matchScore("Eagles", "eagles hotel california")).toBe(70);
    expect(matchScore("Best of Queen", "queen")).toBe(60);
    expect(matchScore("Queen Greatest Hits", "hits queen")).toBe(50);
    expect(matchScore("Kol Chai", "radio darom")).toBe(0);
  });
  it("picks the artist over an equally scored album, shorter names on ties, nothing under the floor", () => {
    const c: Candidate[] = [
      { kind: "album", id: "a", title: "Eagles", score: 100 },
      { kind: "artist", id: "b", title: "Eagles", score: 100 },
      { kind: "track", id: "c", title: "Eagles", score: 100 },
    ];
    expect(pickBest(c)?.id).toBe("b");
    expect(
      pickBest([
        { kind: "track", id: "x", title: "Hotel California (Live)", score: 80 },
        { kind: "track", id: "y", title: "Hotel California", score: 80 },
      ])?.id,
    ).toBe("y");
    expect(pickBest([{ kind: "track", id: "z", title: "Nope", score: 10 }])).toBeNull();
  });
  it("maps spoken mix names", () => {
    expect(mixFor("80s")).toBe("s80");
    expect(mixFor("the eighties")).toBe("s80");
    expect(mixFor("party mix")).toBe("party");
    expect(mixFor("jazz")).toBe("jazz");
    expect(mixFor("eagles")).toBeNull();
  });
  it("strips spoken filler from wildcard queries", () => {
    expect(stripFiller("something by the beatles")).toBe("the beatles");
    expect(stripFiller("some eagles")).toBe("eagles");
    expect(stripFiller("את האלבום hotel california")).toBe("hotel california");
    expect(stripFiller("eagles")).toBe("eagles");
  });
  it("finds catalog stations fuzzily", () => {
    expect(matchStation("galgalatz")).toMatchObject({ list: "israel", name: "Galgalatz" });
    expect(matchStation("radio Kan Bet")).toMatchObject({ name: "Kan Bet" });
    expect(matchStation("wdr 5")).toMatchObject({ list: "local", name: "WDR 5" });
    expect(matchStation("88.8")).toMatchObject({ name: "WDR 5" });
    expect(matchStation("bbc")).toMatchObject({ name: "BBC World Service" });
    expect(matchStation("רדיו גלגלצ")).toMatchObject({ name: "Galgalatz" });
    expect(matchStation("כאן ב")).toMatchObject({ name: "Kan Bet" });
    expect(matchStation("xyzzy")).toBeNull();
  });
  it("summarises a queue with at most three upcoming tracks", () => {
    const s = queueSummary(demoQueue("Demo"));
    expect(s?.title).toBe("Demo");
    expect(s?.next.length).toBeLessThanOrEqual(3);
  });
  it("carries the album / art item ids on the current and next tracks", () => {
    const s = queueSummary(demoQueue("Demo"));
    expect(s?.track).toMatchObject({
      albumId: expect.stringMatching(/^demo-album-/),
      artItemId: null,
    });
    for (const t of s?.next ?? [])
      expect(t).toMatchObject({ albumId: expect.stringMatching(/^demo-album-/) });
  });
});
