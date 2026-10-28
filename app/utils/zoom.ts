export const ZOOM_LEVELS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];
export const ZOOM_WHEEL_INTERVAL = 250;

export function normalizeZoom(value: number): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
}

export function nextZoom(value: number, direction: 1 | -1): number {
  const current = normalizeZoom(value);
  return direction === 1
    ? ZOOM_LEVELS.find((level) => level > current) ?? 2
    : [...ZOOM_LEVELS].reverse().find((level) => level < current) ?? 0.5;
}

export function zoomPercent(value: number): string {
  return `${Math.round(normalizeZoom(value) * 100)}%`;
}

// Register only after native support is confirmed. Capture also handles focused
// inputs without inserting characters or triggering unrelated application keys.
export function registerZoomShortcuts(options: {
  isMac: boolean;
  getZoom: () => number;
  onZoom: (factor: number) => void;
}) {
  const change = (direction: 1 | -1 | 0) => {
    options.onZoom(
      direction === 0 ? 1 : nextZoom(options.getZoom(), direction),
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      !(options.isMac ? event.metaKey : event.ctrlKey) ||
      event.altKey ||
      event.isComposing
    )
      return;
    let direction: 1 | -1 | 0;
    if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd")
      direction = 1;
    else if (event.key === "-" || event.code === "NumpadSubtract")
      direction = -1;
    else if (event.key === "0" || event.code === "Numpad0") direction = 0;
    else return;
    event.preventDefault();
    event.stopPropagation();
    change(direction);
  };
  let lastWheel = -Infinity;
  const onWheel = (event: WheelEvent) => {
    // Trackpad pinch is reported as ctrl+wheel, including on macOS.
    if (!(event.ctrlKey || (options.isMac && event.metaKey)) || event.altKey)
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const now = performance.now();
    if (now - lastWheel < ZOOM_WHEEL_INTERVAL) return;
    lastWheel = now;
    change(event.deltaY < 0 ? 1 : -1);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("wheel", onWheel, true);
  };
}
