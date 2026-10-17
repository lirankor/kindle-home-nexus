// Builds kindle/connecting.png: the icon the Kindle draws by itself, in the middle of the screen, the instant a key
// wakes its Wi-Fi radio (battery saver). 200x200, 8-bit grayscale (eips draws nothing else), no text (any language).
// Run: node scripts/make-connecting-icon.mjs
import sharp from "sharp";
// 200x200, language-neutral: black rounded tile, white Wi-Fi arcs, three dots ("…").
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect x="2" y="2" width="196" height="196" rx="28" fill="#000" stroke="#fff" stroke-width="4"/>
  <g fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round">
    <path d="M40 92 a85 85 0 0 1 120 0"/>
    <path d="M62 114 a54 54 0 0 1 76 0"/>
    <path d="M84 136 a23 23 0 0 1 32 0"/>
  </g>
  <circle cx="100" cy="158" r="8" fill="#fff"/>
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
