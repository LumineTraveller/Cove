import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gridTargetIndex,
  groupRowsIntoLines,
  moveItem,
  verticalTargetIndex,
  type SortableRowGeometry,
} from '../src/features/sorting/sortableList';

const rows: SortableRowGeometry[] = [
  { id: 'a', top: 0, left: 0, width: 200, height: 50 },
  { id: 'b', top: 56, left: 0, width: 200, height: 50 },
  { id: 'c', top: 112, left: 0, width: 200, height: 50 },
];

const grid: SortableRowGeometry[] = [
  { id: 'a', top: 0, left: 0, width: 100, height: 80 },
  { id: 'b', top: 0, left: 110, width: 100, height: 80 },
  { id: 'c', top: 0, left: 220, width: 100, height: 80 },
  { id: 'd', top: 90, left: 0, width: 100, height: 80 },
  { id: 'e', top: 90, left: 110, width: 100, height: 80 },
  { id: 'f', top: 90, left: 220, width: 100, height: 80 },
];

test('moveItem moves forward, backward and keeps same index untouched', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});

test('moveItem ignores out-of-range indexes', () => {
  assert.deepEqual(moveItem(['a', 'b'], -1, 0), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
});

test('verticalTargetIndex derives the insertion index from the pointer center', () => {
  assert.equal(verticalTargetIndex(rows, 'b', 10), 0);
  assert.equal(verticalTargetIndex(rows, 'b', 30), 1);
  assert.equal(verticalTargetIndex(rows, 'b', 200), 2);
  assert.equal(verticalTargetIndex(rows, 'a', 125), 1);
});

test('groupRowsIntoLines groups grid cards into visual rows', () => {
  const lines = groupRowsIntoLines([...grid].reverse());
  assert.deepEqual(lines.map((line) => line.map((row) => row.id)), [
    ['a', 'b', 'c'],
    ['d', 'e', 'f'],
  ]);
});

test('gridTargetIndex swaps when the dragged center crosses the target midline', () => {
  // 卡片中心：a=50、b=160、c=270（d/e/f 同列位）。判定与纵向一致：
  // 拖动项中心越过目标卡片中线即换位，不要求进入卡片间隙。
  assert.equal(gridTargetIndex(grid, 'a', 160, 40), 0);
  // 拖 a：中心刚越过 b 的中线（160）后，插到 b 后面（与纵向的严格比较一致）。
  assert.equal(gridTargetIndex(grid, 'a', 161, 40), 1);
  assert.equal(gridTargetIndex(grid, 'a', 200, 40), 1);
  assert.equal(gridTargetIndex(grid, 'a', 269, 40), 1);
  // 拖 a：中心刚越过 c 的中线（270）后，插到 c 后面。
  assert.equal(gridTargetIndex(grid, 'a', 271, 40), 2);
  // 拖 a：指针停在 b 之前（a 原位右侧）。
  assert.equal(gridTargetIndex(grid, 'a', 80, 40), 0);
  // 拖 a 进入第二行：越过 d 的中线（50）后插到 d 后面。
  assert.equal(gridTargetIndex(grid, 'a', 106, 130), 3);
  // 拖 a：越过第二行全部中线后，落到行末。
  assert.equal(gridTargetIndex(grid, 'a', 321, 130), 5);
  // 拖 d 进入第一行：越过 a 的中线（50）后插到 a 后面（源在第二行，索引换算正确）。
  assert.equal(gridTargetIndex(grid, 'd', 106, 40), 1);
  // 拖 d：指针在网格上方，中心未越过任何中线，留在最前（a 中线恰为 50，严格比较不计数）。
  assert.equal(gridTargetIndex(grid, 'd', 50, -20), 0);
});
