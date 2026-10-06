export interface SortableRowGeometry {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 把 `from` 位置的元素移动到 `to` 位置，返回新数组。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 纵向列表：根据拖动项中心的 Y 坐标，统计有多少其它行的中线在它上方，
 * 得到新的插入索引。
 */
export function verticalTargetIndex(
  rows: readonly SortableRowGeometry[],
  draggingId: string,
  pointerCenterY: number,
): number {
  let index = 0;
  for (const row of rows) {
    if (row.id === draggingId) continue;
    if (row.top + row.height / 2 < pointerCenterY) index += 1;
  }
  return index;
}

/** 按行的 top 把网格单元聚成“行”，同一行的卡片允许插到彼此之间。 */
export function groupRowsIntoLines(rows: readonly SortableRowGeometry[]): SortableRowGeometry[][] {
  const sorted = [...rows].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: SortableRowGeometry[][] = [];
  for (const row of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].top - row.top) <= Math.max(4, row.height * 0.4)) line.push(row);
    else lines.push([row]);
  }
  return lines;
}

/**
 * 网格布局：与纵向列表同一套手感——先按指针的 Y 找到目标行（最近的一行），
 * 再在该行内统计中心位于拖动项中心左侧的卡片数得到插入索引。
 * 拖动项中心越过目标卡片中线即换位，横向与纵向的触发点保持一致。
 */
export function gridTargetIndex(
  rows: readonly SortableRowGeometry[],
  draggingId: string,
  pointX: number,
  pointY: number,
): number {
  const lines = groupRowsIntoLines(rows);
  if (!lines.length) return 0;

  let lineIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  lines.forEach((line, index) => {
    const top = Math.min(...line.map((row) => row.top));
    const bottom = Math.max(...line.map((row) => row.top + row.height));
    const distance = pointY < top ? top - pointY : pointY > bottom ? pointY - bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      lineIndex = index;
    }
  });

  let index = 0;
  for (let i = 0; i < lineIndex; i += 1) {
    for (const row of lines[i]) if (row.id !== draggingId) index += 1;
  }
  const line = lines[lineIndex].filter((row) => row.id !== draggingId);
  for (const row of line) {
    // 与 verticalTargetIndex 的严格比较保持一致：中心恰好重合时尚未越过。
    if (row.left + row.width / 2 < pointX) index += 1;
  }
  return index;
}
