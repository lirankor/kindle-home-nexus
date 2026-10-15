import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKIP_DEBOUNCE_MS,
  STALL_BACKOFF_MS,
  STALL_CONFIRM_MS,
  STALL_FORGIVE_MS,
  STALL_MAX_RETRIES,
  SkipCoalescer,
  TransportLock,
  decideResume,
  freshStall,
  rendererIdle,
  stallStep,
} from "./queue-transport";

/** A push whose completion the test controls. */
function controlledPush() {
  const calls: number[] = [];
  const resolvers: (() => void)[] = [];
  const push = (i: number) => {
    calls.push(i);
    return new Promise<void>((r) => resolvers.push(r));
  };
  return { calls, push, finish: () => resolvers.shift()?.() };
}

describe("TransportLock", () => {
  it("runs calls one after another, in order, and reports busy while one is in flight", async () => {
    const lock = new TransportLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = lock.run(async () => {
      await gate;
      order.push("a");
    });
    const second = lock.run(async () => {
      order.push("b");
    });
    await Promise.resolve(); // the chain starts on a later microtask
    expect(lock.busy).toBe(true);
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
    expect(lock.busy).toBe(false);
  });
  it("a failing call does not block the next one", async () => {
    const lock = new TransportLock();
    await expect(lock.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lock.run(async () => 42)).toBe(42);
  });
});

describe("SkipCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("5 presses inside the debounce window are one renderer call with the final index", async () => {
    const r = controlledPush();
    const skips = new SkipCoalescer(new TransportLock(), r.push);
    for (const i of [1, 2, 3, 4, 5]) {
      skips.request(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(r.calls).toEqual([]);
    expect(skips.pending).toBe(5);
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS);
    expect(r.calls).toEqual([5]);
    expect(skips.pending).toBeNull();
    expect(skips.busy).toBe(true); // the push is in flight
    r.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(skips.busy).toBe(false);
  });

  it("a press while a push is in flight costs exactly one follow-up call for the latest target", async () => {
    const r = controlledPush();
    const skips = new SkipCoalescer(new TransportLock(), r.push);
    skips.request(1);
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS);
    expect(r.calls).toEqual([1]); // in flight, not finished
    skips.request(2);
    await vi.advanceTimersByTimeAsync(300);
    skips.request(3);
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS + 50);
    expect(r.calls).toEqual([1]); // still waiting for the lock
    r.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toEqual([1, 3]);
    r.finish();
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS * 3);
    expect(r.calls).toEqual([1, 3]); // nothing else owed
    expect(skips.busy).toBe(false);
  });

  it("cancel drops an armed skip; a push error goes to onError, not to the lock chain", async () => {
    const r = controlledPush();
    const errors: [unknown, number][] = [];
    const lock = new TransportLock();
    const skips = new SkipCoalescer(
      lock,
      (i) => (i === 7 ? Promise.reject(new Error("Amp unreachable")) : r.push(i)),
      (e, i) => errors.push([e, i]),
    );
    skips.request(4);
    skips.cancel();
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS * 2);
    expect(r.calls).toEqual([]);
    skips.request(7);
    await vi.advanceTimersByTimeAsync(SKIP_DEBOUNCE_MS);
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe(7);
    expect(await lock.run(async () => "still fine")).toBe("still fine");
  });
});

describe("stall watchdog (stallStep)", () => {
  const t0 = 1_000_000;
  it("idle while playing: freeze first, replay after the confirm window, back off, give up after 3", () => {
    let s = freshStall();
    let r = stallStep(s, true, t0);
    expect(r.action).toBe("freeze");
    s = r.state;
    expect(stallStep(s, true, t0 + 2000).action).toBe("none");
    expect(stallStep(s, true, t0 + 4000).action).toBe("none");
    r = stallStep(s, true, t0 + STALL_CONFIRM_MS);
    expect(r.action).toBe("replay");
    expect(r.state.retries).toBe(1);
    s = r.state;
    // Inside the first backoff: nothing.
    expect(stallStep(s, true, t0 + STALL_CONFIRM_MS + STALL_BACKOFF_MS[0] - 1).action).toBe("none");
    r = stallStep(s, true, t0 + STALL_CONFIRM_MS + STALL_BACKOFF_MS[0]);
    expect(r.action).toBe("replay");
    expect(r.state.retries).toBe(2);
    s = r.state;
    const t3 = t0 + STALL_CONFIRM_MS + STALL_BACKOFF_MS[0] + STALL_BACKOFF_MS[1];
    expect(stallStep(s, true, t3 - 1).action).toBe("none");
    r = stallStep(s, true, t3);
    expect(r.action).toBe("replay");
    expect(r.state.retries).toBe(STALL_MAX_RETRIES);
    s = r.state;
    const t4 = t3 + STALL_BACKOFF_MS[2];
    expect(stallStep(s, true, t4 - 1).action).toBe("none");
    r = stallStep(s, true, t4);
    expect(r.action).toBe("give-up");
    expect(r.state).toEqual(freshStall());
  });
  it("playing again clears the episode; retries are forgiven once it has played a while", () => {
    let s = freshStall();
    s = stallStep(s, true, t0).state;
    s = stallStep(s, true, t0 + STALL_CONFIRM_MS).state; // replay 1
    let r = stallStep(s, false, t0 + STALL_CONFIRM_MS + 2000);
    expect(r.action).toBe("clear");
    expect(r.state.idleSince).toBeNull();
    expect(r.state.retries).toBe(1); // remembered: a stall right after counts on
    s = r.state;
    r = stallStep(s, true, t0 + STALL_CONFIRM_MS + 4000);
    expect(r.action).toBe("freeze");
    s = r.state;
    r = stallStep(s, true, t0 + 2 * STALL_CONFIRM_MS + 4000);
    expect(r.action).toBe("replay");
    expect(r.state.retries).toBe(2);
    // Long after the last replay the slate is clean.
    r = stallStep(r.state, false, t0 + 2 * STALL_CONFIRM_MS + 4000 + STALL_FORGIVE_MS);
    expect(r.state).toEqual(freshStall());
  });
  it("does nothing while the renderer plays", () => {
    expect(stallStep(freshStall(), false, t0)).toEqual({ action: "none", state: freshStall() });
  });
});

describe("rendererIdle", () => {
  it("trusts the UPnP transport state first", () => {
    expect(rendererIdle("STOPPED", "playing")).toBe(true);
    expect(rendererIdle("NO_MEDIA_PRESENT", null)).toBe(true);
    expect(rendererIdle("PLAYING", "idle")).toBe(false);
    expect(rendererIdle("TRANSITIONING", "idle")).toBe(false);
    expect(rendererIdle("PAUSED_PLAYBACK", "idle")).toBe(false);
  });
  it("falls back to HA when UPnP is silent; unavailable is no verdict", () => {
    expect(rendererIdle(null, "idle")).toBe(true);
    expect(rendererIdle(null, "off")).toBe(true);
    expect(rendererIdle(null, "playing")).toBe(false);
    expect(rendererIdle(null, "unavailable")).toBe(false);
    expect(rendererIdle(null, null)).toBe(false);
  });
});

describe("decideResume (resume on an idle renderer)", () => {
  it("re-sends play when the app believes it plays but the renderer does not", () => {
    expect(decideResume("playing", true, "STOPPED")).toBe("replay");
    expect(decideResume("playing", true, null)).toBe("replay");
    expect(decideResume("playing", false, "NO_MEDIA_PRESENT")).toBe("replay");
  });
  it("leaves a really playing renderer alone, only restarting a frozen clock", () => {
    expect(decideResume("playing", true, "PLAYING")).toBe("noop");
    expect(decideResume("playing", false, "PLAYING")).toBe("unfreeze");
  });
  it("paused / stopped / ended resume as before", () => {
    expect(decideResume("paused", false, null)).toBe("resume");
    expect(decideResume("stopped", false, "STOPPED")).toBe("resume");
    expect(decideResume("ended", false, "STOPPED")).toBe("resume");
  });
});
