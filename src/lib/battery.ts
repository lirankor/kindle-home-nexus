import { useEffect, useState } from "react";

export type KindleBattery = { level: number; charging: boolean; at: string };

/** `label` = the wake time as local HH:MM, formatted by the bridge (the browser clock is UTC). */
export type KindleSleep = { nextWake: number; label: string; sleepSec: number; night: boolean };

declare global {
  interface Window {
    __kindleBattery?: unknown;
    __kindleSleep?: unknown;
  }
}

const parseSleep = (value: unknown): KindleSleep | null => {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["nextWake"] !== "number" || !Number.isFinite(v["nextWake"])) return null;
  return {
    nextWake: v["nextWake"],
    label: typeof v["label"] === "string" ? v["label"] : "",
    sleepSec: typeof v["sleepSec"] === "number" ? v["sleepSec"] : 0,
    night: v["night"] === true,
  };
};

/** The Kindle's sleep cycle (bridge /sleep → window.__kindleSleep + "kindle-sleep"); null while awake. */
export function useKindleSleep(): KindleSleep | null {
  const [sleep, setSleep] = useState<KindleSleep | null>(null);
  useEffect(() => {
    const update = (value: unknown) =>
      setSleep((prev) => {
        const next = parseSleep(value);
        return next &&
          prev &&
          next.nextWake === prev.nextWake &&
          next.label === prev.label &&
          next.night === prev.night
          ? prev
          : next;
      });
    update(window.__kindleSleep);
    const onEvent = (event: Event) => update((event as CustomEvent).detail);
    window.addEventListener("kindle-sleep", onEvent);
    return () => window.removeEventListener("kindle-sleep", onEvent);
  }, []);
  return sleep;
}

const parse = (value: unknown): KindleBattery | null => {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["level"] !== "number" || !Number.isFinite(v["level"])) return null;
  return {
    level: Math.max(0, Math.min(100, Math.round(v["level"]))),
    charging: v["charging"] === true,
    at: typeof v["at"] === "string" ? v["at"] : "",
  };
};

/** Battery of the Kindle, injected by the bridge as window.__kindleBattery plus a "kindle-battery" event. */
export function useKindleBattery(): KindleBattery | null {
  const [battery, setBattery] = useState<KindleBattery | null>(null);
  useEffect(() => {
    // Only re-render when the visible values change, so a report every 20 s costs no frame.
    const update = (value: unknown) =>
      setBattery((prev) => {
        const next = parse(value);
        return next && prev && next.level === prev.level && next.charging === prev.charging
          ? prev
          : next;
      });
    update(window.__kindleBattery);
    const onEvent = (event: Event) => update((event as CustomEvent).detail);
    window.addEventListener("kindle-battery", onEvent);
    return () => window.removeEventListener("kindle-battery", onEvent);
  }, []);
  return battery;
}
