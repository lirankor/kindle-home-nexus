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
 * there is a choice. `exclude` (marked photos) leaves the pool unless it would empty it, so the
 * screensaver keeps showing something once every favourite has been judged.
 */
export function pickAsset<T extends PhotoAsset>(
  items: T[],
  previous: string | null,
  random: () => number = Math.random,
  exclude: ReadonlySet<string> = new Set(),
): T | undefined {
  const unjudged = items.filter((a) => !exclude.has(a.id));
  const candidates = unjudged.length ? unjudged : items;
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
// The user presses F1 on the screensaver to mark a photo that dithers well. Marked ids are kept in
// MEDIA_STATE_DIR/kindle-photo-marks.json (the app-data bind mount) and leave the random pool, so each
// favourite is judged once. Later, once a few hundred are marked, the pool can be the marks instead.

export type PhotoMark = { id: string; at: string };
export type PhotoMarks = { marked: PhotoMark[] };

export const marksFile = () =>
  path.join(
    (process.env["MEDIA_STATE_DIR"] ?? "").trim() || os.tmpdir(),
    "kindle-photo-marks.json",
  );

export async function loadMarks(file = marksFile()): Promise<PhotoMarks> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<PhotoMarks>;
    const marked = (raw.marked ?? []).filter(
      (m): m is PhotoMark => !!m && typeof m.id === "string" && typeof m.at === "string",
    );
    return { marked };
  } catch {
    return { marked: [] };
  }
}

/** Adds `id` (once) and returns the new total. */
export async function addMark(id: string, file = marksFile(), now = new Date()): Promise<number> {
  const marks = await loadMarks(file);
  if (!marks.marked.some((m) => m.id === id)) marks.marked.push({ id, at: now.toISOString() });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(marks, null, 1), "utf8");
  return marks.marked.length;
}

export const markedIds = (marks: PhotoMarks) => new Set(marks.marked.map((m) => m.id));
