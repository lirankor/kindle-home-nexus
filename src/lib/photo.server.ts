// Server-only screensaver photo helpers: choose a favorite (portrait preferred) and crop it to 600x800.
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

/** Weighted random pick: portrait counts PORTRAIT_WEIGHT times, others once. Avoids `previous` when there is a choice. */
export function pickAsset<T extends PhotoAsset>(
  items: T[],
  previous: string | null,
  random: () => number = Math.random,
): T | undefined {
  const pool = items.length > 1 ? items.filter((a) => a.id !== previous) : items;
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
