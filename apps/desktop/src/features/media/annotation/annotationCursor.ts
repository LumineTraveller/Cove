/** Match the normalized stroke width used by the shared annotation canvas. */
export function annotationStrokeWidth(width: number, minDimension: number): number {
  return Math.max(0.0005, Math.min(0.08, width / Math.max(1, minDimension)));
}

/** Native cursor: no pointer-move React updates and no layer to obscure tools. */
export function eraserCursor(diameter: number): string {
  const safeDiameter = Math.max(1, Math.min(40, Number.isFinite(diameter) ? diameter : 1));
  const size = Math.ceil(safeDiameter) + 6;
  const center = Math.floor(size / 2);
  const stroke = Math.min(1.5, safeDiameter / 2);
  const radius = (safeDiameter - stroke) / 2;
  // The dark under-stroke keeps the white ring visible on a white shared page.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#000" stroke-opacity=".65" stroke-width="${stroke + 2}"/><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#fff" stroke-width="${stroke}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
}
