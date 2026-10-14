// Which picture a radio station gets, in order: the catalogue logo when it really is an image, else a generated
// placeholder cover from cover-forge (deterministic per station), else nothing — Home Assistant then shows its
// placeholder and the Kindle its glyph, never a broken image. Pure: the two fetchers are injected, so the chain is
// unit-tested without the network (media.server.ts wires the real ones and the disk cache).
export type StationArtSource = "logo" | "cover";
export type StationArtResult = {
  bytes: Buffer;
  source: StationArtSource;
  /** The cover stands in for a logo whose fetch failed transiently (rate limit, timeout): do not keep it. */
  logoTransient?: true;
};
export type StationLike = { id: string; name: string; fm: number | null; logo: string | null };
/** cover-forge's metadata fields (its hash of artist + title picks the colours and layout). */
export type CoverParams = { artist: string; title: string; label: string; cat: string };
export type StationArtDeps = {
  /** Catalogue logo URL -> image bytes; null when it is definitely not an image (an HTML page, a dead link);
   *  THROWS when the failure is transient (429, 5xx, timeout) so the cover is only a stand-in. */
  fetchLogo: (url: string) => Promise<Buffer | null>;
  /** cover-forge render; null when it is not configured, down, or answers something other than an image. */
  fetchCover: (params: CoverParams) => Promise<Buffer | null>;
};

export const COVER_LABEL = "Internet radio";

/** title = the station, artist = its band ("Israel", "Düsseldorf", …), cat = the FM frequency when it has one. */
export function coverParamsFor(station: StationLike, bandLabel: string): CoverParams {
  return {
    artist: bandLabel,
    title: station.name,
    label: COVER_LABEL,
    cat: station.fm !== null ? `${station.fm.toFixed(1)} FM` : "",
  };
}

export async function resolveStationArt(
  station: StationLike,
  bandLabel: string,
  deps: StationArtDeps,
): Promise<StationArtResult | null> {
  let logoTransient = false;
  if (station.logo) {
    try {
      const bytes = await deps.fetchLogo(station.logo);
      if (bytes) return { bytes, source: "logo" };
    } catch {
      logoTransient = true;
    }
  }
  const cover = await deps.fetchCover(coverParamsFor(station, bandLabel)).catch(() => null);
  if (!cover) return null;
  return logoTransient
    ? { bytes: cover, source: "cover", logoTransient: true }
    : { bytes: cover, source: "cover" };
}
