// Maps Herdr pane rects (terminal cells, relative to the tab area) onto the
// screen. Herdr draws a sidebar on the left and a tab bar on the top row, so
// the tab area starts at (sidebar columns, tab-bar rows) of the client grid.

import type { Rect } from '../shared/types.ts';

export interface GridInput {
  /** Terminal content rect (points, overlay coordinates). */
  content: Rect;
  /** Herdr tab area in cells. */
  area: { w: number; h: number };
  /** Cell size reported by the attached client (TIOCGWINSZ pixels), if known. */
  cellPx: { w: number; h: number } | null;
  /** Display backing scale factor (2 on Retina). */
  scale: number;
  /** False when panes fill the content rect directly (mock mode). */
  chrome: boolean;
  /** Herdr's default sidebar width, used when the cell size is unknown. */
  sidebarCols?: number;
}

export interface Grid {
  originX: number;
  originY: number;
  cellW: number;
  cellH: number;
}

export function solveGrid(g: GridInput): Grid {
  const { content, area } = g;
  if (!g.chrome || area.w <= 0 || area.h <= 0) {
    return { originX: content.x, originY: content.y, cellW: content.w / Math.max(1, area.w), cellH: content.h / Math.max(1, area.h) };
  }
  if (g.cellPx && g.cellPx.w > 0 && g.cellPx.h > 0) {
    // Terminals report cell pixels either in backing pixels or in points; pick
    // the unit under which the tab area fits the window but still fills most of
    // it. Height discriminates best: only the one-row tab bar sits above the area.
    const candidates = [
      { w: g.cellPx.w / g.scale, h: g.cellPx.h / g.scale },
      { w: g.cellPx.w, h: g.cellPx.h },
    ];
    const fits = candidates.find(
      (c) =>
        area.w * c.w <= content.w * 1.02 &&
        area.h * c.h <= content.h * 1.02 &&
        area.w * c.w >= content.w * 0.5 &&
        area.h * c.h >= content.h * 0.8,
    );
    if (fits) {
      const cols = Math.floor(content.w / fits.w + 0.02);
      const rows = Math.floor(content.h / fits.h + 0.02);
      const sidebar = Math.max(0, cols - area.w);
      const top = Math.max(0, rows - area.h);
      return { originX: content.x + sidebar * fits.w, originY: content.y + top * fits.h, cellW: fits.w, cellH: fits.h };
    }
  }
  const sidebar = g.sidebarCols ?? 26;
  const cellW = content.w / (area.w + sidebar);
  const cellH = content.h / (area.h + 1);
  return { originX: content.x + sidebar * cellW, originY: content.y + cellH, cellW, cellH };
}

export function cellsToRect(grid: Grid, c: { x: number; y: number; w: number; h: number }): Rect {
  return { x: grid.originX + c.x * grid.cellW, y: grid.originY + c.y * grid.cellH, w: c.w * grid.cellW, h: c.h * grid.cellH };
}
