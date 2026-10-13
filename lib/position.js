'use strict';

/** Геометрия окна: восстановление позиции, ограничение рабочей областью дисплея. */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function containsPoint(wa, x, y) {
  return x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height;
}

/** Рабочая область, содержащая точку, иначе — ближайшая по расстоянию до центра. */
function pickWorkArea(x, y, workAreas, fallback) {
  if (!workAreas || !workAreas.length) return fallback;
  const hit = workAreas.find((wa) => containsPoint(wa, x, y));
  if (hit) return hit;
  let best = workAreas[0];
  let bestDist = Infinity;
  for (const wa of workAreas) {
    const cx = wa.x + wa.width / 2;
    const cy = wa.y + wa.height / 2;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestDist) { bestDist = d; best = wa; }
  }
  return best;
}

function clampBounds(b, wa) {
  return {
    x: Math.round(clamp(b.x, wa.x, wa.x + wa.width - b.width)),
    y: Math.round(clamp(b.y, wa.y, wa.y + wa.height - b.height)),
    width: b.width,
    height: b.height
  };
}

/**
 * Стартовые границы окна. posX — X ЦЕНТРА окна, posY — верхний край.
 * Если сохранённой позиции нет или она вне всех дисплеев — по центру основного дисплея сверху.
 */
function resolveStartBounds({ posX, posY }, size, workAreas, primaryWorkArea, defaultTop = 8) {
  const centered = {
    x: Math.round(primaryWorkArea.x + (primaryWorkArea.width - size.w) / 2),
    y: primaryWorkArea.y + defaultTop,
    width: size.w,
    height: size.h
  };
  if (!Number.isFinite(posX) || !Number.isFinite(posY)) return centered;

  const wa = (workAreas || []).find((a) => containsPoint(a, posX, posY));
  if (!wa) return centered; // дисплей отключили — возвращаем в видимую область

  return clampBounds({ x: posX - size.w / 2, y: posY, width: size.w, height: size.h }, wa);
}

/** Границы после смены размера: центр по X сохраняется, окно остаётся в рабочей области. */
function resizeAroundCenter(current, target, workAreas, fallbackWorkArea) {
  const centerX = current.x + current.width / 2;
  const wanted = {
    x: Math.round(centerX - target.w / 2),
    y: current.y,
    width: target.w,
    height: target.h
  };
  const wa = pickWorkArea(centerX, current.y, workAreas, fallbackWorkArea);
  return clampBounds(wanted, wa);
}

module.exports = { clamp, containsPoint, pickWorkArea, clampBounds, resolveStartBounds, resizeAroundCenter };
