import React from "react";

/** Reactive states that drive the /mc mark's slash spinner, glow, and breathing. */
export type MascotMood = "idle" | "thinking" | "streaming" | "tool" | "error";

/**
 * The my-code "/mc" mark — the app as a slash command, in Claude Code's
 * wardrobe: a terracotta slash and cream lowercase "mc" in monospace. The
 * glyphs are traced from Menlo Bold and embedded as path data, so nothing
 * depends on fonts at runtime and the mark is identical on every platform.
 * `tile` draws the warm-charcoal rounded app-icon background.
 *
 * When `mood` is set the mark is wrapped in a `.sentinel` shell and CSS
 * animates it like a terminal: idle = breathe + the slash pulses like a
 * resting cursor, thinking/tool = the slash tick-rotates like the ASCII
 * spinner (| / - \), streaming = the slash warms up, error = red strobe.
 * All motion is transform/opacity only, so it stays on the compositor and
 * costs nothing on the main thread. Omit `mood` for a static mark.
 */

const SMALL_PX = 28;

/** "/" from Menlo Bold, centered with natural advances in the 120 viewBox. */
const SLASH_PATH = "M34.8 37.0H40.9L19.4 83.0H13.3Z";

/** "mc" from Menlo Bold, same metrics. */
const LETTERS_PATH =
  "M62.8 50.3Q63.7 48.3 65.1 47.4Q66.5 46.5 68.5 46.5Q72.5 46.5 74.0 49.2Q75.5 51.9 75.5 60.6V77.8H69.0V58.2Q69.0 54.7 68.4 53.6Q67.9 52.4 66.6 52.4Q65.2 52.4 64.6 53.6Q64.1 54.8 64.1 58.2V77.8H57.6V58.2Q57.6 54.8 57.1 53.6Q56.5 52.4 55.2 52.4Q53.8 52.4 53.3 53.6Q52.8 54.7 52.8 58.2V77.8H46.2V47.2H52.0V50.4Q52.7 48.6 54.2 47.5Q55.7 46.5 57.6 46.5Q59.4 46.5 61.0 47.6Q62.5 48.7 62.8 50.3ZM106.7 76.3Q104.7 77.4 102.3 78.0Q100.0 78.6 97.3 78.6Q90.2 78.6 86.2 74.3Q82.3 70.1 82.3 62.5Q82.3 55.0 86.3 50.7Q90.3 46.4 97.4 46.4Q99.8 46.4 102.1 47.0Q104.4 47.5 106.7 48.7V56.1Q104.9 54.6 102.8 53.8Q100.7 53.0 98.5 53.0Q94.6 53.0 92.5 55.4Q90.4 57.9 90.4 62.5Q90.4 67.1 92.5 69.6Q94.6 72.0 98.5 72.0Q100.8 72.0 102.8 71.3Q104.9 70.5 106.7 68.9Z";

const SLASH = "#d97757";
const CREAM = "#f0eee6";

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
  // below SMALL_PX, a same-color stroke fattens the glyphs so the thin
  // monospace stems survive title-bar sizes
  const fatten = size < SMALL_PX ? 2 : 0;
  const svg = (
    <svg
      className={mood ? undefined : className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="my-code"
    >
      {tile && <rect width="120" height="120" rx="28" fill="#201e19" />}
      <path
        className="mc-slash"
        d={SLASH_PATH}
        fill={SLASH}
        stroke={fatten ? SLASH : undefined}
        strokeWidth={fatten || undefined}
      />
      <path
        className="mc-letters"
        d={LETTERS_PATH}
        fill={CREAM}
        stroke={fatten ? CREAM : undefined}
        strokeWidth={fatten || undefined}
      />
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
