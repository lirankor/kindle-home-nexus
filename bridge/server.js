import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { computeSchedule, readConfig as readScheduleConfig } from "./schedule.js";
import { connectingResponse, createConnectingStore } from "./connecting.js";
import {
  createPhotoClock,
  createPressFeeder,
  createRenderScheduler,
  createSingleFlight,
  nextFrame,
  pageBusy,
  pageChangeReporter,
  photoKeyRefusal,
  photoOnRequestFlag,
  requestNextPhoto,
  saverPhoto,
} from "./stream.js";

const env = (k, d) => process.env[k] ?? d;
const APP_URL = env("APP_URL", "http://app:3000/");
const PORT = Number(env("PORT", 8790));
const WIDTH = Number(env("WIDTH", 600));
const HEIGHT = Number(env("HEIGHT", 800));
const REFRESH_MS = Number(env("REFRESH_MS", 30000));
const KEY_SETTLE_MS = Number(env("KEY_SETTLE_MS", 200));
// After a key, keep waiting while the page flags <html data-eink-busy> (e.g. the screensaver loading
// the next photo after F1), so the key's own screenshot already shows the result.
const BUSY_WAIT_MS = Number(env("BUSY_WAIT_MS", 6000));
const PAGE_RELOAD_MS = Number(env("PAGE_RELOAD_MS", 0));
// Any single CDP call (screenshot, evaluate, reload) that takes longer than this means the renderer hung:
// fail fast and relaunch instead of puppeteer's 180 s default.
const PROTOCOL_TIMEOUT_MS = Number(env("PROTOCOL_TIMEOUT_MS", 20000));
// The page keeps a 1 s heartbeat in window.__alive; if it stops advancing for this long the page's JS is
// frozen (seen 2026-10-09: the amp view stuck on one frame while the music moved on) → reload it.
const ALIVE_STALE_MS = Number(env("ALIVE_STALE_MS", 45000));
// Battery saver (see ../docs/battery-saver-plan.md): the Kindle never suspends — while the app shows
// its screensaver and nothing is in use it switches its Wi-Fi radio OFF between updates and brings it
// up only to fetch. /schedule tells it when the next update is due. RADIO_DUTY_ENABLED=0 keeps the
// radio up (server-side kill switch; the old name SLEEP_ENABLED still works), SAVER_POLL_S is the
// fallback poll cadence on the screensaver, KEEP_AWAKE_MS how long a key press on the panel keeps the
// radio up (= the app's own 5 min screensaver idle time).
// Two channels (stream.js, README "Two channels"): GET /press/<name> only acknowledges a press, GET /stream.png is
// held open until a newer frame exists. Nobody polls for pictures there: the page reports its own changes and the
// bridge renders STREAM_SETTLE_MS after the first change of a batch. Changes of the page's own (clock, progress
// bar) are rendered at most every STREAM_SELF_MIN_MS; a change within PRESS_URGENT_MS after a press, or one the app
// counts in data-eink-full, is not held back. All of it only while a stream client listens (asked within
// STREAM_IDLE_MS). A press that waited longer than PRESS_MAX_AGE_MS for the page is dropped, never fed late.
const STREAM_SETTLE_MS = Number(env("STREAM_SETTLE_MS", 10));
const STREAM_SELF_MIN_MS = Number(env("STREAM_SELF_MIN_MS", 5000));
const STREAM_IDLE_MS = Number(env("STREAM_IDLE_MS", 10000));
const STREAM_WAIT_MS = Number(env("STREAM_WAIT_MS", 25000));
const PRESS_URGENT_MS = Number(env("PRESS_URGENT_MS", 1500));
const PRESS_MAX_AGE_MS = Number(env("PRESS_MAX_AGE_MS", 2000));
// A press whose sender has already hung up was given up on by the Kindle (its 0.3 s limit) and only reached us late
// (bridge stalled, request stuck on the way, sent again by the Kindle's kernel after a gap): dropped. The hang-up is
// read from the socket one turn after the request, hence the short wait before the answer. 0 switches the check off.
const PRESS_GONE_WAIT_MS = Number(env("PRESS_GONE_WAIT_MS", 5));
// The screensaver photo changes only on request (stream.js "the screensaver photo changes only on request"). How long
// the bridge waits for the app's answer to "next photo" (the pick, the download and the crop take a second or two);
// how often it checks whether it has to ask itself while a stream client listens; how much earlier than the day wake
// interval a poll of the old flow may get the next photo (a device on the grid arrives a few seconds early or late).
const NEXT_PHOTO_WAIT_MS = Number(env("NEXT_PHOTO_WAIT_MS", 10000));
const PHOTO_CLOCK_MS = 15000;
const PHOTO_POLL_SLACK_MS = 60000;
const ENV_RADIO_DUTY = env("RADIO_DUTY_ENABLED", env("SLEEP_ENABLED", "1")) !== "0";
let RADIO_DUTY_ENABLED = ENV_RADIO_DUTY;
const SAVER_POLL_S = Number(env("SAVER_POLL_S", 60));
const KEEP_AWAKE_MS = Number(env("KEEP_AWAKE_MS", 5 * 60 * 1000));
const ENV_SCHEDULE = readScheduleConfig(process.env);
let schedule = ENV_SCHEDULE;
// The panel config in Home Assistant (kindle_panel) owns the battery-saver schedule when it is set up there; the app
// answers it on /api/voice/panel-schedule. Re-read every minute; the env above stays the fallback.
async function refreshScheduleFromPanel() {
  try {
    const res = await fetch(new URL("api/voice/panel-schedule", APP_URL), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const body = await res.json();
    const fromHa = body?.source === "ha" && body.schedule;
    const s = fromHa ? body.schedule : null;
    // Not (or no longer) set up in HA, e.g. after a rollback: back to the env schedule.
    const next = s
      ? readScheduleConfig({
          DAY_WAKE_MIN: String(s.day_wake_min),
          NIGHT_START: s.night_start,
          NIGHT_END: s.night_end,
          NIGHT_WAKE_MIN: String(s.night_wake_min),
          SLEEP_TZ: s.timezone,
        })
      : ENV_SCHEDULE;
    const duty = s ? s.radio_duty !== false : ENV_RADIO_DUTY;
    if (JSON.stringify(next) !== JSON.stringify(schedule) || duty !== RADIO_DUTY_ENABLED)
      console.log(
        `[schedule] from ${s ? "Home Assistant" : "env"}: ${JSON.stringify({ ...next, radioDuty: duty })}`,
      );
    schedule = next;
    RADIO_DUTY_ENABLED = duty;
  } catch {
    /* app not up yet: keep what we have */
  }
}
setInterval(refreshScheduleFromPanel, 60_000).unref?.();
setTimeout(refreshScheduleFromPanel, 5_000).unref?.();

const KEYS = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  select: "Enter",
  enter: "Enter",
  ok: "Enter",
  // Long press of the 5-way centre (the Kindle client times it): the panel's "more options" key.
  "select-long": "ContextMenu",
  escape: "Escape",
  prev: "PageUp",
  pageup: "PageUp",
  next: "PageDown",
  pagedown: "PageDown",
  // Kindle bottom row (Back, Keyboard, Menu, Home) = soft keys F1..F4, matching the app footer left to right.
  back: "F1",
  keyboard: "F2",
  menu: "F3",
  home: "F4",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page = null;
let latest = null; // { buf, etag, fullGen, saver }
let servedFullGen = -1; // the app's data-eink-full value the Kindle last drew with a full refresh
let lastShotAt = null;
let lastKeyAt = 0; // last /key, /press or /wake hit: the device keeps its radio up KEEP_AWAKE_MS after it
let lastPressAt = 0; // last press fed to the page through /press or /wake
let lastFedAt = 0; // when the last /press key went into the page (set under the page lock)
// The photo id of the last frame sent to a client (<html data-eink-photo-id>, "" = a photo without one), null when
// that frame was not the screensaver: what the panel shows, for photoKeyRefusal.
let panelPhoto = null;
let shotSeq = 0; // counts captures; a frame from an older capture never replaces a newer one
let latestSeq = 0;
let streamWaiting = 0; // /stream.png requests being held right now
let streamSeenAt = 0; // when the last one ended
let pressStats = { fed: 0, dropped: 0 };
let lastRender = null; // { captureMs, encodeMs, at } of the last stream frame, for /healthz
// What /schedule last told the device, for /healthz: { verdict, windowSec, nextWake, label, night, at }.
let lastDuty = null;
let lastAlive = { value: 0, seenAt: 0 };
let starting = null;
const frames = new EventEmitter();
// Recent frames by ETag + their "connecting" badge variants (GET /screen.png?connecting=1, see connecting.js).
const connecting = createConnectingStore();
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
    try {
      await browser?.close();
    } catch {}
    browser = page = null;
    log("launching chromium");
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      executablePath: env("PUPPETEER_EXECUTABLE_PATH", undefined) || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites",
        `--window-size=${WIDTH},${HEIGHT}`,
      ],
    });
    browser.on("disconnected", () => {
      log("browser disconnected");
      browser = page = null;
    });
    page = await browser.newPage();
    page.on("error", (e) => {
      log("page crash", e.message);
      page = null;
    });
    // The page tells us when its picture may have changed (stream.js); both survive reloads.
    await page.exposeFunction("__einkChanged", (full) =>
      renderer.mark(!!full || Date.now() - lastPressAt < PRESS_URGENT_MS),
    );
    await page.evaluateOnNewDocument(pageChangeReporter);
    // No photo timer in the page: the photo changes on request (nextPhoto below); survives reloads as well.
    await page.evaluateOnNewDocument(photoOnRequestFlag);
    // Heartbeat for the freeze watchdog in capture(); evaluateOnNewDocument survives reloads.
    await page.evaluateOnNewDocument(() => {
      window.__alive = Date.now();
      setInterval(() => {
        window.__alive = Date.now();
      }, 1000);
    });
    lastAlive = { value: 0, seenAt: Date.now() };
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
    log("page ready", APP_URL);
    await injectBattery(page);
  })().finally(() => {
    starting = null;
  });
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
    .grayscale()
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
  } catch (e) {
    log("battery inject failed:", e.message);
  }
}

// What the page reports about itself: poll cadence wish, screensaver showing, heartbeat.
const pageState = () =>
  exclusive(async () =>
    (await ensurePage()).evaluate(() => ({
      poll: document.documentElement.dataset.einkPoll || "",
      saver: document.documentElement.dataset.einkSaver === "1",
    })),
  );

// Seconds until the Kindle's next poll: the app's wish (5 while a queue plays on the Media tab),
// else SAVER_POLL_S on the screensaver, else the device's own default.
function pollSeconds(state, dflt) {
  const n = Number(state.poll);
  if (Number.isFinite(n) && n >= 1 && n <= 600) return Math.round(n);
  if (state.saver) return SAVER_POLL_S;
  return dflt;
}

// One screenshot plus what the page says about itself. Touches the page: call it under the page lock (exclusive).
async function capture() {
  const p = await ensurePage();
  const seq = ++shotSeq;
  const png = await p.screenshot({ type: "png" });
  // The app counts full-refresh events in <html data-eink-full> (tab / screen / page / song change…);
  // /hint answers "full" once per new value. It may mark a photo region via data-eink-photo="x,y,w,h"
  // that gets e-ink specific processing (levels, sharpen, dither).
  let fullGen = 0;
  let photo = null;
  let alive = 0;
  let saver = false;
  let photoId = "";
  try {
    const ds = await p.evaluate(() => ({
      f: document.documentElement.dataset.einkFull || "0",
      p: document.documentElement.dataset.einkPhoto || "",
      a: window.__alive || 0,
      s: document.documentElement.dataset.einkSaver === "1",
      i: document.documentElement.dataset.einkPhotoId || "",
    }));
    fullGen = Number(ds.f) || 0;
    const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(ds.p || "");
    if (m) photo = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    alive = ds.a;
    saver = ds.s;
    photoId = ds.i;
  } catch {}
  // Freeze watchdog: the heartbeat must move between shots; a page whose timers stopped gets reloaded
  // (same profile, so the remembered tab survives); if even that hangs, the protocol timeout relaunches.
  if (alive) {
    if (alive !== lastAlive.value) lastAlive = { value: alive, seenAt: Date.now() };
    else if (Date.now() - lastAlive.seenAt > ALIVE_STALE_MS) {
      log(
        `page heartbeat stalled for ${Math.round((Date.now() - lastAlive.seenAt) / 1000)} s, reloading`,
      );
      lastAlive = { value: 0, seenAt: Date.now() };
      await p.reload({ waitUntil: "networkidle0", timeout: 20000 });
      return capture();
    }
  }
  return { seq, png, fullGen, photo, saver, photoId };
}

// Turns a capture into the frame the Kindle draws. CPU work only, no page access: the stream renderer runs it
// outside the page lock so a press never waits behind the encoding (the photo pipeline takes most of a second).
async function encode({ seq, png, fullGen, photo, saver, photoId }) {
  let frame = sharp(png)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .toColourspace("b-w");
  if (
    photo &&
    photo.w > 8 &&
    photo.h > 8 &&
    photo.x + photo.w <= WIDTH &&
    photo.y + photo.h <= HEIGHT
  ) {
    try {
      frame = sharp(
        await processPhotoRegion(await frame.png({ palette: false }).toBuffer(), photo),
      );
    } catch (e) {
      log("photo processing failed:", e.message);
    }
  }
  let buf = await frame
    .grayscale()
    .toColourspace("b-w")
    .removeAlpha()
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
  // eips can only draw 8-bit single-channel PNGs; never serve anything else.
  const meta = await sharp(buf).metadata();
  if (meta.channels !== 1 || meta.depth !== "uchar") {
    log(`frame not 8-bit grayscale (channels=${meta.channels}, depth=${meta.depth}), re-encoding`);
    buf = await sharp(buf)
      .flatten({ background: "#ffffff" })
      .grayscale()
      .toColourspace("b-w")
      .removeAlpha()
      .png({ palette: false, compressionLevel: 9 })
      .toBuffer();
  }
  // md5, not sha1: the Kindle's busybox has md5sum only, and it sends the hash of the frame it drew
  // back as ?etag= so an unchanged frame costs no PNG.
  const etag = crypto.createHash("md5").update(buf).digest("hex");
  if (seq < latestSeq) return latest; // a newer capture was encoded first
  latestSeq = seq;
  const changed = !latest || latest.etag !== etag;
  latest = { buf, etag, fullGen, saver, photoId };
  photoClock.seen(saver);
  connecting.remember(latest);
  lastShotAt = new Date().toISOString();
  if (changed) frames.emit("frame", latest);
  return latest;
}

// Screenshot + encoding in one go, for the callers that hold the page lock anyway (/key, /reload, fresh polls).
async function shoot() {
  return encode(await capture());
}

const safeShoot = () =>
  exclusive(shoot).catch(async (e) => {
    log("screenshot failed, relaunching:", e.message);
    page = null;
    await launch();
    return exclusive(shoot);
  });

async function settleBusy(p) {
  const until = Date.now() + BUSY_WAIT_MS;
  while (Date.now() < until) {
    const busy = await p.evaluate(pageBusy);
    if (!busy) return;
    await sleep(150);
  }
}

// ---- the screensaver photo changes only on request (stream.js) ----
const photoClock = createPhotoClock({ intervalMs: () => schedule.dayWakeMin * 60000 });
let oldAppNoted = false;
// Asks the app for the next photo and waits until the page shows it. Does nothing unless the screensaver shows. Not
// under the page lock: a press must not wait for a photo download. who = who wanted it, for /healthz and the log.
const nextPhoto = createSingleFlight(async (who) => {
  try {
    const p = await ensurePage();
    const t0 = Date.now();
    const asking = p.evaluate(requestNextPhoto);
    asking.catch(() => {});
    const answer = await Promise.race([
      asking,
      sleep(NEXT_PHOTO_WAIT_MS).then(() => "no answer in time"),
    ]);
    if (answer === "no screensaver") return answer;
    if (answer === "old app") {
      // An app image from before the request: its page timer changes the photo as it always did.
      if (!oldAppNoted)
        log("next photo: the app does not know the request, its own timer stays in charge");
      oldAppNoted = true;
      photoClock.note("the page's own timer (app without the request)");
      return answer;
    }
    if (answer === "asked") photoClock.note(who);
    else if (answer !== "busy") photoClock.note(`${who}, ${answer}`); // do not ask again every few seconds
    // "busy": a mark + next photo is in flight (F1 / F4), wait for it. No answer in time: the device's request has
    // its own limit, it gets the picture as it is.
    if (answer === "asked" || answer === "busy") await settleBusy(p);
    log(`next photo for ${who}: ${answer} (${Date.now() - t0} ms)`);
    return answer;
  } catch (e) {
    log("next photo failed:", e.message);
    photoClock.note(`${who}, failed`); // the next try comes with the next interval, not every few seconds
    return "failed";
  }
});

// ---- two channels: /press, /wake, /stream.png ----
const streamListening = () => streamWaiting > 0 || Date.now() - streamSeenAt < STREAM_IDLE_MS;

// One frame for the stream: wait (without holding the page lock, so presses still get through) while the page says
// it is busy, capture under the lock, encode outside it.
async function renderForStream() {
  const until = Date.now() + BUSY_WAIT_MS;
  for (;;) {
    let t0 = 0;
    const cap = await exclusive(async () => {
      const p = await ensurePage();
      const busy = await p.evaluate(pageBusy);
      if (busy && Date.now() < until) return null;
      t0 = Date.now();
      return capture();
    });
    if (cap) {
      const t1 = Date.now();
      const frame = await encode(cap);
      lastRender = { captureMs: t1 - t0, encodeMs: Date.now() - t1, at: new Date().toISOString() };
      return frame;
    }
    await sleep(150);
  }
}

const renderer = createRenderScheduler({
  render: () =>
    renderForStream().catch(async (e) => {
      log("stream render failed, relaunching:", e.message);
      page = null;
      await launch();
      await safeShoot();
    }),
  active: streamListening,
  settleMs: STREAM_SETTLE_MS,
  selfMinMs: STREAM_SELF_MIN_MS,
  onError: (e) => log("stream render error:", e.message),
});

const feedPress = createPressFeeder({
  exclusive,
  ready: ensurePage,
  press: async (p, code) => {
    await p.keyboard.press(code);
    lastFedAt = Date.now();
  },
  maxAgeMs: PRESS_MAX_AGE_MS,
  log,
});

// A press that is in the queue has gone in, and the page had KEY_SETTLE_MS to show what it started (a photo key on the
// screensaver sets data-eink-busy a moment later). For the first picture after a press: see /stream.png.
async function pressesSettled() {
  await exclusive(() => {});
  const left = lastFedAt + KEY_SETTLE_MS - Date.now();
  if (left > 0) await sleep(left);
}

const PHOTO_KEYS = new Set(["F1", "F4"]);
// /press: the key goes to the page in its turn; the picture follows on /stream.png. photoKey (?saver=1): a photo key
// from a panel whose radio was off, see photoKeyRefusal.
function acceptPress(name, code, photoKey = false) {
  const refuse = photoKey
    ? async (p) => photoKeyRefusal(await p.evaluate(saverPhoto), panelPhoto)
    : null;
  const onSaver = !!latest?.saver;
  feedPress(name, code, refuse)
    .then((fed) => {
      if (!fed) return void pressStats.dropped++;
      pressStats.fed++;
      lastPressAt = Date.now();
      if (onSaver && PHOTO_KEYS.has(code)) photoClock.note(`key ${name}`);
      renderer.mark(true);
    })
    .catch(async (e) => {
      // Never pressed again: a key must not act late.
      pressStats.dropped++;
      log(`press ${name} failed, relaunching:`, e.message);
      page = null;
      await launch().catch(() => {});
    });
}

// /wake: leaves the screensaver and does nothing else. The app's own wake listener swallows the first key while the
// screensaver shows; this hands it a key no handler knows, and only while the screensaver is up, so it cannot act
// on a control (F1 / F4 act on the screensaver's photo and are never used here).
function wakeSaver() {
  return exclusive(async () => {
    const p = await ensurePage();
    return p.evaluate(() => {
      if (document.documentElement.dataset.einkSaver !== "1") return false;
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Unidentified", bubbles: true, cancelable: true }),
      );
      return true;
    });
  });
}

async function pressKey(code) {
  return exclusive(async () => {
    const p = await ensurePage();
    await p.keyboard.press(code);
    await sleep(KEY_SETTLE_MS);
    await settleBusy(p);
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
    await sleep(KEY_SETTLE_MS);
    return shoot();
  }).catch(async (e) => {
    log("reload failed, relaunching:", e.message);
    page = null;
    await launch();
    return safeShoot();
  });
}

// `since` = the ?etag= the client sent: an identical frame is answered with an empty 200 (the
// Kindle's busybox 1.7.2 wget treats anything but 200/206 as an error, so no 304/204).
function sendPng(res, frame, since) {
  panelPhoto = frame.saver ? frame.photoId || "" : null;
  if (since && since === frame.etag) {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": 0,
      ETag: frame.etag,
      "X-Unchanged": "1",
      "Cache-Control": "no-store",
    });
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": frame.buf.length,
    ETag: frame.etag,
    "Cache-Control": "no-store",
  });
  res.end(frame.buf);
}

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
if (!BRIDGE_TOKEN)
  console.log("WARNING: BRIDGE_TOKEN unset, bridge is open to anyone who can reach it");

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
    log(`${req.method} ${shownPath}${url.search || ""} -> ${res.statusCode} ${Date.now() - t0}ms`),
  );
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
      return res.end(
        JSON.stringify({
          ok: !!latest,
          etag: latest?.etag ?? null,
          fullGen: latest?.fullGen ?? null,
          servedFullGen,
          battery,
          lastShotAt,
          appUrl: APP_URL,
          saver: latest?.saver ?? false,
          duty: lastDuty,
          lastKeyAt: lastKeyAt ? new Date(lastKeyAt).toISOString() : null,
          // The screensaver photo: when it last changed and who asked; onPanel = the last frame sent to a client
          // shows the photo the page shows now (null without a screensaver).
          photo: {
            ...photoClock.state(),
            onPanel: latest?.saver ? (latest.photoId || "") === panelPhoto : null,
          },
          stream: {
            listening: streamListening(),
            waiting: streamWaiting,
            presses: pressStats,
            lastRender,
            ...renderer.state(),
          },
          schedule: {
            enabled: RADIO_DUTY_ENABLED,
            ...schedule,
            next: computeSchedule(Date.now(), schedule),
          },
        }),
      );
    }
    if (path === "/battery") {
      const level = Number(url.searchParams.get("level"));
      const charging = url.searchParams.get("charging") === "1";
      if (!Number.isFinite(level) || level < 0 || level > 100) {
        res.writeHead(400);
        return res.end("bad level\n");
      }
      battery = { level: Math.round(level), charging, at: new Date().toISOString() };
      await injectBattery(page);
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("ok\n");
    }
    if (path === "/poll") {
      // Seconds the Kindle should sleep before its next screen poll: the app's <html data-eink-poll>
      // (5 while a Jellyfin queue plays on the Media tab), SAVER_POLL_S on the screensaver, else the
      // Kindle's own default.
      const dflt = Math.min(Math.max(Number(url.searchParams.get("default")) || 20, 1), 600);
      let seconds = dflt;
      try {
        seconds = pollSeconds(await pageState(), dflt);
      } catch {}
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end(seconds + "\n");
    }
    if (path === "/schedule") {
      // One line for the Kindle: "<poll s> <doze|awake> <next update epoch s> <window s> <night 0|1> <HH:MM local>".
      // "doze" = you may switch the radio off until the next update; only while the app shows the
      // screensaver, no key was pressed for KEEP_AWAKE_MS and the server-side switch is on. The next
      // update time comes from the schedule (day grid / night grid, local time zone) so the device never
      // needs tz data. ?woke=1 is accepted for compatibility and counts as a key press.
      const dflt = Math.min(Math.max(Number(url.searchParams.get("default")) || 20, 1), 600);
      if (url.searchParams.get("woke") === "1") {
        lastKeyAt = Date.now();
        log("device reported an unplanned wake, keeping the radio up");
      }
      let state = { poll: "", saver: false };
      try {
        state = await pageState();
      } catch {}
      const now = Date.now();
      const sched = computeSchedule(now, schedule);
      const mode =
        RADIO_DUTY_ENABLED && state.saver && now - lastKeyAt >= KEEP_AWAKE_MS ? "doze" : "awake";
      lastDuty = {
        verdict: mode,
        windowSec: mode === "doze" ? sched.windowSec : 0,
        nextWake: Math.round(sched.wakeMs / 1000),
        label: sched.label,
        night: sched.night,
        at: new Date().toISOString(),
      };
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end(
        `${pollSeconds(state, dflt)} ${mode} ${Math.round(sched.wakeMs / 1000)} ${sched.windowSec} ${sched.night ? 1 : 0} ${sched.label}\n`,
      );
    }
    if (path === "/hint") {
      // "full" or "partial": how the Kindle should draw the frame it just fetched. Full exactly once
      // per new app event counter; the periodic / poll screenshots in between do not consume it.
      const gen = latest?.fullGen ?? 0;
      const hint = gen !== servedFullGen ? "full" : "partial";
      servedFullGen = gen;
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        ETag: latest?.etag ?? "",
      });
      return res.end(hint + "\n");
    }
    if (path === "/screen.png" && url.searchParams.get("connecting") === "1") {
      // The frame the client has on its panel (?of=<etag>) with the battery saver's connecting badge in the middle.
      if (!latest) await safeShoot();
      const r = await connectingResponse(connecting, latest, url.searchParams);
      res.writeHead(r.status, r.headers);
      return res.end(r.body);
    }
    if (path === "/screen.png") {
      const since = url.searchParams.get("since");
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 60000);
      // fresh=1: screenshot now instead of serving the last frame (polls; keys always shoot).
      // fresh=1&next=1 (the Kindle's timed wake at the end of a radio-off window): the next screensaver photo first.
      // Without next=1 (a client of the old flow) the photo moves on once it is a day wake interval old.
      const fresh = url.searchParams.get("fresh") === "1";
      if (fresh && url.searchParams.get("next") === "1") await nextPhoto("the device");
      else if (fresh && photoClock.due(PHOTO_POLL_SLACK_MS)) await nextPhoto("the bridge (a poll)");
      if (!latest || fresh) await safeShoot();
      if (url.searchParams.get("etag")) return sendPng(res, latest, url.searchParams.get("etag"));
      if (since && latest.etag === since) {
        if (!wait) {
          res.writeHead(304, { ETag: since, "Cache-Control": "no-store" });
          return res.end();
        }
        const frame = await new Promise((resolve) => {
          const done = (f) => {
            clearTimeout(timer);
            frames.off("frame", done);
            resolve(f);
          };
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
      lastKeyAt = Date.now();
      if (latest?.saver && PHOTO_KEYS.has(code)) photoClock.note(`key ${name}`);
      return sendPng(res, await pressKey(code), url.searchParams.get("etag"));
    }
    if (path.startsWith("/press/")) {
      // One press, answered at once with "ok": received, not done. No picture here, see /stream.png.
      const name = decodeURIComponent(path.slice(7)).toLowerCase();
      const code = KEYS[name];
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end(`unknown key '${name}'. valid: ${Object.keys(KEYS).join(", ")}\n`);
      }
      if (PRESS_GONE_WAIT_MS > 0) {
        await sleep(PRESS_GONE_WAIT_MS);
        if (req.destroyed || res.destroyed) {
          pressStats.dropped++;
          log(`press ${name} dropped: the client had already hung up`);
          return;
        }
      }
      lastKeyAt = Date.now();
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("ok\n");
      return acceptPress(name, code, url.searchParams.get("saver") === "1");
    }
    if (path === "/wake") {
      lastKeyAt = Date.now();
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("ok\n");
      wakeSaver()
        .then((woke) => {
          if (!woke) return;
          lastPressAt = Date.now();
          renderer.mark(true);
          log("wake: left the screensaver");
        })
        .catch((e) => log("wake failed:", e.message));
      return;
    }
    if (path === "/stream.png") {
      // Held open until a frame other than ?have=<etag> exists, at most ?wait= ms. Then an EMPTY 200 (never a 304:
      // the Kindle's wget takes that for an error) and the client simply asks again.
      const have = url.searchParams.get("have") || "";
      const wait = Math.min(
        Math.max(Number(url.searchParams.get("wait")) || STREAM_WAIT_MS, 0),
        60000,
      );
      const wasListening = streamListening();
      let frame = null;
      streamWaiting++;
      try {
        if (!latest) await safeShoot();
        // A client with nothing on its panel, or the first one after a pause: render now. Otherwise only make sure
        // no frame a press is waiting for is still on its way, so the answer is the newest picture.
        // After a press that is still on its way into the page (a photo key sent by a panel whose radio was off):
        // the press first, so the one picture this client draws in full is the result, not the photo before it.
        if (!have || !wasListening) {
          await pressesSettled();
          await renderer.fresh();
        } else {
          renderer.plan();
          await renderer.settled();
        }
        frame =
          latest.etag !== have
            ? latest
            : await nextFrame(frames, have, wait, (gone) => res.on("close", gone));
      } finally {
        streamWaiting--;
        streamSeenAt = Date.now();
      }
      if (res.destroyed) return;
      return frame ? sendPng(res, frame) : sendPng(res, latest, latest.etag);
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
  log(
    `radio duty cycling: ${RADIO_DUTY_ENABLED ? "enabled" : "DISABLED"}, day every ${schedule.dayWakeMin} min, night ${String(Math.floor(schedule.nightStart / 60)).padStart(2, "0")}:${String(schedule.nightStart % 60).padStart(2, "0")}-${String(Math.floor(schedule.nightEnd / 60)).padStart(2, "0")}:${String(schedule.nightEnd % 60).padStart(2, "0")} every ${schedule.nightWakeMin} min (${schedule.tz})`,
  );
  await launch();
  await safeShoot();
  setInterval(() => safeShoot().catch((e) => log("refresh error", e.message)), REFRESH_MS);
  // The fallback clock of the screensaver photo: only while a stream request is held open, so the new photo goes
  // straight to a panel (a Kindle whose radio stays on). A Kindle with its radio off asks itself at its timed wake.
  setInterval(() => {
    if (streamWaiting > 0 && photoClock.due()) nextPhoto("the bridge (a stream client listens)");
  }, PHOTO_CLOCK_MS);
  if (PAGE_RELOAD_MS > 0)
    setInterval(() => reloadPage().catch((e) => log("reload error", e.message)), PAGE_RELOAD_MS);
}

for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, async () => {
    try {
      await browser?.close();
    } catch {}
    process.exit(0);
  });

main().catch((e) => {
  log("fatal", e.stack || e.message);
  process.exit(1);
});
