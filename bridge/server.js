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
  back: "Escape", escape: "Escape",
  prev: "PageUp", pageup: "PageUp", next: "PageDown", pagedown: "PageDown",
  home: "Home", menu: "KeyM", keyboard: "KeyK",
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
  })().finally(() => { starting = null; });
  return starting;
}

async function ensurePage() {
  if (!browser || !page || page.isClosed()) await launch();
  return page;
}

async function shoot() {
  const p = await ensurePage();
  const png = await p.screenshot({ type: "png" });
  const buf = await sharp(png)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .toColourspace("b-w")
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
  const etag = crypto.createHash("sha1").update(buf).digest("hex");
  const changed = !latest || latest.etag !== etag;
  latest = { buf, etag };
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

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, "http://x");
  res.on("finish", () =>
    log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms`));
  try {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        ok: !!latest, etag: latest?.etag ?? null, lastShotAt, appUrl: APP_URL,
      }));
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
