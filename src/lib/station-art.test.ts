import { describe, expect, it, vi } from "vitest";
import { COVER_LABEL, coverParamsFor, resolveStationArt } from "./station-art";

const eco = { id: "eco-99", name: "Eco 99", fm: 99, logo: "https://eco99fm.maariv.co.il/" };
const bob = { id: "radio-bob", name: "Radio BOB", fm: null, logo: null };
const png = Buffer.from("png");
const cover = Buffer.from("cover");

describe("station art chain", () => {
  it("uses the catalogue logo when it is an image and never asks for a cover", async () => {
    const deps = { fetchLogo: vi.fn().mockResolvedValue(png), fetchCover: vi.fn() };
    expect(await resolveStationArt(eco, "Israel", deps)).toEqual({ bytes: png, source: "logo" });
    expect(deps.fetchLogo).toHaveBeenCalledWith(eco.logo);
    expect(deps.fetchCover).not.toHaveBeenCalled();
  });

  it("falls back to a deterministic cover when the logo is not an image (a web page, a dead link)", async () => {
    const deps = {
      fetchLogo: vi.fn().mockResolvedValue(null),
      fetchCover: vi.fn().mockResolvedValue(cover),
    };
    expect(await resolveStationArt(eco, "Israel", deps)).toEqual({ bytes: cover, source: "cover" });
    expect(deps.fetchCover).toHaveBeenCalledWith({
      artist: "Israel",
      title: "Eco 99",
      label: COVER_LABEL,
      cat: "99.0 FM",
    });
  });

  it("skips the logo step for stations without one and leaves the catalogue number empty without an FM frequency", async () => {
    const deps = { fetchLogo: vi.fn(), fetchCover: vi.fn().mockResolvedValue(cover) };
    expect(await resolveStationArt(bob, "Music", deps)).toEqual({ bytes: cover, source: "cover" });
    expect(deps.fetchLogo).not.toHaveBeenCalled();
    expect(coverParamsFor(bob, "Music")).toEqual({
      artist: "Music",
      title: "Radio BOB",
      label: COVER_LABEL,
      cat: "",
    });
  });

  it("marks the cover as a stand-in when the logo fetch failed transiently (rate limit), so it is not kept", async () => {
    const deps = {
      fetchLogo: vi.fn().mockRejectedValue(new Error("429")),
      fetchCover: vi.fn().mockResolvedValue(cover),
    };
    expect(await resolveStationArt(eco, "Israel", deps)).toEqual({
      bytes: cover,
      source: "cover",
      logoTransient: true,
    });
    // A definitive non-image (HTML page) is a plain cover result: nothing to retry.
    const final = {
      fetchLogo: vi.fn().mockResolvedValue(null),
      fetchCover: vi.fn().mockResolvedValue(cover),
    };
    expect(await resolveStationArt(eco, "Israel", final)).toEqual({
      bytes: cover,
      source: "cover",
    });
  });

  it("answers null (no artUrl, HA placeholder) when neither the logo nor cover-forge produce an image", async () => {
    const deps = {
      fetchLogo: vi.fn().mockResolvedValue(null),
      fetchCover: vi.fn().mockResolvedValue(null),
    };
    expect(await resolveStationArt(eco, "Israel", deps)).toBeNull();
    const throwing = {
      fetchLogo: vi.fn().mockRejectedValue(new Error("boom")),
      fetchCover: vi.fn().mockRejectedValue(new Error("down")),
    };
    expect(await resolveStationArt(eco, "Israel", throwing)).toBeNull();
  });
});
