// Screensaver photos through Home Assistant (the kindle_panel integration): HA picks from the configured sources
// (Immich favourites through HA's Immich connection, any media-browser folder), honouring the panel's F1 keep /
// F4 skip marks, which HA stores. The panel fetches the image from HA with its token and crops it to the screen.
import { HomeError, ha } from "./home.server";
import { cropToScreen } from "./photo.server";

/** HA answered, but had no photo to give (no sources yet, Immich not loaded in HA, everything skipped). */
export class NoHaPhoto extends HomeError {
  constructor(
    message: string,
    readonly candidates: number,
  ) {
    super(message);
  }
}

type PickAnswer = {
  photo: { id: string; url: string; title: string; source: string; kept: boolean } | null;
  reason?: string;
  candidates?: number;
  kept?: number;
};

export const haPhotosActive = (cfg: {
  source: string;
  config: { screensaver: { sources: unknown[] } };
}) => cfg.source === "ha" && cfg.config.screensaver.sources.length > 0;

const base = () =>
  (process.env["HA_BASE_URL"] ?? "").trim().replace(/\/+$/, "") ||
  "http://host.docker.internal:8123";

async function call<T>(service: string, data: Record<string, unknown>): Promise<T> {
  const r = await ha<{ service_response?: T }>(
    "POST",
    `/api/services/kindle_panel/${service}?return_response`,
    data,
    20_000,
  );
  if (r.service_response === undefined)
    throw new HomeError(`kindle_panel.${service} gave no answer`);
  return r.service_response;
}

/** An HA-relative path, or an absolute http(s) URL; anything else is refused. */
export function photoUrl(raw: string): string {
  if (raw.startsWith("/") && !raw.startsWith("//")) return `${base()}${raw}`;
  const u = new URL(raw); // throws on garbage
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new HomeError(`photo URL scheme ${u.protocol}`);
  return u.toString();
}

export const sameOrigin = (url: string) => new URL(url).origin === new URL(base()).origin;

export async function haPickPhoto(previous: string | null) {
  const r = await call<PickAnswer>("pick_photo", previous ? { previous_id: previous } : {});
  if (!r.photo) throw new NoHaPhoto(r.reason ?? "no photo", r.candidates ?? 0);
  const url = photoUrl(r.photo.url);
  const res = await fetch(url, {
    // The HA token only ever goes to HA itself; a source that resolves to another host gets no credentials.
    // (and no redirect is followed with it).
    ...(sameOrigin(url)
      ? {
          headers: { Authorization: `Bearer ${(process.env["HA_TOKEN"] ?? "").trim()}` },
          redirect: "error" as const,
        }
      : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HomeError(`photo ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  let image: string;
  try {
    image = `data:image/jpeg;base64,${(await cropToScreen(raw)).toString("base64")}`;
  } catch {
    const type = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    image = `data:${type};base64,${raw.toString("base64")}`;
  }
  return { image, assetId: r.photo.id, marked: r.kept ?? 0 };
}

export async function haMarkPhoto(id: string, verdict: "keep" | "skip"): Promise<number> {
  const r = await call<{ kept: number; skipped: number }>("mark_photo", { photo_id: id, verdict });
  return r.kept;
}
