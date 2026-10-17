// Builds kindle/connecting.png: the picture the Kindle draws by itself the instant a key wakes its Wi-Fi radio
// (battery saver). A full 600x800 frame (white, the 200x200 icon centred), 8-bit grayscale (eips draws nothing
// else), no text (any language). Full frame because this Kindle 4's `eips -g` (firmware 4.1.4) ignores -x/-y: with
// them it draws nothing, without them the image lands top-left (Q16). The reconnect redraw replaces it.
// Run: node scripts/make-connecting-icon.mjs
import sharp from "sharp";

const W = 600;
const H = 800;
const ICON = 200;
// Language-neutral icon: black rounded tile, white Wi-Fi arcs and a dot.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff"/>
  <g transform="translate(${(W - ICON) / 2} ${(H - ICON) / 2})">
    <rect x="2" y="2" width="196" height="196" rx="28" fill="#000" stroke="#fff" stroke-width="4"/>
    <g fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round">
      <path d="M40 92 a85 85 0 0 1 120 0"/>
      <path d="M62 114 a54 54 0 0 1 76 0"/>
      <path d="M84 136 a23 23 0 0 1 32 0"/>
    </g>
    <circle cx="100" cy="158" r="8" fill="#fff"/>
  </g>
</svg>`;
const out = process.argv[2] ?? "kindle/connecting.png";
await sharp(Buffer.from(svg))
  .flatten({ background: "#ffffff" })
  .grayscale()
  .toColourspace("b-w")
  .png({ palette: false, compressionLevel: 9 })
  .toFile(out);
const m = await sharp(out).metadata();
console.log(m.width, m.height, m.channels, m.depth);
