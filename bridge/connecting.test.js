import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  BADGE,
  composeConnecting,
  connectingResponse,
  createConnectingStore,
} from "./connecting.js";

const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
// A 600x800 8-bit grey frame like the bridge serves: a horizontal gradient (any frame must work, not only white).
async function frame(seed = 0) {
  const raw = Buffer.alloc(600 * 800);
  for (let y = 0; y < 800; y++)
    for (let x = 0; x < 600; x++) raw[y * 600 + x] = (x + seed * 37 + (y >> 4)) & 0xff;
  const buf = await sharp(raw, { raw: { width: 600, height: 800, channels: 1 } })
    .toColourspace("b-w")
    .png({ palette: false })
    .toBuffer();
  return { buf, etag: md5(buf) };
}
const pixels = (buf) => sharp(buf).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });

test("composeConnecting: same size 8-bit grey PNG, only the centred badge square changes", async () => {
  const f = await frame();
  const out = await composeConnecting(f.buf);
  const a = await pixels(f.buf);
  const b = await pixels(out);
  assert.deepEqual([b.info.width, b.info.height, b.info.channels], [600, 800, 1]);
  const meta = await sharp(out).metadata();
  assert.equal(meta.depth, "uchar");
  assert.equal(meta.hasAlpha, false);
  let changed = 0;
  let x0 = 600,
    y0 = 800,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < 800; y++)
    for (let x = 0; x < 600; x++)
      if (a.data[y * 600 + x] !== b.data[y * 600 + x]) {
        changed++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  assert.ok(changed > 1000, `badge visible (${changed} px changed)`);
  const left = (600 - BADGE) / 2;
  const top = (800 - BADGE) / 2;
  assert.ok(
    x0 >= left && y0 >= top && x1 < left + BADGE && y1 < top + BADGE,
    "nothing outside the badge",
  );
  // black tile with a white mark in it
  const at = (x, y) => b.data[y * 600 + x];
  assert.equal(at(left + 30, top + 30), 0);
  assert.equal(at(300, top + 8 + 158), 255);
});

test("store: variant per frame ETag, cached, unknown or evicted frames give null", async () => {
  const store = createConnectingStore({ max: 2 });
  const f1 = await frame(1);
  const f2 = await frame(2);
  const f3 = await frame(3);
  assert.equal(store.variant(f1.etag), null);
  store.remember(f1);
  const p = store.variant(f1.etag);
  assert.equal(store.variant(f1.etag), p, "one composite per ETag");
  const v = await p;
  assert.equal(v.of, f1.etag);
  assert.equal(v.etag, md5(v.buf));
  assert.notEqual(v.etag, f1.etag);
  store.remember(f2);
  store.remember(f3);
  assert.equal(store.has(f1.etag), false);
  assert.equal(store.variant(f1.etag), null);
  assert.ok(store.variant(f3.etag));
});

test("connectingResponse: ?of= picks the frame, default the latest, 404 when unknown, ?etag= is an empty 200", async () => {
  const store = createConnectingStore();
  const old = await frame(4);
  const latest = await frame(5);
  store.remember(old);
  store.remember(latest);
  const q = (s) => new URLSearchParams(s);

  const r1 = await connectingResponse(store, latest, q("connecting=1"));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers["Content-Type"], "image/png");
  assert.equal(r1.headers["X-Frame-ETag"], latest.etag);
  assert.equal(r1.headers.ETag, md5(r1.body));
  assert.equal(r1.headers["Content-Length"], r1.body.length);

  const r2 = await connectingResponse(store, latest, q(`connecting=1&of=${old.etag}`));
  assert.equal(r2.headers["X-Frame-ETag"], old.etag, "the frame the client has, not the newest");
  assert.deepEqual(r2.body, await composeConnecting(old.buf));

  const r3 = await connectingResponse(store, latest, q("connecting=1&of=deadbeef"));
  assert.equal(r3.status, 404);

  const r4 = await connectingResponse(
    store,
    latest,
    q(`connecting=1&of=${old.etag}&etag=${r2.headers.ETag}`),
  );
  assert.equal(r4.status, 200);
  assert.equal(r4.headers["Content-Length"], 0);
  assert.equal(r4.headers["X-Unchanged"], "1");
  assert.equal(r4.body, "");

  assert.equal(
    (await connectingResponse(createConnectingStore(), null, q("connecting=1"))).status,
    404,
  );
});
