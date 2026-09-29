import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashText, normalizeText, idsToTrim, idsToDedup, preview,
} from '../js/utils.js';

const item = (id, createdAt, pinned = false, hash = `h${id}`) =>
  ({ id, createdAt, pinned, hash });

test('hashText 稳定且对不同文本不同', () => {
  assert.equal(hashText('hello'), hashText('hello'));
  assert.notEqual(hashText('hello'), hashText('world'));
});

test('normalizeText 压缩空白并去首尾空格', () => {
  assert.equal(normalizeText('  a  b\n c  '), 'a b c');
  assert.equal(normalizeText(null), '');
});

test('idsToTrim 未超限时不删除', () => {
  const items = [item('a', 1), item('b', 2)];
  assert.deepEqual(idsToTrim(items, 5), []);
});

test('idsToTrim 优先删除最旧的未固定项', () => {
  const items = [
    item('old', 1),
    item('mid', 2),
    item('new', 3),
    item('pin', 0, true),
  ];
  assert.deepEqual(idsToTrim(items, 3), ['old']);
  assert.deepEqual(idsToTrim(items, 2), ['old', 'mid']);
});

test('idsToTrim 固定项永不删除', () => {
  const items = [
    item('p1', 1, true),
    item('p2', 2, true),
    item('u1', 3),
  ];
  assert.deepEqual(idsToTrim(items, 2), ['u1']);
});

test('idsToDedup 相同 hash 保留最新，固定项优先', () => {
  const items = [
    { id: 'a', createdAt: 1, pinned: false, hash: 'x' },
    { id: 'b', createdAt: 2, pinned: false, hash: 'x' },
    { id: 'c', createdAt: 3, pinned: false, hash: 'y' },
  ];
  assert.deepEqual(idsToDedup(items), ['a']);

  const withPin = [
    { id: 'a', createdAt: 5, pinned: false, hash: 'x' },
    { id: 'b', createdAt: 1, pinned: true, hash: 'x' },
  ];
  assert.deepEqual(idsToDedup(withPin), ['a']);
});

test('preview 超长截断', () => {
  assert.equal(preview('短文本'), '短文本');
  assert.ok(preview('x'.repeat(100), 10).endsWith('…'));
});
