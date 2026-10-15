// Amp boot handling for the power-on routine, pure and timer-injectable so it can be unit-tested.
// The R-N500's HTTP server answers on tcp 80 well before its firmware is ready (2026-10-15: port open
// ~15 s after the plug, the XML Power=On got HTTP 409 and the routine failed on the spot). So after the
// port opens we probe Basic_Status until it is HTTP 200 + RC 0, then send the power command with retries.
export const BOOT_POLL_MS = 2000;
export const BOOT_TIMEOUT_MS = 60_000;
export const POWER_CMD_RETRIES = 5;
export const POWER_CMD_SPACING_MS = 3000;

/** Outcome of one amp XML call, classified. */
export type AmpProbe =
  | { kind: "ok" }
  | { kind: "http"; status: number }
  | { kind: "rc"; rc: number }
  | { kind: "error"; message: string };

/** Map an amp call's exception (MediaError messages "Amp HTTP n" / "Amp RC n" / "Amp unreachable") to a probe. */
export function classifyAmpError(e: unknown): AmpProbe {
  const message = e instanceof Error ? e.message : String(e);
  const http = /Amp HTTP (\d+)/.exec(message);
  if (http) return { kind: "http", status: Number(http[1]) };
  const rc = /Amp RC (-?\d+)/.exec(message);
  if (rc) return { kind: "rc", rc: Number(rc[1]) };
  return { kind: "error", message };
}
export const describeProbe = (p: AmpProbe): string =>
  p.kind === "ok"
    ? "HTTP 200 RC 0"
    : p.kind === "http"
      ? `HTTP ${p.status}`
      : p.kind === "rc"
        ? `RC ${p.rc}`
        : p.message;
/** Anything but a clean answer means "still booting" (409, 5xx, RC errors, timeouts, connection resets). */
export const bootReady = (p: AmpProbe): boolean => p.kind === "ok";
/** The power command is worth another try on 409 / 5xx / transport errors; a clean RC error is not. */
export const retryable = (p: AmpProbe): boolean =>
  p.kind === "http" ? p.status === 409 || p.status >= 500 : p.kind === "error";

export type Clock = { sleep: (ms: number) => Promise<void>; now: () => number };
const realClock: Clock = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now };

/** Probe until the amp answers cleanly: every `pollMs`, at most `timeoutMs`; every attempt is logged. */
export async function waitUntilReady(
  probe: () => Promise<AmpProbe>,
  opts: { pollMs?: number; timeoutMs?: number; log?: (msg: string) => void; clock?: Clock } = {},
): Promise<{ ready: boolean; attempts: number; last: AmpProbe; elapsedMs: number }> {
  const { pollMs = BOOT_POLL_MS, timeoutMs = BOOT_TIMEOUT_MS, log = () => undefined } = opts;
  const clock = opts.clock ?? realClock;
  const start = clock.now();
  let attempts = 0;
  let last: AmpProbe = { kind: "error", message: "not probed" };
  for (;;) {
    attempts += 1;
    last = await probe();
    const elapsedMs = clock.now() - start;
    log(`boot probe ${attempts} at +${Math.round(elapsedMs / 1000)} s: ${describeProbe(last)}`);
    if (bootReady(last)) return { ready: true, attempts, last, elapsedMs };
    if (clock.now() - start + pollMs > timeoutMs)
      return { ready: false, attempts, last, elapsedMs };
    await clock.sleep(pollMs);
  }
}

/** Send a command with retries on 409 / 5xx / transport errors, `spacingMs` apart; every attempt is logged. */
export async function sendWithRetries(
  send: () => Promise<AmpProbe>,
  opts: { retries?: number; spacingMs?: number; log?: (msg: string) => void; clock?: Clock } = {},
): Promise<{ ok: boolean; attempts: number; last: AmpProbe }> {
  const {
    retries = POWER_CMD_RETRIES,
    spacingMs = POWER_CMD_SPACING_MS,
    log = () => undefined,
  } = opts;
  const clock = opts.clock ?? realClock;
  let last: AmpProbe = { kind: "error", message: "not sent" };
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = await send();
    log(`power command attempt ${attempt}/${retries}: ${describeProbe(last)}`);
    if (last.kind === "ok") return { ok: true, attempts: attempt, last };
    if (!retryable(last) || attempt === retries) return { ok: false, attempts: attempt, last };
    await clock.sleep(spacingMs);
  }
  return { ok: false, attempts: retries, last };
}
