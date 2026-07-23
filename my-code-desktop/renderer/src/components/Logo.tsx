import React from "react";

/** Reactive states that drive the /mc mark's spin, glow, and breathing. */
export type MascotMood = "idle" | "thinking" | "streaming" | "tool" | "error";

/**
 * The my-code mark — the "Chevron Trine": three terracotta code-chevrons
 * pinwheeling around a shared center. It carries the forward-motion of a
 * slash-command without being a literal glyph, and its three-fold symmetry
 * means a 120° rotation reads as a full turn — which is what the spin states
 * exploit. The mark is pure stroked geometry, so it stays razor-sharp at any
 * size and recolors from a single CSS custom property. `tile` draws the
 * warm-charcoal rounded app-icon background.
 *
 * When `mood` is set the mark is wrapped in a `.sentinel` shell and CSS
 * animates it like a terminal: idle = the halo breathes + the trine pulses at
 * rest, thinking/tool = the trine tick-rotates in 8 steps like the ASCII
 * spinner (tool is the fast one), streaming = a smooth continuous flow with
 * the chevrons warmed up, error = red strobe. Motion lives on the inner
 * `.trine` group and the `.halo` layer — never the `<svg>` element itself,
 * which would composite a cached raster and soften the strokes. Omit `mood`
 * for a static mark.
 */

const SMALL_PX = 28;

/** One chevron pointing right, sized for the 120 viewBox, centered on 60,60. */
const CHEVRON = "M56.4 39.6 L76.8 60 L56.4 80.4";
const ANGLES = [0, 120, 240];

// Static fallback only — styles.css overrides this (the trine follows the
// theme accent via --accent-hover, and brightens/goes red per mood).
const ACCENT = "#d97757";

export function Logo({
  size = 32,
  tile = false,
  className,
  mood,
}: {
  size?: number;
  tile?: boolean;
  className?: string;
  mood?: MascotMood;
}): React.ReactElement {
  // fatten the strokes at title-bar / favicon sizes so the chevrons stay legible
  const stroke = size < SMALL_PX ? 13 : 10;
  const svg = (
    <svg
      className={mood ? undefined : className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="my-code"
      data-tile={tile ? "" : undefined}
    >
      {tile && <rect width="120" height="120" rx="28" fill="#201e19" />}
      <g className="trine">
        {ANGLES.map((a) => (
          <path
            key={a}
            className="mc-chev"
            d={CHEVRON}
            transform={`rotate(${a} 60 60)`}
            fill="none"
            stroke={ACCENT}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );

  if (!mood) return svg;
  return (
    <span
      className={`sentinel sentinel-${mood} ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <span className="halo" aria-hidden="true" />
      {svg}
    </span>
  );
}
