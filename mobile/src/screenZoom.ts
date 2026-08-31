export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface ZoomTransform extends Point { scale: number }
export const ORIGINAL_ZOOM: ZoomTransform = { scale: 1, x: 0, y: 0 };

export function clampZoom(value: ZoomTransform, viewport: Size, video?: Size): ZoomTransform {
  const scale = Math.max(1, Math.min(4, value.scale));
  const fit = video && video.width > 0 && video.height > 0
    ? Math.min(viewport.width / video.width, viewport.height / video.height) : 1;
  const width = video ? video.width * fit : viewport.width;
  const height = video ? video.height * fit : viewport.height;
  const maxX = Math.max(0, (width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (height * scale - viewport.height) / 2);
  return { scale, x: maxX ? Math.max(-maxX, Math.min(maxX, value.x)) : 0, y: maxY ? Math.max(-maxY, Math.min(maxY, value.y)) : 0 };
}

export function pinchZoom(start: ZoomTransform, from: Point, to: Point, ratio: number, viewport: Size, video?: Size): ZoomTransform {
  const scale = Math.max(1, Math.min(4, start.scale * ratio));
  const factor = scale / start.scale;
  return clampZoom({ scale,
    x: to.x - viewport.width / 2 - (from.x - viewport.width / 2 - start.x) * factor,
    y: to.y - viewport.height / 2 - (from.y - viewport.height / 2 - start.y) * factor,
  }, viewport, video);
}
