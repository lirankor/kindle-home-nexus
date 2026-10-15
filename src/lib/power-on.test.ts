import { describe, expect, it } from "vitest";
import {
  BOOT_POLL_MS,
  BOOT_TIMEOUT_MS,
  classifyAmpError,
  retryable,
  sendWithRetries,
  waitUntilReady,
} from "./power-on";
import type { AmpProbe, Clock } from "./power-on";

/** A clock whose sleeps advance it instantly, recording every sleep. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps, now: () => t };
}
const seq = (...probes: AmpProbe[]) => {
  let i = 0;
  return async () => probes[Math.min(i++, probes.length - 1)]!;
};
const http = (status: number): AmpProbe => ({ kind: "http", status });
const ok: AmpProbe = { kind: "ok" };

describe("amp boot poll (waitUntilReady)", () => {
  it("409, 409, 200/RC0 → ready on the third probe, 2 s apart, every attempt logged", async () => {
    const { clock, sleeps } = fakeClock();
    const log: string[] = [];
    const r = await waitUntilReady(seq(http(409), http(409), ok), {
      clock,
      log: (m) => log.push(m),
    });
    expect(r).toMatchObject({ ready: true, attempts: 3, last: ok, elapsedMs: 2 * BOOT_POLL_MS });
    expect(sleeps).toEqual([BOOT_POLL_MS, BOOT_POLL_MS]);
    expect(log).toEqual([
      "boot probe 1 at +0 s: HTTP 409",
      "boot probe 2 at +2 s: HTTP 409",
      "boot probe 3 at +4 s: HTTP 200 RC 0",
    ]);
  });
  it("5xx, RC errors and transport errors all count as still booting", async () => {
    const { clock } = fakeClock();
    const r = await waitUntilReady(
      seq(http(503), { kind: "rc", rc: 2 }, { kind: "error", message: "Amp unreachable" }, ok),
      { clock },
    );
    expect(r.ready).toBe(true);
    expect(r.attempts).toBe(4);
  });
  it("gives up after the timeout and reports the last answer", async () => {
    const { clock, sleeps } = fakeClock();
    const r = await waitUntilReady(seq(http(409)), { clock, timeoutMs: BOOT_TIMEOUT_MS });
    expect(r.ready).toBe(false);
    expect(r.last).toEqual(http(409));
    expect(r.attempts).toBe(BOOT_TIMEOUT_MS / BOOT_POLL_MS + 1); // probes at 0, 2, … 60 s
    expect(sleeps.length).toBe(r.attempts - 1);
    expect(r.elapsedMs).toBeLessThanOrEqual(BOOT_TIMEOUT_MS);
  });
});

describe("power command with retries (sendWithRetries)", () => {
  it("retries 409 / 5xx with the spacing and succeeds on a clean answer", async () => {
    const { clock, sleeps } = fakeClock();
    const log: string[] = [];
    const r = await sendWithRetries(seq(http(409), http(500), ok), {
      clock,
      log: (m) => log.push(m),
      spacingMs: 3000,
    });
    expect(r).toEqual({ ok: true, attempts: 3, last: ok });
    expect(sleeps).toEqual([3000, 3000]);
    expect(log[0]).toBe("power command attempt 1/5: HTTP 409");
    expect(log[2]).toBe("power command attempt 3/5: HTTP 200 RC 0");
  });
  it("stops after the last retry", async () => {
    const { clock } = fakeClock();
    const r = await sendWithRetries(seq(http(409)), { clock, retries: 5 });
    expect(r).toEqual({ ok: false, attempts: 5, last: http(409) });
  });
  it("does not retry a clean RC error (the amp understood and refused)", async () => {
    const { clock, sleeps } = fakeClock();
    const r = await sendWithRetries(seq({ kind: "rc", rc: 3 }, ok), { clock });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("classifyAmpError", () => {
  it("reads the MediaError messages", () => {
    expect(classifyAmpError(new Error("Amp HTTP 409"))).toEqual(http(409));
    expect(classifyAmpError(new Error("Amp RC 2"))).toEqual({ kind: "rc", rc: 2 });
    expect(classifyAmpError(new Error("Amp unreachable"))).toEqual({
      kind: "error",
      message: "Amp unreachable",
    });
    expect(retryable(http(409))).toBe(true);
    expect(retryable(http(503))).toBe(true);
    expect(retryable(http(404))).toBe(false);
    expect(retryable({ kind: "error", message: "timeout" })).toBe(true);
  });
});
