import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import puppeteer from "puppeteer";
import sharp from "sharp";

const env = (k, d) => process.env[k] ?? d;
const APP_URL = env("APP_URL", "http://app:3000/");
const PORT = Number(env("PORT", 8790));
const WIDTH = Number(env("WIDTH", 600));
const HEIGHT = Number(env("HEIGHT", 800));
const REFRESH_MS = Number(env("REFRESH_MS", 30000));
const KEY_SETTLE_MS = Number(env("KEY_SETTLE_MS", 200));
const PAGE_RELOAD_MS = Number(env("PAGE_RELOAD_MS", 0));

const KEYS = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  select: "Enter", enter: "Enter", ok: "Enter",
  escape: "Escape",
  prev: "PageUp", pageup: "PageUp", next: "PageDown", pagedown: "PageDown",
  // Kindle bottom row (Back, Keyboard, Menu, Home) = soft keys F1..F4, matching the app footer left to right.
  back: "F1", keyboard: "F2", menu: "F3", home: "F4",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page = null;
let latest = null; // { buf, etag }
let lastShotAt = null;
let starting = null;
const frames = new EventEmitter();
frames.setMaxListeners(0);

// Serialize all page interactions (keys, shots, reloads).
let chain = Promise.resolve();
const exclusive = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function launch() {
  if (starting) return starting;
  starting = (async () => {
    try { await browser?.close(); } catch {}
    browser = page = null;
    log("launching chromium");
    browser = await puppeteer.launch({
      headless: true,
      executablePath: env("PUPPETEER_EXECUTABLE_PATH", undefined) || undefined,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb",
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites",
        `--window-size=${WIDTH},${HEIGHT}`,
      ],
    });
    browser.on("disconnected", () => { log("browser disconnected"); browser = page = null; });
    page = await browser.newPage();
    page.on("error", (e) => { log("page crash", e.message); page = null; });
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    let delay = 1000;
    for (;;) {
      try {
        const r = await page.goto(APP_URL, { waitUntil: "networkidle0", timeout: 20000 });
        if (r && r.ok()) break;
        throw new Error(`HTTP ${r?.status()}`);
      } catch (e) {
        log(`app not ready (${e.message}); retry in ${delay}ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, 15000);
      }
    }
    await page.keyboard.press("ArrowDown");
    log("page ready", APP_URL);
    await injectBattery(page);
  })().finally(() => { starting = null; });
  return starting;
}

async function ensurePage() {
  if (!browser || !page || page.isClosed()) await launch();
  return page;
}

// E-ink photo pipeline for one region of a grayscale frame: auto-levels, mild contrast/brightness lift,
// unsharp mask, then Floyd-Steinberg dither down to the panel's 16 grey levels.
const PHOTO_CONTRAST = Number(process.env.PHOTO_CONTRAST || 1.12);
const PHOTO_BRIGHTNESS = Number(process.env.PHOTO_BRIGHTNESS || 12);
const PHOTO_SHARPEN = Number(process.env.PHOTO_SHARPEN || 1.0);
async function processPhotoRegion(frameBuf, r) {
  const region = await sharp(frameBuf)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .normalise()
    .linear(PHOTO_CONTRAST, PHOTO_BRIGHTNESS - 128 * (PHOTO_CONTRAST - 1))
    .sharpen({ sigma: PHOTO_SHARPEN })
    .png({ palette: true, colours: 16, dither: 1.0 })
    .toBuffer();
  const raw = await sharp(region).grayscale().toColourspace("b-w").raw().toBuffer();
  return sharp(frameBuf)
    .composite([{ input: raw, raw: { width: r.w, height: r.h, channels: 1 }, left: r.x, top: r.y }])
    .removeAlpha()
    .toColourspace("b-w")
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}

// Kindle battery state, reported by the device client via GET /battery?level=NN&charging=0|1 and
// pushed into the page as window.__kindleBattery + a "kindle-battery" CustomEvent.
let battery = null;
async function injectBattery(p) {
  if (!battery || !p) return;
  try {
    await p.evaluate((b) => {
      window.__kindleBattery = b;
      window.dispatchEvent(new CustomEvent("kindle-battery", { detail: b }));
    }, battery);
  } catch (e) { log("battery inject failed:", e.message); }
}

async function shoot() {
  const p = await ensurePage();
  const png = await p.screenshot({ type: "png" });
  // The app may request a full e-ink refresh via <html data-eink-refresh="full">, and mark a photo
  // region via data-eink-photo="x,y,w,h" that gets e-ink specific processing (levels, sharpen, dither).
  let hint = "partial";
  let photo = null;
  try {
    const ds = await p.evaluate(() => ({ r: document.documentElement.dataset.einkRefresh || "", p: document.documentElement.dataset.einkPhoto || "" }));
    hint = ds.r === "full" ? "full" : "partial";
    const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(ds.p || "");
    if (m) photo = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  } catch {}
  let frame = sharp(png)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .toColourspace("b-w");
  if (photo && photo.w > 8 && photo.h > 8 && photo.x + photo.w <= WIDTH && photo.y + photo.h <= HEIGHT) {
    try {
      frame = sharp(await processPhotoRegion(await frame.png({ palette: false }).toBuffer(), photo));
    } catch (e) { log("photo processing failed:", e.message); }
  }
  const buf = await frame.png({ palette: false, compressionLevel: 9 }).toBuffer();
  const etag = crypto.createHash("sha1").update(buf).digest("hex");
  const changed = !latest || latest.etag !== etag;
  latest = { buf, etag, hint };
  lastShotAt = new Date().toISOString();
  if (changed) frames.emit("frame", latest);
  return latest;
}

const safeShoot = () =>
  exclusive(shoot).catch(async (e) => {
    log("screenshot failed, relaunching:", e.message);
    page = null;
    await launch();
    return exclusive(shoot);
  });

async function pressKey(code) {
  return exclusive(async () => {
    const p = await ensurePage();
    await p.keyboard.press(code);
    await sleep(KEY_SETTLE_MS);
    return shoot();
  }).catch(async (e) => {
    log("key failed, relaunching:", e.message);
    page = null;
    await launch();
    return safeShoot();
  });
}

async function reloadPage() {
  return exclusive(async () => {
    const p = await ensurePage();
    await p.reload({ waitUntil: "networkidle0", timeout: 20000 });
    await p.keyboard.press("ArrowDown");
    await sleep(KEY_SETTLE_MS);
    return shoot();
  }).catch(async (e) => {
    log("reload failed, relaunching:", e.message);
    page = null;
    await launch();
    return safeShoot();
  });
}

function sendPng(res, frame) {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": frame.buf.length,
    ETag: frame.etag,
    "Cache-Control": "no-store",
  });
  res.end(frame.buf);
}

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
if (!BRIDGE_TOKEN) console.log("WARNING: BRIDGE_TOKEN unset, bridge is open to anyone who can reach it");

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, "http://x");
  const queryToken = url.searchParams.get("token");
  if (queryToken !== null) url.searchParams.set("token", "[redacted]");
  // Token may also be the first path segment (/<token>/screen.png) for clients that cannot set headers.
  let shownPath = url.pathname;
  let pathToken = null;
  if (BRIDGE_TOKEN && url.pathname.startsWith("/" + BRIDGE_TOKEN + "/")) {
    pathToken = BRIDGE_TOKEN;
    url.pathname = url.pathname.slice(BRIDGE_TOKEN.length + 1);
    shownPath = "/[redacted]" + url.pathname;
  }
  res.on("finish", () =>
    log(`${req.method} ${shownPath}${url.search || ""} -> ${res.statusCode} ${Date.now() - t0}ms`));
  try {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (BRIDGE_TOKEN && path !== "/healthz") {
      const given = req.headers["x-bridge-token"] || queryToken || pathToken;
      if (given !== BRIDGE_TOKEN) {
        shownPath = "/[auth-failed]"; // never log guessed/mistyped tokens
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("unauthorized\n");
      }
    }
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        ok: !!latest, etag: latest?.etag ?? null, hint: latest?.hint ?? null, battery, lastShotAt, appUrl: APP_URL,
      }));
    }
    if (path === "/battery") {
      const level = Number(url.searchParams.get("level"));
      const charging = url.searchParams.get("charging") === "1";
      if (!Number.isFinite(level) || level < 0 || level > 100) { res.writeHead(400); return res.end("bad level\n"); }
      battery = { level: Math.round(level), charging, at: new Date().toISOString() };
      await injectBattery(page);
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("ok\n");
    }
    if (path === "/hint") {
      // "full" or "partial": how the Kindle should draw the current frame.
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", ETag: latest?.etag ?? "" });
      return res.end((latest?.hint ?? "partial") + "\n");
    }
    if (path === "/screen.png") {
      const since = url.searchParams.get("since");
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 60000);
      if (!latest) await safeShoot();
      if (since && latest.etag === since) {
        if (!wait) { res.writeHead(304, { ETag: since, "Cache-Control": "no-store" }); return res.end(); }
        const frame = await new Promise((resolve) => {
          const done = (f) => { clearTimeout(timer); frames.off("frame", done); resolve(f); };
          const timer = setTimeout(() => done(null), wait);
          frames.on("frame", done);
          req.on("close", () => done(null));
        });
        if (res.destroyed) return;
        if (!frame || frame.etag === since) {
          res.writeHead(304, { ETag: since, "Cache-Control": "no-store" });
          return res.end();
        }
        return sendPng(res, frame);
      }
      return sendPng(res, latest);
    }
    if (path.startsWith("/key/")) {
      const name = decodeURIComponent(path.slice(5)).toLowerCase();
      const code = KEYS[name];
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end(`unknown key '${name}'. valid: ${Object.keys(KEYS).join(", ")}\n`);
      }
      return sendPng(res, await pressKey(code));
    }
    if (path === "/reload") return sendPng(res, await reloadPage());
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  } catch (e) {
    log("error", e.stack || e.message);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error\n");
  }
});

async function main() {
  server.listen(PORT, "0.0.0.0", () => log(`bridge listening on :${PORT}, app ${APP_URL}`));
  await launch();
  await safeShoot();
  setInterval(() => safeShoot().catch((e) => log("refresh error", e.message)), REFRESH_MS);
  if (PAGE_RELOAD_MS > 0)
    setInterval(() => reloadPage().catch((e) => log("reload error", e.message)), PAGE_RELOAD_MS);
}

for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, async () => { try { await browser?.close(); } catch {} process.exit(0); });

main().catch((e) => { log("fatal", e.stack || e.message); process.exit(1); });
