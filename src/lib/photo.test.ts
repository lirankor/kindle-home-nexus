import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropToScreen, isPortrait, pickAsset } from "./photo.server";

const asset = (id: string, w?: number, h?: number, orientation?: number | string) => ({
  id,
  exifInfo: w
    ? { exifImageWidth: w, exifImageHeight: h ?? 0, orientation: orientation ?? null }
    : null,
});

describe("screensaver photo", () => {
  it("detects portrait, respecting EXIF orientation 5 to 8", () => {
    expect(isPortrait(asset("a", 3000, 4000))).toBe(true);
    expect(isPortrait(asset("a", 4000, 3000))).toBe(false);
    expect(isPortrait(asset("a", 4000, 3000, 6))).toBe(true);
    expect(isPortrait(asset("a", 4000, 3000, "8"))).toBe(true);
    expect(isPortrait(asset("a", 3000, 4000, 3))).toBe(true);
    expect(isPortrait({ id: "a" })).toBeNull();
  });

  it("weights portraits 3:1 and avoids the previous photo", () => {
    const items = [asset("p", 3, 4), asset("l", 4, 3)];
    let portrait = 0;
    for (let i = 0; i < 400; i++) if (pickAsset(items, null, () => i / 400)?.id === "p") portrait++;
    expect(portrait).toBe(300);
    expect(pickAsset(items, "p", () => 0)?.id).toBe("l");
    expect(pickAsset([asset("only")], "only", () => 0)?.id).toBe("only");
  });

  it("crops to exactly 600x800 grayscale", async () => {
    const wide = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await cropToScreen(wide)).metadata();
    expect([meta.width, meta.height]).toEqual([600, 800]);
  });
});

describe("e-ink photo marks", () => {
  it("stores marks once, and marked photos leave the random pool until it would be empty", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { addMark, loadMarks, markedIds } = await import("./photo.server");
    const file = join(await mkdtemp(join(tmpdir(), "marks-")), "marks.json");
    expect((await loadMarks(file)).marked).toEqual([]);
    expect(await addMark("a", file, new Date("2026-10-12T10:00:00Z"))).toBe(1);
    expect(await addMark("a", file)).toBe(1);
    expect(await addMark("b", file)).toBe(2);
    const marks = await loadMarks(file);
    expect(marks.marked[0]).toEqual({ id: "a", at: "2026-10-12T10:00:00.000Z" });

    const items = [asset("a", 3, 4), asset("b", 3, 4), asset("c", 4, 3)];
    for (let i = 0; i < 20; i++)
      expect(pickAsset(items, null, () => i / 20, markedIds(marks))?.id).toBe("c");
    // Everything marked: keep showing photos rather than nothing.
    const all = new Set(["a", "b", "c"]);
    expect(pickAsset(items, "c", () => 0, all)?.id).toBe("a");
  });

  it("F4 skips for good locally; keep and skip exclude each other; the kept count is what the footer shows", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { addMark, loadMarks, markedIds, skippedIds } = await import("./photo.server");
    const file = join(await mkdtemp(join(tmpdir(), "marks-")), "marks.json");
    expect(await addMark("a", file)).toBe(1);
    expect(await addMark("b", file, new Date(), "skip")).toBe(1);
    expect(await addMark("a", file, new Date(), "skip")).toBe(0); // a re-judged: now skipped, no longer kept
    const marks = await loadMarks(file);
    expect([...skippedIds(marks)].sort()).toEqual(["a", "b"]);
    const items = [asset("a", 3, 4), asset("b", 3, 4), asset("c", 4, 3)];
    for (let i = 0; i < 20; i++)
      expect(pickAsset(items, "c", () => i / 20, markedIds(marks), skippedIds(marks))?.id).toBe(
        "c",
      );
    expect(pickAsset(items, null, () => 0, new Set(), new Set(["a", "b", "c"]))).toBeUndefined();
  });

  it("reads a marks file from before skips existed", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadMarks } = await import("./photo.server");
    const file = join(await mkdtemp(join(tmpdir(), "marks-")), "marks.json");
    await writeFile(file, JSON.stringify({ marked: [{ id: "x", at: "2026-10-01T00:00:00Z" }] }));
    expect(await loadMarks(file)).toEqual({
      marked: [{ id: "x", at: "2026-10-01T00:00:00Z" }],
      skipped: [],
    });
  });
});

describe("MarkRouter (Q15: marks go to the store whose picker served the photo)", () => {
  it("routes by the serving picker, falls back to the configured source, forgets old ids", async () => {
    const { MarkRouter } = await import("./photo.server");
    const r = new MarkRouter(2);
    r.remember("h", "ha");
    r.remember("l", "local");
    expect(r.storeFor("h", false)).toBe("ha");
    expect(r.storeFor("l", true)).toBe("local"); // the fallback served it while HA sources are set
    expect(r.storeFor("unknown", true)).toBe("ha");
    expect(r.storeFor("unknown", false)).toBe("local");
    r.remember("x", "local"); // capacity 2: "h" is forgotten
    expect(r.storeFor("h", false)).toBe("local");
    r.remember(null, "ha");
  });
});
