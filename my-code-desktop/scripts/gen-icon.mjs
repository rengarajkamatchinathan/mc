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

// Glyphs traced from Menlo Bold — same path data as renderer/src/components/Logo.tsx.
const SLASH_PATH = "M34.8 37.0H40.9L19.4 83.0H13.3Z";
const LETTERS_PATH =
  "M62.8 50.3Q63.7 48.3 65.1 47.4Q66.5 46.5 68.5 46.5Q72.5 46.5 74.0 49.2Q75.5 51.9 75.5 60.6V77.8H69.0V58.2Q69.0 54.7 68.4 53.6Q67.9 52.4 66.6 52.4Q65.2 52.4 64.6 53.6Q64.1 54.8 64.1 58.2V77.8H57.6V58.2Q57.6 54.8 57.1 53.6Q56.5 52.4 55.2 52.4Q53.8 52.4 53.3 53.6Q52.8 54.7 52.8 58.2V77.8H46.2V47.2H52.0V50.4Q52.7 48.6 54.2 47.5Q55.7 46.5 57.6 46.5Q59.4 46.5 61.0 47.6Q62.5 48.7 62.8 50.3ZM106.7 76.3Q104.7 77.4 102.3 78.0Q100.0 78.6 97.3 78.6Q90.2 78.6 86.2 74.3Q82.3 70.1 82.3 62.5Q82.3 55.0 86.3 50.7Q90.3 46.4 97.4 46.4Q99.8 46.4 102.1 47.0Q104.4 47.5 106.7 48.7V56.1Q104.9 54.6 102.8 53.8Q100.7 53.0 98.5 53.0Q94.6 53.0 92.5 55.4Q90.4 57.9 90.4 62.5Q90.4 67.1 92.5 69.6Q94.6 72.0 98.5 72.0Q100.8 72.0 102.8 71.3Q104.9 70.5 106.7 68.9Z";

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
    <path d="${SLASH_PATH}" fill="#d97757" stroke="#d97757" stroke-width="1.4"/>
    <path d="${LETTERS_PATH}" fill="#f0eee6" stroke="#f0eee6" stroke-width="1.4"/>
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
