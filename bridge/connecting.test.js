import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { composeConnecting } from "./connecting.js";

const gray = (w, h, v) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } })
    .grayscale()
    .toColourspace("b-w")
    .png({ palette: false })
    .toBuffer();

test("the connecting frame is the panel frame with the badge on top, 8-bit grayscale", async () => {
  const frame = await gray(600, 800, 255);
  const badge = await sharp({
    create: { width: 200, height: 60, channels: 4, background: "#000000" },
  })
    .png()
    .toBuffer();
  const { buf, etag } = await composeConnecting(frame, badge, {
    x: 200,
    y: 20,
    width: 200,
    height: 60,
  });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 800);
  assert.equal(meta.channels, 1);
  assert.equal(meta.depth, "uchar");
  assert.match(etag, /^[0-9a-f]{32}$/);
  const { data } = await sharp(buf).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[50 * 600 + 300], 0); // inside the badge
  assert.equal(data[200 * 600 + 300], 255); // the rest of the frame unchanged
  assert.equal(data[50 * 600 + 100], 255);
});

test("a badge box reaching past the frame is clipped", async () => {
  const frame = await gray(600, 800, 200);
  const badge = await sharp({ create: { width: 300, height: 60, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
  const { buf } = await composeConnecting(frame, badge, { x: 450, y: 780, width: 300, height: 60 });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 800);
});
