// The "connecting" frame for the battery saver. While the Kindle's Wi-Fi radio is off, a key press takes several
// seconds to reach the bridge (the radio has to come back first). So the Kindle fetches this frame before it switches
// the radio off: the frame it is showing, plus the app's "connecting" badge. It draws that the instant a key is
// pressed, from its own storage, then reconnects.
import crypto from "node:crypto";
import sharp from "sharp";

/** The panel frame (8-bit grayscale PNG) with the badge (a PNG screenshot of the badge's box) laid over it. */
export async function composeConnecting(frameBuf, badgePng, box) {
  const meta = await sharp(frameBuf).metadata();
  const left = Math.max(0, Math.min(Math.round(box.x), meta.width - 1));
  const top = Math.max(0, Math.min(Math.round(box.y), meta.height - 1));
  const width = Math.min(Math.round(box.width), meta.width - left);
  const height = Math.min(Math.round(box.height), meta.height - top);
  const badge = await sharp(badgePng)
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .png()
    .toBuffer();
  // Composite in RGB (a single-channel base drops a colour overlay), then back to the panel's 8-bit gray.
  const rgb = await sharp(frameBuf).toColourspace("srgb").png().toBuffer();
  // sharp composites last in a pipeline, so the gray conversion needs a pipeline of its own.
  const laid = await sharp(rgb)
    .composite([{ input: badge, left, top }])
    .png()
    .toBuffer();
  const buf = await sharp(laid)
    .grayscale()
    .toColourspace("b-w")
    .removeAlpha()
    .png({ palette: false, compressionLevel: 9 }) // eips draws 8-bit single-channel PNGs only
    .toBuffer();
  return { buf, etag: crypto.createHash("md5").update(buf).digest("hex") };
}
