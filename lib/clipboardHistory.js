'use strict';

/**
 * История буфера обмена в памяти: лимит записей, лимит длины, срок хранения (TTL).
 * Ничего не пишет на диск сама — сохранением (с шифрованием) занимается main.js.
 */

const crypto = require('node:crypto');

class ClipboardHistory {
  constructor({ max = 20, ttlMs = 60 * 60 * 1000, maxLen = 5000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.maxLen = maxLen;
    this.now = now;
    this.items = []; // новые — в начале: { id, text, ts }
  }

  setTtlMs(ms) {
    this.ttlMs = ms;
    return this.prune();
  }

  /** Добавляет запись. Возвращает запись или null, если текст не принят. */
  add(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > this.maxLen) return null;
    this.items = this.items.filter((e) => e.text !== text);
    const entry = { id: crypto.randomUUID(), text, ts: this.now() };
    this.items.unshift(entry);
    if (this.items.length > this.max) this.items.length = this.max;
    return entry;
  }

  /** Удаляет просроченные записи. Возвращает true, если что-то удалено. */
  prune() {
    const limit = this.now() - this.ttlMs;
    const before = this.items.length;
    this.items = this.items.filter((e) => e.ts > limit);
    return this.items.length !== before;
  }

  list() {
    this.prune();
    return this.items.slice();
  }

  get(id) {
    this.prune();
    return this.items.find((e) => e.id === id) || null;
  }

  clear() {
    this.items = [];
  }

  toJSON() {
    return this.items.map(({ id, text, ts }) => ({ id, text, ts }));
  }

  /** Загружает сохранённые записи, отбрасывая всё некорректное. */
  load(raw) {
    this.items = [];
    if (!Array.isArray(raw)) return;
    for (const e of raw) {
      if (e && typeof e.id === 'string' && typeof e.text === 'string' &&
          typeof e.ts === 'number' && e.text.length <= this.maxLen) {
        this.items.push({ id: e.id, text: e.text, ts: e.ts });
      }
    }
    this.items.sort((a, b) => b.ts - a.ts);
    if (this.items.length > this.max) this.items.length = this.max;
    this.prune();
  }
}

module.exports = { ClipboardHistory };
