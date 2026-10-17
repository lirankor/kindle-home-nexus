// The battery saver's "connecting" picture (Q16, docs/battery-saver-plan.md): the frame the Kindle shows, with a
// language-neutral Wi-Fi badge composited in the middle. The client downloads it right before it switches its radio
// off and draws it with a PARTIAL e-ink update the instant a key wakes it: the picture is the frame on the panel plus
// the badge, so to the eye only the badge appears (this Kindle 4's eips cannot overlay an image any other way: `-g`
// always redraws the whole screen, alpha comes out blank, -x/-y draw nothing). Works for any frame, cached per ETag.
import crypto from "node:crypto";
import sharp from "sharp";

export const BADGE = 216; // white ring (8 px) around the project's 200x200 icon tile
// Black rounded tile, white Wi-Fi arcs and a dot (the icon of the removed scripts/make-connecting-icon.mjs), on a
// white ring so it stands out on dark photos as well as on white pages. No text: any language.
const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE}" height="${BADGE}" viewBox="0 0 ${BADGE} ${BADGE}">
  <rect width="${BADGE}" height="${BADGE}" rx="36" fill="#fff"/>
  <g transform="translate(8 8)">
    <rect x="2" y="2" width="196" height="196" rx="28" fill="#000"/>
    <g fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round">
      <path d="M40 92 a85 85 0 0 1 120 0"/>
      <path d="M62 114 a54 54 0 0 1 76 0"/>
      <path d="M84 136 a23 23 0 0 1 32 0"/>
    </g>
    <circle cx="100" cy="158" r="8" fill="#fff"/>
  </g>
</svg>`;

// Rendered once per size: an RGBA PNG, so the ring's rounded corners stay transparent (the frame shows through).
const badges = new Map();
function badge(size) {
  if (!badges.has(size))
    badges.set(
      size,
      sharp(Buffer.from(badgeSvg)).resize(size, size).ensureAlpha().png().toBuffer(),
    );
  return badges.get(size);
}

// The badge-free frame PNG -> the same frame with the badge centred. 8-bit single-channel PNG like every frame the
// bridge serves (eips draws nothing else). Pixels outside the badge are byte-identical to the input.
export async function composeConnecting(frameBuf) {
  const { width, height } = await sharp(frameBuf).metadata();
  const size = Math.min(BADGE, width, height);
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  return sharp(frameBuf)
    .composite([{ input: await badge(size), left, top }])
    .flatten({ background: "#ffffff" })
    .grayscale()
    .toColourspace("b-w")
    .removeAlpha()
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}

// Remembers the last few frames by ETag (so the client gets the badge for the frame it actually has on the panel,
// even after the bridge took a newer screenshot) and their badge variants.
export function createConnectingStore({ max = 8 } = {}) {
  const frames = new Map(); // etag -> buf
  const variants = new Map(); // etag -> Promise<{ buf, etag, of }>
  const trim = (m) => {
    while (m.size > max) m.delete(m.keys().next().value);
  };
  return {
    remember(frame) {
      if (!frame?.etag || frames.has(frame.etag)) return;
      frames.set(frame.etag, frame.buf);
      trim(frames);
    },
    has: (etag) => frames.has(etag),
    // The badge variant of the frame with this ETag, or null when the bridge no longer has that frame.
    variant(etag) {
      const buf = frames.get(etag);
      if (!buf) return null;
      let v = variants.get(etag);
      if (!v) {
        v = composeConnecting(buf).then((out) => ({
          buf: out,
          etag: crypto.createHash("md5").update(out).digest("hex"),
          of: etag,
        }));
        v.catch(() => variants.delete(etag));
        variants.set(etag, v);
        trim(variants);
      }
      return v;
    },
  };
}

// GET /screen.png?connecting=1[&of=<frame etag>][&etag=<badge etag>] -> { status, headers, body }.
// of = the ETag of the frame the client has on its panel (default: the current frame); 404 when the bridge no longer
// has it (busybox wget fails, the client falls back to its text label). etag = the badge variant the client already
// holds: an empty 200, like /screen.png. X-Frame-ETag names the frame the badge was composited on.
export async function connectingResponse(store, latest, params) {
  const of = params.get("of") || latest?.etag || "";
  const pending = of ? store.variant(of) : null;
  if (!pending)
    return { status: 404, headers: { "Content-Type": "text/plain" }, body: "unknown frame\n" };
  const v = await pending;
  const headers = {
    "Content-Type": "image/png",
    ETag: v.etag,
    "X-Frame-ETag": v.of,
    "Cache-Control": "no-store",
  };
  if (params.get("etag") === v.etag)
    return {
      status: 200,
      headers: { ...headers, "Content-Length": 0, "X-Unchanged": "1" },
      body: "",
    };
  return { status: 200, headers: { ...headers, "Content-Length": v.buf.length }, body: v.buf };
}
