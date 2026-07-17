import React from "react";

/**
 * Single inline-SVG icon set for the whole app — consistent 24-grid, stroke
 * icons that inherit `currentColor`. Use one system everywhere instead of
 * emoji/Unicode glyphs so sizes and baselines stay uniform.
 */
export type IconName =
  | "menu" | "close" | "minimize" | "maximize" | "plus" | "send" | "stop"
  | "chevronDown" | "chevronUp" | "chevronRight" | "check" | "trash" | "edit"
  | "more" | "spinner" | "sparkle" | "dot" | "search" | "folder" | "layers"
  | "sliders" | "plug" | "puzzle" | "user" | "mic" | "book" | "external"
  | "sun" | "circleCheck" | "terminal" | "globe" | "eye" | "copy" | "retry"
  | "home" | "code" | "clock" | "box" | "panel";

const STROKE: Partial<Record<IconName, string>> = {
  menu: "M3 6h18 M3 12h18 M3 18h18",
  close: "M5 5l14 14 M19 5L5 19",
  minimize: "M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  check: "M4 12l5 5L20 6",
  send: "M12 20V5 M6 11l6-6 6 6",
  trash: "M4 7h16 M6 7l1 13h10l1-13 M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16z",
  search: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M20 20l-4-4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  sliders: "M4 21v-6 M4 11V3 M12 21v-9 M12 8V3 M20 21v-4 M20 13V3 M2 15h4 M10 8h4 M18 17h4",
  plug: "M12 22v-5 M9 8V2 M15 8V2 M7 8h10v3a5 5 0 0 1-10 0z",
  puzzle: "M10 3h4v3a2 2 0 0 0 4 0V3h0a2 2 0 0 1 2 2v3a2 2 0 0 1 0 4v3a2 2 0 0 1-2 2h-3a2 2 0 0 0-4 0H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V5a2 2 0 0 1 2-2h5",
  user: "M4 20a8 8 0 0 1 16 0 M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z M6 3v16",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
  spinner: "M12 3a9 9 0 1 0 9 9",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  terminal: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2.5-3 2.5 M13 15h4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 12h18 M12 3c2.5 2.5 2.5 15.5 0 18 M12 3c-2.5 2.5-2.5 15.5 0 18",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  copy: "M9 9h10v10H9z M5 15V5h10",
  retry: "M4 12a8 8 0 1 0 2.3-5.6 M4 4v4h4",
  home: "M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
  code: "M8.5 7L4 12l4.5 5 M15.5 7L20 12l-4.5 5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 8v4.5l3 3",
  box: "M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z M3 7.5l9 4.5 9-4.5 M12 12v9",
  panel: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M9 4v16",
};

const FILL: Partial<Record<IconName, React.ReactNode>> = {
  maximize: <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  dot: <circle cx="12" cy="12" r="5" />,
  sparkle: <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />,
  more: <g><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></g>,
  circleCheck: <g fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></g>,
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}): React.ReactElement {
  const filled = FILL[name];
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled && name !== "circleCheck" && name !== "maximize" ? "currentColor" : "none"}
      stroke={filled ? undefined : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      {filled ?? <path d={STROKE[name] ?? ""} />}
    </svg>
  );
}

/** Small colored Microsoft mark for the built-in connector (intentional brand, not emoji). */
export function MicrosoftMark({ size = 16 }: { size?: number }): React.ReactElement {
  const h = size / 2 - 0.5;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: "block", flex: "0 0 auto" }}>
      <rect x="1" y="1" width={h * 2} height={h * 2} fill="#f25022" />
      <rect x={10.5} y="1" width={h * 2} height={h * 2} fill="#7fba00" />
      <rect x="1" y={10.5} width={h * 2} height={h * 2} fill="#00a4ef" />
      <rect x={10.5} y={10.5} width={h * 2} height={h * 2} fill="#ffb900" />
    </svg>
  );
}
