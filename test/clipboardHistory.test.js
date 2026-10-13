'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardHistory } = require('../lib/clipboardHistory');

function make(opts = {}) {
  const clock = { t: 1_000_000 };
  const h = new ClipboardHistory({ max: 3, ttlMs: 60_000, maxLen: 20, now: () => clock.t, ...opts });
  return { h, clock };
}

test('добавление: новые сверху, дубликаты поднимаются, лимит записей', () => {
  const { h } = make();
  h.add('a'); h.add('b'); h.add('c');
  assert.deepEqual(h.list().map((e) => e.text), ['c', 'b', 'a']);
  h.add('a');
  assert.deepEqual(h.list().map((e) => e.text), ['a', 'c', 'b']);
  h.add('d');
  assert.deepEqual(h.list().map((e) => e.text), ['d', 'a', 'c']);
});

test('не принимает пустое, пробелы, не-строки и слишком длинное', () => {
  const { h } = make();
  for (const bad of ['', '   ', '\n', null, undefined, 5, {}, 'x'.repeat(21)]) assert.equal(h.add(bad), null);
  assert.equal(h.list().length, 0);
});

test('срок хранения: просроченные записи удаляются', () => {
  const { h, clock } = make();
  h.add('old');
  clock.t += 30_000;
  h.add('new');
  clock.t += 40_000; // old: 70с, new: 40с
  assert.deepEqual(h.list().map((e) => e.text), ['new']);
  assert.equal(h.get(h.list()[0].id).text, 'new');
  clock.t += 30_000;
  assert.equal(h.list().length, 0);
});

test('prune возвращает признак изменения; setTtlMs применяется сразу', () => {
  const { h, clock } = make();
  h.add('x');
  assert.equal(h.prune(), false);
  clock.t += 10_000;
  assert.equal(h.setTtlMs(5_000), true);
  assert.equal(h.list().length, 0);
});

test('get по id и очистка', () => {
  const { h } = make();
  const e = h.add('secret');
  assert.equal(h.get(e.id).text, 'secret');
  assert.equal(h.get('nope'), null);
  h.clear();
  assert.equal(h.get(e.id), null);
  assert.deepEqual(h.toJSON(), []);
});

test('сериализация: round-trip и отбрасывание некорректных данных', () => {
  const { h, clock } = make();
  h.add('a'); clock.t += 1000; h.add('b');
  const saved = JSON.parse(JSON.stringify(h.toJSON()));

  const { h: h2 } = make({ now: () => clock.t });
  h2.load(saved);
  assert.deepEqual(h2.list().map((e) => e.text), ['b', 'a']);

  h2.load([{ id: 1, text: 'x', ts: 1 }, null, 'str', { id: 'i', text: 'x'.repeat(100), ts: clock.t }, { id: 'ok', text: 'fine', ts: clock.t }]);
  assert.deepEqual(h2.list().map((e) => e.text), ['fine']);
  h2.load('garbage');
  assert.equal(h2.list().length, 0);
});

test('load не воскрешает просроченные записи', () => {
  const { h, clock } = make();
  h.load([{ id: 'a', text: 'stale', ts: clock.t - 120_000 }]);
  assert.equal(h.list().length, 0);
});
