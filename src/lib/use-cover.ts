import { useEffect, useState } from "react";

import { requestFullRefresh } from "./eink";

/** Pauses before a failed cover is asked again; after the last one the empty look stays until the song changes. */
export const COVER_RETRY_MS = [5_000, 20_000, 60_000, 120_000];

/**
 * A cover for an <img> that never shows the browser's broken-image icon. The bridge's browser never reloads the
 * page, so one failed request used to stay on screen as that icon for the rest of the song (2026-11-22). Now a
 * failed load hands back no address (the caller shows its empty look) and the picture is asked again in the
 * background, a few times with growing pauses; once it loads it is shown, with a full e-ink refresh as for any
 * replaced image. `url` goes into <img src>, `onError` onto the same <img>.
 */
export function useCover(src: string | null): { url: string | null; onError: () => void } {
  // the address that failed, and the one a background retry has loaded since (null: still failing)
  const [miss, setMiss] = useState<{ src: string; url: string | null } | null>(null);
  const failed = src !== null && miss?.src === src;
  const retried = failed ? (miss?.url ?? null) : null;
  useEffect(() => {
    if (!src || !failed || retried) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probe: HTMLImageElement | null = null;
    const wait = () => {
      const pause = COVER_RETRY_MS[attempt];
      if (pause === undefined) return;
      timer = setTimeout(() => {
        attempt += 1;
        // a new address per try, so the browser asks the server again
        const url = `${src}&retry=${attempt}`;
        probe = new Image();
        probe.onload = () => {
          requestFullRefresh();
          setMiss({ src, url });
        };
        probe.onerror = wait;
        probe.src = url;
      }, pause);
    };
    wait();
    return () => {
      clearTimeout(timer);
      if (probe) probe.onload = probe.onerror = null;
    };
  }, [src, failed, retried]);
  return {
    url: failed ? retried : src,
    onError: () => {
      if (src) setMiss({ src, url: null });
    },
  };
}
