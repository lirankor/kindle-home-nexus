// The two-channel flow for the Kindle (README "Two channels"): presses come in on /press/<name> and are only
// acknowledged, pictures go out on /stream.png, one held-open request at a time. This file holds the parts of it
// that need no browser, so they can be tested: when to render, how presses are fed to the page, and the hold.

// Decides WHEN the page is rendered. The page says "I changed" (mark), nobody polls. Rules:
// - a change is rendered settleMs after it was first noted (later changes of the same batch ride along);
// - never two renders at once: a change noted while a frame is being produced gives exactly one more afterwards;
// - changes of the page's own (a clock, a progress bar) are spaced selfMinMs apart; a change after a key press or an
//   app event (urgent) is not;
// - nothing is rendered while nobody listens (active() false): the change is remembered and rendered when a
//   listener is back.
export function createRenderScheduler({
  render,
  active = () => true,
  settleMs = 40,
  selfMinMs = 5000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
}) {
  let dirty = false; // the page changed since the last render was started
  let urgent = false; // ... after a key press or an app event
  let markedAt = 0; // when the first change of this batch was noted
  let lastEnd = -Infinity; // when the last render finished
  let running = null; // the render in flight
  let timer = null;
  let timerAt = 0;
  let waiters = []; // callers waiting for a render that starts after their call
  let renders = 0;

  const due = () =>
    urgent ? markedAt + settleMs : Math.max(markedAt + settleMs, lastEnd + selfMinMs);

  function plan(force = false) {
    if (!dirty || running || !(force || active())) return;
    const at = due();
    if (timer !== null) {
      if (timerAt <= at) return;
      clearTimer(timer);
    }
    timerAt = at;
    timer = setTimer(run, Math.max(0, at - now()));
  }

  async function run() {
    timer = null;
    if (running || !dirty) return;
    dirty = false;
    urgent = false;
    const batch = waiters;
    waiters = [];
    renders++;
    running = (async () => {
      try {
        await render();
      } catch (e) {
        onError(e);
      }
    })();
    await running;
    running = null;
    lastEnd = now();
    for (const done of batch) done();
    plan(waiters.length > 0);
  }

  function mark(isUrgent = false, force = false) {
    if (!dirty) {
      dirty = true;
      markedAt = now();
    }
    if (isUrgent) urgent = true;
    plan(force);
  }

  return {
    // The page changed. isUrgent: after a key press or an app event.
    mark: (isUrgent = false) => mark(isUrgent),
    // A listener is back: render what was noted while nobody listened.
    plan: () => plan(),
    // Resolves after a render that STARTS after this call: that frame shows the page as it is now, or newer.
    fresh() {
      const p = new Promise((done) => waiters.push(done));
      mark(true, true);
      return p;
    },
    // Resolves when no frame that a key press or an app event is waiting for is still outstanding: the render in
    // flight, then one more if such a change was noted meanwhile. Changes of the page's own are not waited for.
    async settled() {
      if (running) await running;
      if (dirty && urgent) {
        const p = new Promise((done) => waiters.push(done));
        plan(true);
        await p;
      }
    },
    state: () => ({ dirty, urgent, running: !!running, renders }),
  };
}

// Feeds presses to the page one at a time, in the order they arrived (exclusive = the bridge's page lock). A press
// that had to wait longer than maxAgeMs for its turn (hung renderer, browser relaunch) is dropped: a key must never
// act late. Resolves true when the key was pressed, false when it was dropped.
export function createPressFeeder({
  exclusive,
  ready,
  press,
  maxAgeMs = 2000,
  now = Date.now,
  log = () => {},
}) {
  return (name, code) => {
    const at = now();
    return exclusive(async () => {
      const page = await ready();
      const waited = now() - at;
      if (waited > maxAgeMs) {
        log(`press ${name} dropped: it waited ${waited} ms for its turn`);
        return false;
      }
      await press(page, code);
      return true;
    });
  };
}

// The hold of /stream.png: the first frame whose ETag differs from `have`, or null after waitMs or when the
// client went away (onGone(cb) registers the "client closed the request" callback).
export function nextFrame(frames, have, waitMs, onGone = () => {}) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (frame) => {
      clearTimeout(timer);
      frames.off("frame", onFrame);
      resolve(frame);
    };
    const onFrame = (frame) => {
      if (frame && frame.etag !== have) finish(frame);
    };
    timer = setTimeout(() => finish(null), Math.max(0, waitMs));
    frames.on("frame", onFrame);
    onGone(() => finish(null));
  });
}

// Runs inside the page (puppeteer evaluateOnNewDocument): tells the bridge when the picture may have changed,
// through window.__einkChanged(full), at most once per task. full = the app bumped <html data-eink-full> (tab,
// screen, song, modal: its own "this is an event" counter). Image loads and focus moves are not DOM mutations, so
// they are listened for separately.
export function pageChangeReporter() {
  let queued = false;
  let full = false;
  const flush = () => {
    queued = false;
    const f = full;
    full = false;
    try {
      window.__einkChanged(f);
    } catch {
      /* binding not there yet */
    }
  };
  const note = (isFull) => {
    if (isFull) full = true;
    if (queued) return;
    queued = true;
    setTimeout(flush, 0);
  };
  new MutationObserver((records) =>
    note(
      records.some(
        (r) =>
          r.type === "attributes" &&
          r.attributeName === "data-eink-full" &&
          r.target === document.documentElement,
      ),
    ),
  ).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener("load", () => note(false), true);
  document.addEventListener("focusin", () => note(false), true);
}
