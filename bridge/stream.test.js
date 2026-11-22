import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPressFeeder, createRenderScheduler, nextFrame } from "./stream.js";

// A clock the test moves by hand, with the scheduler's timers on it.
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    setTimer: (fn, ms) => (timers.set(++id, { at: t + Math.max(0, ms), fn }), id),
    clearTimer: (i) => timers.delete(i),
    pending: () => timers.size,
    // Move the clock forward ms, running what falls due on the way (and letting promises settle in between).
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await tick();
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
      await tick();
    },
  };
}

// A render the test finishes by hand: renders[i].done() ends the i-th one.
function manualRender(clock) {
  const renders = [];
  const render = () =>
    new Promise((done) => renders.push({ at: clock.now(), done: () => (done(), clock.advance(0)) }));
  return { renders, render };
}

test("scheduler: a burst of changes after a key gives one render, settleMs after the first", async () => {
  const clock = fakeClock();
  const { renders, render } = manualRender(clock);
  const s = createRenderScheduler({ render, settleMs: 40, selfMinMs: 5000, ...clock });
  await clock.advance(1000);
  s.mark(true);
  await clock.advance(10);
  s.mark(true);
  s.mark(false);
  await clock.advance(20);
  assert.equal(renders.length, 0, "not before the settle time");
  await clock.advance(10);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].at, 1040);
  await renders[0].done();
  await clock.advance(10000);
  assert.equal(renders.length, 1, "nothing changed since: no second render");
});

test("scheduler: never two renders at once, a change during a render gives exactly one more", async () => {
  const clock = fakeClock();
  const { renders, render } = manualRender(clock);
  const s = createRenderScheduler({ render, settleMs: 40, selfMinMs: 5000, ...clock });
  s.mark(true);
  await clock.advance(40);
  assert.equal(renders.length, 1);
  // five more presses land while the first frame is being produced
  for (let i = 0; i < 5; i++) {
    s.mark(true);
    await clock.advance(20);
  }
  assert.equal(renders.length, 1, "the render in flight is not overtaken");
  assert.equal(s.state().running, true);
  await renders[0].done();
  await clock.advance(0);
  assert.equal(renders.length, 2, "one more, straight after");
  await renders[1].done();
  await clock.advance(10000);
  assert.equal(renders.length, 2, "and only one");
  assert.deepEqual(
    { dirty: s.state().dirty, running: s.state().running },
    { dirty: false, running: false },
  );
});

test("scheduler: the page's own changes are spaced selfMinMs apart, a key press is not held back", async () => {
  const clock = fakeClock();
  const renders = [];
  const render = async () => void renders.push(clock.now());
  const s = createRenderScheduler({ render, settleMs: 40, selfMinMs: 5000, ...clock });
  await clock.advance(100000);
  // a progress bar that moves every second for 12 s
  for (let i = 0; i < 12; i++) {
    s.mark(false);
    await clock.advance(1000);
  }
  assert.deepEqual(renders, [100040, 105040, 110040]);
  await clock.advance(5000); // the last tick is rendered too (115040), then the page is quiet
  assert.equal(renders.at(-1), 115040);
  // a key press 300 ms after that render: rendered after the settle time, not 5 s later
  await clock.advance(115340 - clock.now());
  s.mark(true);
  await clock.advance(40);
  assert.equal(renders.at(-1), 115380);
});

test("scheduler: nothing is rendered while nobody listens; the change is rendered when a listener is back", async () => {
  const clock = fakeClock();
  const renders = [];
  let listening = false;
  const s = createRenderScheduler({
    render: async () => void renders.push(clock.now()),
    active: () => listening,
    settleMs: 40,
    selfMinMs: 5000,
    ...clock,
  });
  s.mark(true);
  s.mark(false);
  await clock.advance(60000);
  assert.equal(renders.length, 0);
  assert.equal(clock.pending(), 0, "no timer left running either");
  assert.equal(s.state().dirty, true);
  listening = true;
  s.plan();
  await clock.advance(0);
  assert.equal(renders.length, 1);
});

test("scheduler: fresh() resolves only after a render that started after the call", async () => {
  const clock = fakeClock();
  const { renders, render } = manualRender(clock);
  const s = createRenderScheduler({ render, active: () => false, settleMs: 40, selfMinMs: 5000, ...clock });
  let got = 0;
  // nobody "listens" yet: fresh() renders all the same (it is the listener arriving)
  s.fresh().then(() => got++);
  await clock.advance(40);
  assert.equal(renders.length, 1);
  // a second caller arrives while that render is in flight: it must not be served by it
  s.fresh().then(() => got++);
  await renders[0].done();
  await clock.advance(0);
  assert.equal(got, 1);
  await clock.advance(40);
  assert.equal(renders.length, 2);
  await renders[1].done();
  await clock.advance(0);
  assert.equal(got, 2);
});

test("scheduler: settled() waits for the frame a key press still owes, not for the page's own changes", async () => {
  const clock = fakeClock();
  const { renders, render } = manualRender(clock);
  const s = createRenderScheduler({ render, settleMs: 40, selfMinMs: 5000, ...clock });
  let done = 0;
  await s.settled(); // nothing outstanding: at once
  s.mark(true);
  s.settled().then(() => done++);
  await clock.advance(10);
  assert.equal(done, 0);
  await clock.advance(30);
  assert.equal(renders.length, 1);
  await renders[0].done();
  await clock.advance(0);
  assert.equal(done, 1);
  // only a change of the page's own is pending (5 s spacing): settled() does not wait for it
  s.mark(false);
  let quick = false;
  s.settled().then(() => (quick = true));
  await clock.advance(0);
  assert.equal(quick, true);
  assert.equal(renders.length, 1);
});

test("scheduler: a failing render is reported and does not stop the next one", async () => {
  const clock = fakeClock();
  const errors = [];
  let n = 0;
  const s = createRenderScheduler({
    render: async () => {
      if (++n === 1) throw new Error("renderer hung");
    },
    onError: (e) => errors.push(e.message),
    settleMs: 40,
    selfMinMs: 5000,
    ...clock,
  });
  s.mark(true);
  await clock.advance(40);
  assert.deepEqual(errors, ["renderer hung"]);
  s.mark(true);
  await clock.advance(40);
  assert.equal(n, 2);
});

// The bridge's page lock: one job at a time, in order.
function lock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}

test("press feeder: presses reach the page one at a time, in the order they arrived", async () => {
  const pressed = [];
  let inFlight = 0;
  let overlap = false;
  const feed = createPressFeeder({
    exclusive: lock(),
    ready: async () => "page",
    press: async (page, code) => {
      if (++inFlight > 1) overlap = true;
      await new Promise((r) => setTimeout(r, code === "ArrowDown" ? 15 : 1)); // the first is the slowest
      pressed.push(code);
      inFlight--;
    },
  });
  const results = await Promise.all(
    ["ArrowDown", "ArrowUp", "Enter", "F2"].map((code, i) => feed(`k${i}`, code)),
  );
  assert.deepEqual(pressed, ["ArrowDown", "ArrowUp", "Enter", "F2"]);
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(overlap, false);
});

test("press feeder: a press that waited too long for the page is dropped, the ones behind it still go", async () => {
  let t = 0;
  const pressed = [];
  const logged = [];
  const exclusive = lock();
  const feed = createPressFeeder({
    exclusive,
    ready: async () => "page",
    press: async (page, code) => void pressed.push(code),
    maxAgeMs: 2000,
    now: () => t,
    log: (m) => logged.push(m),
  });
  // the page lock is held by a hung renderer for 5 s
  let release;
  exclusive(() => new Promise((r) => (release = r)));
  await new Promise((r) => setImmediate(r));
  const a = feed("select", "Enter"); // pressed at t = 0
  t = 4000;
  const b = feed("down", "ArrowDown"); // pressed at t = 4000
  t = 5000;
  release();
  assert.equal(await a, false);
  assert.equal(await b, true);
  assert.deepEqual(pressed, ["ArrowDown"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /press select dropped: it waited 5000 ms/);
});

test("press feeder: a failing press rejects once and is not pressed again", async () => {
  let calls = 0;
  const feed = createPressFeeder({
    exclusive: lock(),
    ready: async () => "page",
    press: async () => {
      calls++;
      throw new Error("page crashed");
    },
  });
  await assert.rejects(feed("up", "ArrowUp"), /page crashed/);
  assert.equal(calls, 1);
});

test("nextFrame: answers with the first frame that differs from what the client has, skipping equal ones", async () => {
  const frames = new EventEmitter();
  const p = nextFrame(frames, "aaa", 1000);
  frames.emit("frame", { etag: "aaa" });
  frames.emit("frame", { etag: "bbb" });
  frames.emit("frame", { etag: "ccc" });
  assert.deepEqual(await p, { etag: "bbb" });
  assert.equal(frames.listenerCount("frame"), 0, "no listener left behind");
});

test("nextFrame: the hold ends with null when no newer frame came in time", async () => {
  const frames = new EventEmitter();
  const t0 = Date.now();
  assert.equal(await nextFrame(frames, "aaa", 30), null);
  assert.ok(Date.now() - t0 >= 25);
  assert.equal(frames.listenerCount("frame"), 0);
});

test("nextFrame: the hold ends at once when the client goes away, and leaves nothing behind", async () => {
  const frames = new EventEmitter();
  let gone;
  const p = nextFrame(frames, "aaa", 60000, (cb) => (gone = cb));
  gone();
  assert.equal(await p, null);
  assert.equal(frames.listenerCount("frame"), 0);
});
