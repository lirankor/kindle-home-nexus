// Transport discipline for the Jellyfin queue, pure and timer-injectable so it can be unit-tested:
//  - TransportLock: one renderer (DLNA) command at a time, in order; nothing overlaps.
//  - SkipCoalescer: next/previous move the queue index at once, the renderer call is debounced
//    SKIP_DEBOUNCE_MS after the last press and reads the *latest* target when the lock is its turn,
//    so 20 presses are one SetAVTransportURI/Play (two when one was already in flight).
//  - stallStep: the renderer-stall watchdog. The R-N500 drops its network side under a command storm
//    (HA: unavailable → idle, 2026-10-15) and the queue used to keep "playing" with a running clock.
// media.server.ts wires these to the real amp.
export const SKIP_DEBOUNCE_MS = 700;
/** Idle this long (with time left in the track) before the first replay. */
export const STALL_CONFIRM_MS = 6000;
/** Wait after each replay before the next one; after the last one the queue is paused as stalled. */
export const STALL_BACKOFF_MS = [5000, 10000, 20000] as const;
export const STALL_MAX_RETRIES = STALL_BACKOFF_MS.length;
/** Playing this long after a replay forgets the retries (a stall later is a new episode). */
export const STALL_FORGIVE_MS = 30000;
export const STALL_REASON = "renderer stopped";
/** After Play: wait at most this long for the renderer to report PLAYING. */
export const PLAY_CONFIRM_MS = 8000;

/** Serialises renderer calls: `run` queues `fn` behind whatever is in flight and returns its result. */
export class TransportLock {
  private tail: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  get busy(): boolean {
    return this.inflight > 0;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight += 1;
    const p = this.tail.then(fn, fn).finally(() => {
      this.inflight -= 1;
    });
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/**
 * Debounced, lock-serialised skip. `request(i)` records the wanted index and (re)arms the timer; when it
 * fires the push is queued on the lock and, once it is its turn, pushes the index wanted *at that moment*.
 * A press while a push is in flight therefore costs exactly one follow-up push for the final target.
 */
export class SkipCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private target: number | null = null;
  constructor(
    private readonly lock: TransportLock,
    private readonly push: (index: number) => Promise<void>,
    private readonly onError: (e: unknown, index: number) => void = () => undefined,
    private readonly debounceMs = SKIP_DEBOUNCE_MS,
  ) {}
  /** Something is owed to the renderer: a timer armed, a push waiting for or holding the lock. */
  get busy(): boolean {
    return this.timer !== null || this.target !== null || this.lock.busy;
  }
  /** The index still to be pushed, null when the renderer is up to date. */
  get pending(): number | null {
    return this.target;
  }
  request(index: number): void {
    this.target = index;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }
  /** Forget a pending skip (pause / stop / a new queue took over). An in-flight push finishes on its own. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.target = null;
  }
  private flush(): Promise<void> {
    return this.lock.run(async () => {
      const index = this.target;
      this.target = null;
      if (index === null) return;
      try {
        await this.push(index);
      } catch (e) {
        this.onError(e, index);
      }
    });
  }
}

// ---- Stall watchdog ----
export type StallState = {
  /** When the renderer was first seen idle in this episode (clock frozen since). */
  idleSince: number | null;
  retries: number;
  /** Not before this wall-clock time may the next replay go out. */
  retryAt: number | null;
  lastReplayAt: number | null;
};
export const freshStall = (): StallState => ({
  idleSince: null,
  retries: 0,
  retryAt: null,
  lastReplayAt: null,
});
export type StallAction =
  /** Nothing to do (playing normally, or idle but still inside the confirm / backoff window). */
  | "none"
  /** First idle sighting: stop the app's clock where it is and watch. */
  | "freeze"
  /** Idle for long enough: re-send play for the current track from 0. */
  | "replay"
  /** Replays exhausted: pause the queue with STALL_REASON. */
  | "give-up"
  /** Playing again after an idle episode: restart the clock. */
  | "clear";

/** One watchdog step from the renderer's idle/not-idle verdict at `now`. */
export function stallStep(
  s: StallState,
  idle: boolean,
  now: number,
): { action: StallAction; state: StallState } {
  if (!idle) {
    const action: StallAction = s.idleSince !== null ? "clear" : "none";
    const settled = s.lastReplayAt === null || now - s.lastReplayAt >= STALL_FORGIVE_MS;
    return { action, state: settled ? freshStall() : { ...s, idleSince: null, retryAt: null } };
  }
  if (s.idleSince === null) return { action: "freeze", state: { ...s, idleSince: now } };
  if (now - s.idleSince < STALL_CONFIRM_MS) return { action: "none", state: s };
  if (s.retryAt !== null && now < s.retryAt) return { action: "none", state: s };
  if (s.retries >= STALL_MAX_RETRIES) return { action: "give-up", state: freshStall() };
  const backoff = STALL_BACKOFF_MS[s.retries] ?? STALL_BACKOFF_MS[STALL_BACKOFF_MS.length - 1]!;
  return {
    action: "replay",
    state: { ...s, retries: s.retries + 1, retryAt: now + backoff, lastReplayAt: now },
  };
}

/**
 * Is the renderer idle? The UPnP transport state is the renderer's own word (STOPPED / NO_MEDIA_PRESENT
 * = idle, PAUSED_PLAYBACK = a pause, PLAYING / TRANSITIONING = alive). When UPnP gives nothing (the
 * amp's HTTP side stalls after DLNA activity) HA's yamaha_ynca state decides: idle / off = idle,
 * unavailable / unknown = no verdict.
 */
export function rendererIdle(upnpState: string | null, haState: string | null): boolean {
  if (upnpState === "STOPPED" || upnpState === "NO_MEDIA_PRESENT") return true;
  if (upnpState === "PLAYING" || upnpState === "PAUSED_PLAYBACK" || upnpState === "TRANSITIONING")
    return false;
  return haState === "idle" || haState === "off" || haState === "standby";
}

/** Resume on a queue the app believes is playing: re-send play unless the renderer really plays. */
export type ResumeDecision = "noop" | "unfreeze" | "replay" | "resume";
export function decideResume(
  status: "playing" | "paused" | "stopped" | "ended",
  clockRunning: boolean,
  upnpState: string | null,
): ResumeDecision {
  if (status !== "playing") return "resume";
  if (upnpState === "PLAYING") return clockRunning ? "noop" : "unfreeze";
  return "replay";
}
