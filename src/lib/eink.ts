import { useEffect } from "react";

const FULL_MS = 1500;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Ask the Kindle bridge for a flashing full e-ink refresh of the next frame.
 * The bridge reads <html data-eink-refresh> after every screenshot; the value
 * falls back to "partial" shortly after, so small updates stay partial.
 */
export function requestFullRefresh(ms = FULL_MS) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-eink-refresh", "full");
  clearTimeout(timer);
  timer = setTimeout(() => {
    root.setAttribute("data-eink-refresh", "partial");
  }, ms);
}

/** Request a full refresh whenever `key` changes (including the first render). */
export function useFullRefresh(key: string | number | null | undefined) {
  useEffect(() => {
    requestFullRefresh();
  }, [key]);
}
