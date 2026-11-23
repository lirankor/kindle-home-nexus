import { afterEach, describe, expect, it } from "vitest";

import { offerNextPhoto, photoOnRequest, photoTimerMs } from "@/lib/saver-photo";

type BridgeWindow = { __einkPhotoOnRequest?: unknown; __einkNextPhoto?: () => Promise<boolean> };
const w = window as unknown as BridgeWindow;

describe("who changes the screensaver photo", () => {
  afterEach(() => {
    delete w.__einkPhotoOnRequest;
    delete w.__einkNextPhoto;
  });

  it("a plain browser keeps the page timer", () => {
    expect(photoOnRequest()).toBe(false);
    expect(photoTimerMs(false, 10, 600_000)).toBe(600_000);
    expect(photoTimerMs(false, 3, 600_000)).toBe(180_000);
    expect(photoTimerMs(false, undefined, 600_000)).toBe(600_000);
  });

  it("the bridge's flag switches the page timer off, and only the flag itself does", () => {
    w.__einkPhotoOnRequest = true;
    expect(photoOnRequest()).toBe(true);
    expect(photoTimerMs(true, 10, 600_000)).toBe(false);
    w.__einkPhotoOnRequest = "yes";
    expect(photoOnRequest()).toBe(false);
  });

  it("offers the next photo request and withdraws only its own offer", async () => {
    const next = () => Promise.resolve(true);
    const withdraw = offerNextPhoto(next);
    expect(await w.__einkNextPhoto?.()).toBe(true);
    const other = () => Promise.resolve(false);
    const withdrawOther = offerNextPhoto(other);
    withdraw(); // a newer offer stays
    expect(w.__einkNextPhoto).toBe(other);
    withdrawOther();
    expect(w.__einkNextPhoto).toBeUndefined();
  });
});
