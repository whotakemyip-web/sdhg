'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pos = require('../lib/position');

const A = { x: 0, y: 0, width: 1920, height: 1040 };
const B = { x: 1920, y: 0, width: 1280, height: 720 };
const SIZE = { w: 240, h: 36 };

test('нет сохранённой позиции → по центру сверху', () => {
  const b = pos.resolveStartBounds({ posX: null, posY: 8 }, SIZE, [A], A);
  assert.deepEqual(b, { x: 840, y: 8, width: 240, height: 36 });
});

test('сохранённая позиция восстанавливается (posX — центр окна)', () => {
  const b = pos.resolveStartBounds({ posX: 500, posY: 100 }, SIZE, [A], A);
  assert.deepEqual(b, { x: 380, y: 100, width: 240, height: 36 });
});

test('позиция на отключённом дисплее → возвращается на основной', () => {
  const b = pos.resolveStartBounds({ posX: 2500, posY: 100 }, SIZE, [A], A);
  assert.equal(b.x, 840);
  assert.equal(b.y, 8);
});

test('позиция на втором дисплее сохраняется, если он подключён', () => {
  const b = pos.resolveStartBounds({ posX: 2500, posY: 100 }, SIZE, [A, B], A);
  assert.equal(b.x, 2380);
});

test('позиция у края ограничивается рабочей областью', () => {
  const b = pos.resolveStartBounds({ posX: 1915, posY: 1035 }, SIZE, [A], A);
  assert.ok(b.x + b.width <= 1920 && b.y + b.height <= 1040);
});

test('мусор в настройках не ломает старт', () => {
  for (const bad of [{ posX: NaN, posY: 1 }, { posX: 'a', posY: 1 }, { posX: undefined, posY: undefined }, { posX: Infinity, posY: 0 }]) {
    assert.deepEqual(pos.resolveStartBounds(bad, SIZE, [A], A).y, 8);
  }
});

test('раскрытие сохраняет центр по X и не выходит за экран', () => {
  const cur = { x: 840, y: 8, width: 240, height: 36 };
  const b = pos.resizeAroundCenter(cur, { w: 440, h: 620 }, [A], A);
  assert.deepEqual(b, { x: 740, y: 8, width: 440, height: 620 });

  const edge = { x: 1800, y: 600, width: 240 - 120, height: 36 };
  const e = pos.resizeAroundCenter(edge, { w: 440, h: 620 }, [A], A);
  assert.ok(e.x + e.width <= 1920 && e.y + e.height <= 1040 && e.x >= 0 && e.y >= 0);
});

test('pickWorkArea: содержащий дисплей, иначе ближайший', () => {
  assert.equal(pos.pickWorkArea(2000, 10, [A, B], A), B);
  assert.equal(pos.pickWorkArea(5000, 10, [A, B], A), B);
  assert.equal(pos.pickWorkArea(-500, 10, [A, B], A), A);
  assert.equal(pos.pickWorkArea(1, 1, [], A), A);
});
