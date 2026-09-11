import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gridTargetIndex,
  groupRowsIntoLines,
  moveItem,
  verticalTargetIndex,
  type SortableRowGeometry,
} from '../src/sortableList';

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

test('gridTargetIndex can target between two cards in the same row', () => {
  // 拖 a：指针停在同一行 b 和 c 之间。
  assert.equal(gridTargetIndex(grid, 'a', 200, 40), 1);
  // 拖 a：指针停在 b 之前（a 原位右侧）。
  assert.equal(gridTargetIndex(grid, 'a', 80, 40), 0);
  // 拖 a：指针停在第二行 d 和 e 之间。
  assert.equal(gridTargetIndex(grid, 'a', 120, 130), 3);
  // 拖 a：指针停在所有卡片之后。
  assert.equal(gridTargetIndex(grid, 'a', 320, 130), 5);
  // 拖 d：指针停在第一行 a 和 b 之间（源在第二行，索引换算正确）。
  assert.equal(gridTargetIndex(grid, 'd', 120, 40), 1);
  // 拖 d：指针在网格上方，留在最前。
  assert.equal(gridTargetIndex(grid, 'd', 50, -20), 0);
});
