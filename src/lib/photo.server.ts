// Server-only screensaver photo helpers: choose a favorite (portrait preferred) and crop it to 600x800.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export type PhotoAsset = {
  id: string;
  exifInfo?: {
    exifImageWidth?: number | null;
    exifImageHeight?: number | null;
    orientation?: string | number | null;
  } | null;
};

export const SCREEN_W = 600;
export const SCREEN_H = 800;
export const PORTRAIT_WEIGHT = 3;

/** true = portrait, false = landscape or square, null = dimensions unknown. EXIF orientations 5 to 8 swap width and height. */
export function isPortrait(asset: PhotoAsset): boolean | null {
  const exif = asset.exifInfo;
  const w = exif?.exifImageWidth;
  const h = exif?.exifImageHeight;
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return null;
  const orientation = Number(exif?.orientation);
  const swapped = orientation >= 5 && orientation <= 8;
  const width = swapped ? h : w;
  const height = swapped ? w : h;
  return height > width;
}

/**
 * Weighted random pick: portrait counts PORTRAIT_WEIGHT times, others once. Avoids `previous` when
 * there is a choice. `exclude` (kept photos) leaves the pool unless it would empty it, so the
 * screensaver keeps showing something once every favourite has been judged. `skipped` (F4) never
 * comes back; undefined when everything left is skipped.
 */
export function pickAsset<T extends PhotoAsset>(
  items: T[],
  previous: string | null,
  random: () => number = Math.random,
  exclude: ReadonlySet<string> = new Set(),
  skipped: ReadonlySet<string> = new Set(),
): T | undefined {
  const allowed = items.filter((a) => !skipped.has(a.id));
  const unjudged = allowed.filter((a) => !exclude.has(a.id));
  const candidates = unjudged.length ? unjudged : allowed;
  if (!candidates.length) return undefined;
  const pool = candidates.length > 1 ? candidates.filter((a) => a.id !== previous) : candidates;
  const weights = pool.map((a) => (isPortrait(a) === true ? PORTRAIT_WEIGHT : 1));
  let roll = random() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i] ?? 1;
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Apply EXIF rotation, cover-crop around the most interesting area, grayscale, JPEG. */
export async function cropToScreen(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input)
    .rotate()
    .resize(SCREEN_W, SCREEN_H, { fit: "cover", position: "attention" })
    .grayscale()
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ---- "Looks good on e-ink" marks ----
// The user presses F1 on the screensaver to mark a photo that dithers well (keep) and F4 to never see it again
// (skip). Without Home Assistant photos (no kindle_panel config, or HA gives no photo and the app falls back to its
// own Immich) the marks are kept in MEDIA_STATE_DIR/kindle-photo-marks.json (the app-data bind mount): kept ids
// leave the random pool so each favourite is judged once, skipped ids never come back. With HA photos the marks
// live in HA (kindle_panel) instead; see home.functions.ts for which store a mark goes to.

export type PhotoMark = { id: string; at: string };
export type PhotoMarks = { marked: PhotoMark[]; skipped: PhotoMark[] };

export const marksFile = () =>
  path.join(
    (process.env["MEDIA_STATE_DIR"] ?? "").trim() || os.tmpdir(),
    "kindle-photo-marks.json",
  );

const validMarks = (list: unknown): PhotoMark[] =>
  (Array.isArray(list) ? list : []).filter(
    (m): m is PhotoMark => !!m && typeof m.id === "string" && typeof m.at === "string",
  );

export async function loadMarks(file = marksFile()): Promise<PhotoMarks> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<
      Record<keyof PhotoMarks, unknown>
    >;
    return { marked: validMarks(raw.marked), skipped: validMarks(raw.skipped) };
  } catch {
    return { marked: [], skipped: [] };
  }
}

/** Stores `id` as kept (F1, default) or skipped (F4); a photo is in one list at most. Returns the kept total. */
export async function addMark(
  id: string,
  file = marksFile(),
  now = new Date(),
  verdict: "keep" | "skip" = "keep",
): Promise<number> {
  const marks = await loadMarks(file);
  const [into, other] =
    verdict === "skip" ? (["skipped", "marked"] as const) : (["marked", "skipped"] as const);
  marks[other] = marks[other].filter((m) => m.id !== id);
  if (!marks[into].some((m) => m.id === id)) marks[into].push({ id, at: now.toISOString() });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(marks, null, 1), "utf8");
  return marks.marked.length;
}

export const markedIds = (marks: PhotoMarks) => new Set(marks.marked.map((m) => m.id));
export const skippedIds = (marks: PhotoMarks) => new Set(marks.skipped.map((m) => m.id));

/** Remembers which picker served the last few photos, so F1 / F4 go to the store that picker filters on and counts:
 *  "ha" = Home Assistant (kindle_panel), "local" = the marks file. Unknown ids (the app restarted since the photo was
 *  shown) follow the configured source. */
export class MarkRouter {
  private readonly served = new Map<string, "ha" | "local">();
  constructor(private readonly keep = 16) {}
  remember(id: string | null, via: "ha" | "local") {
    if (!id) return;
    this.served.delete(id);
    this.served.set(id, via);
    while (this.served.size > this.keep) {
      const oldest = this.served.keys().next().value;
      if (oldest === undefined) break;
      this.served.delete(oldest);
    }
  }
  storeFor(id: string, haActive: boolean): "ha" | "local" {
    return this.served.get(id) ?? (haActive ? "ha" : "local");
  }
}
