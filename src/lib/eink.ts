import { useEffect } from "react";

/**
 * Ask the Kindle bridge for a flashing full e-ink refresh: <html data-eink-full> is a counter that
 * goes up once per event (tab, screen, page, modal, song or station change, replaced image). The
 * bridge records the counter with every screenshot and tells the Kindle "full" exactly once per
 * new value, so the decision follows events, not time windows or how many frames changed.
 * Cursor moves and the ticking progress bar never bump it and stay partial.
 */
export function requestFullRefresh() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-eink-full", String(Number(root.getAttribute("data-eink-full") ?? 0) + 1));
}

/** Request a full refresh whenever `key` changes (including the first render). */
export function useFullRefresh(key: string | number | null | undefined) {
  useEffect(() => {
    requestFullRefresh();
  }, [key]);
}
