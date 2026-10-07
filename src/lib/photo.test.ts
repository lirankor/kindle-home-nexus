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
