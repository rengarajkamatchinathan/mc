// Rasterize the /mc mark into the icon set used by Electron.
//
// Two pieces of art come out of here:
//   build/logo.svg (in repo)  — full-bleed rounded tile. In-app + Windows, where
//                               taskbar icons are expected to fill the canvas.
//     → build/logo-<n>.png, build/icon.ico
//   build/icon-macos.svg      — composed below: the tile drawn as a superellipse
//                               at 80% of the canvas with ~10% transparent margin
//                               per side, matching Apple's icon grid. Full-bleed
//                               art renders oversized and square-cornered in the
//                               Dock next to every other app.
//     → build/icon.png (1024) — electron-builder derives the .icns from this.
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The Chevron Trine — three code-chevrons pinwheeling about the 120-viewBox
// center (60,60). Same geometry as renderer/src/components/Logo.tsx; here the
// strokes are drawn as three rotated <path>s inside a group.
const CHEVRON = "M56.4 39.6 L76.8 60 L56.4 80.4";
const trine = (color, width) =>
  [0, 120, 240]
    .map(
      (a) =>
        `<path d="${CHEVRON}" transform="rotate(${a} 60 60)" fill="none" ` +
        `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");

// Superellipse |x/a|^n + |y/a|^n = 1 — Apple's squircle, not a rounded rect.
function squircle(cx, cy, size, n = 4.8) {
  const a = size / 2;
  const pts = [];
  const STEPS = 128;
  for (let i = 0; i < STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = cx + Math.sign(c) * a * Math.abs(c) ** (2 / n);
    const y = cy + Math.sign(s) * a * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

// The macOS icon: 96/120 squircle tile (10% margin), top-lit charcoal gradient,
// hairline inner highlight, mark scaled to 72% so it breathes inside the tile.
const macSvg = `<svg width="1024" height="1024" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c2820"/>
      <stop offset="1" stop-color="#191713"/>
    </linearGradient>
  </defs>
  <path d="${squircle(60, 60, 96)}" fill="url(#tile)"/>
  <path d="${squircle(60, 60, 93)}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.6"/>
  <g transform="translate(16.8 16.8) scale(0.72)">
    ${trine("#d97757", 10)}
  </g>
</svg>
`;

function render(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return r.render().asPng();
}

const logoSvg = readFileSync(join(root, "build", "logo.svg"), "utf8");

const sizes = [16, 32, 48, 64, 128, 256, 512];
for (const s of sizes) {
  writeFileSync(join(root, "build", `logo-${s}.png`), render(logoSvg, s));
}

writeFileSync(join(root, "build", "icon-macos.svg"), macSvg);
writeFileSync(join(root, "build", "icon.png"), render(macSvg, 1024));

const ico = await pngToIco([16, 32, 48, 64, 128, 256].map((s) => join(root, "build", `logo-${s}.png`)));
writeFileSync(join(root, "build", "icon.ico"), ico);

console.log("wrote build/icon.png (macOS, 1024 padded), build/icon.ico (Windows), and logo-*.png");
