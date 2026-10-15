import { useEffect, useState } from "react";

export type KindleBattery = { level: number; charging: boolean; at: string };

declare global {
  interface Window {
    __kindleBattery?: unknown;
  }
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
