/**
 * Who changes the screensaver photo.
 *
 * In a plain browser the page does, on a timer. Under the Kindle bridge the page never does on its own: the Kindle
 * switches its radio off between updates, so a photo changed by a page timer would be on the server and not on the
 * panel. The bridge sets `window.__einkPhotoOnRequest` before the app's scripts run (on every document, so a reload
 * keeps it) and asks for the next photo through `window.__einkNextPhoto()` when the device wants one. The photo then
 * changes only on request: when the screensaver starts, on F1 / F4, and on that call.
 */
type EinkWindow = {
  __einkPhotoOnRequest?: boolean;
  __einkNextPhoto?: () => Promise<boolean>;
};

const einkWindow = (): EinkWindow | null =>
  typeof window === "undefined" ? null : (window as unknown as EinkWindow);

/** True when a bridge drives this page: no photo timer, the bridge asks for the next photo. */
export function photoOnRequest(): boolean {
  return einkWindow()?.__einkPhotoOnRequest === true;
}

/** The page timer of the screensaver photo in ms, or false when the photo changes only on request. */
export function photoTimerMs(
  onRequest: boolean,
  photoMinutes: number | undefined,
  fallbackMs: number,
): number | false {
  return onRequest ? false : (photoMinutes ?? fallbackMs / 60_000) * 60_000;
}

/**
 * Offers the bridge the "next photo" request while the screensaver shows. `next` resolves once the page shows the
 * answer: true = a photo was asked for, false = one was on its way already. Returns the function that withdraws
 * the offer.
 */
export function offerNextPhoto(next: () => Promise<boolean>): () => void {
  const w = einkWindow();
  if (!w) return () => {};
  w.__einkNextPhoto = next;
  return () => {
    if (w.__einkNextPhoto === next) delete w.__einkNextPhoto;
  };
}
