import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellsToRect, solveGrid } from '../src/main/geometry.ts';

// A 200x50 client with 9x18 pt cells: 1800x900 pt of grid. Herdr gives the
// tab area as 174x49 (26-column sidebar, one tab-bar row).
const content = { x: 100, y: 50, w: 1802, h: 903 };
const area = { w: 174, h: 49 };

test('cell size in backing pixels (Retina) is converted to points', () => {
  const g = solveGrid({ content, area, cellPx: { w: 18, h: 36 }, scale: 2, chrome: true });
  assert.equal(g.cellW, 9);
  assert.equal(g.originX, 100 + 26 * 9);
  assert.equal(g.originY, 50 + 18);
});

test('cell size already in points is used as is', () => {
  const g = solveGrid({ content, area, cellPx: { w: 9, h: 18 }, scale: 2, chrome: true });
  assert.equal(g.cellW, 9);
  assert.equal(g.originX, 100 + 26 * 9);
});

test('pane rects land after the sidebar and tab bar', () => {
  const g = solveGrid({ content, area, cellPx: { w: 18, h: 36 }, scale: 2, chrome: true });
  const r = cellsToRect(g, { x: 87, y: 0, w: 87, h: 49 });
  assert.deepEqual(r, { x: 100 + (26 + 87) * 9, y: 50 + 18, w: 87 * 9, h: 49 * 18 });
});

test('without a cell size, falls back to the default sidebar width', () => {
  const g = solveGrid({ content: { x: 0, y: 0, w: 2000, h: 1000 }, area: { w: 174, h: 49 }, cellPx: null, scale: 2, chrome: true });
  assert.ok(Math.abs(g.cellW - 10) < 1e-9);
  assert.ok(Math.abs(g.originX - 260) < 1e-9);
  assert.ok(Math.abs(g.originY - 20) < 1e-9);
});

test('mock mode fills the content rect', () => {
  const g = solveGrid({ content: { x: 0, y: 0, w: 1000, h: 500 }, area: { w: 100, h: 50 }, cellPx: null, scale: 1, chrome: false });
  assert.deepEqual(g, { originX: 0, originY: 0, cellW: 10, cellH: 10 });
});
