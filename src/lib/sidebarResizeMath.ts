export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function computeSidebarWidthExpanded(
  startWidth: number,
  startClientX: number,
  clientX: number,
  minWidth: number,
  maxWidth: number
): number {
  const dx = clientX - startClientX;
  const raw = Math.round(startWidth + dx);
  return clamp(raw, minWidth, maxWidth);
}
