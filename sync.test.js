// Run with: node sync.test.js
'use strict';
const assert = require('assert');
const S = require('./sync.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

const e = (id, fuel, extra) => Object.assign({ id, date: '2026-11-23', ts: 1, type: 'train', label: 'x', fuel, wear: 0 }, extra);
const data = (entries, settings) => ({ settings: settings || { mpg: 22 }, entries, fills: [], exercise: [] });
const ids = list => list.map(r => r.id).sort();

test('stable text ignores key order', () => {
  assert.strictEqual(S.stable({ b: 1, a: [1, { d: 2, c: 3 }] }), S.stable({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('first sync with nothing on Drive keeps everything here', () => {
  const r = S.merge(data([e('a', 5)]), null, null);
  assert.deepStrictEqual(ids(r.data.entries), ['a']);
  assert.strictEqual(r.pulled, 0);
});

test('first sync combines both devices and uses Drive settings', () => {
  const r = S.merge(data([e('a', 5)], { mpg: 20 }), null, data([e('b', 6)], { mpg: 22 }));
  assert.deepStrictEqual(ids(r.data.entries), ['a', 'b']);
  assert.strictEqual(r.data.settings.mpg, 22);
  assert.strictEqual(r.pulled, 1);
});

test('a day added on the other device comes down', () => {
  const base = S.snapshot(data([e('a', 5)]));
  const r = S.merge(data([e('a', 5)]), base, data([e('a', 5), e('b', 6)]));
  assert.deepStrictEqual(ids(r.data.entries), ['a', 'b']);
  assert.strictEqual(r.pulled, 1);
});

test('a day added here goes up and is not lost', () => {
  const base = S.snapshot(data([e('a', 5)]));
  const r = S.merge(data([e('a', 5), e('c', 7)]), base, data([e('a', 5)]));
  assert.deepStrictEqual(ids(r.data.entries), ['a', 'c']);
});

test('a day deleted here stays deleted', () => {
  const base = S.snapshot(data([e('a', 5), e('b', 6)]));
  const r = S.merge(data([e('a', 5)]), base, data([e('a', 5), e('b', 6)]));
  assert.deepStrictEqual(ids(r.data.entries), ['a']);
});

test('a day deleted on the other device goes here too', () => {
  const base = S.snapshot(data([e('a', 5), e('b', 6)]));
  const r = S.merge(data([e('a', 5), e('b', 6)]), base, data([e('a', 5)]));
  assert.deepStrictEqual(ids(r.data.entries), ['a']);
  assert.strictEqual(r.dropped, 1);
});

test('a day changed on the other device comes down, one changed here wins', () => {
  const base = S.snapshot(data([e('a', 5), e('b', 6)]));
  const r = S.merge(data([e('a', 5), e('b', 9)]), base, data([e('a', 4), e('b', 8)]));
  const by = {}; r.data.entries.forEach(x => { by[x.id] = x.fuel; });
  assert.deepStrictEqual(by, { a: 4, b: 9 });
});

test('settings: changed here wins, unchanged here takes Drive', () => {
  const base = S.snapshot(data([], { mpg: 22 }));
  assert.strictEqual(S.merge(data([], { mpg: 25 }), base, data([], { mpg: 22 })).data.settings.mpg, 25);
  assert.strictEqual(S.merge(data([], { mpg: 22 }), base, data([], { mpg: 24 })).data.settings.mpg, 24);
});

test('fills and exercise merge the same way', () => {
  const local = { settings: {}, entries: [], fills: [{ id: 'f1' }], exercise: [{ id: 'x1' }] };
  const remote = { settings: {}, entries: [], fills: [{ id: 'f2' }], exercise: [] };
  const base = S.snapshot({ settings: {}, entries: [], fills: [], exercise: [{ id: 'x1' }] });
  const r = S.merge(local, base, remote);
  assert.deepStrictEqual(ids(r.data.fills), ['f1', 'f2']);
  assert.deepStrictEqual(r.data.exercise, []);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
