// Run with: node calc.test.js
'use strict';
const assert = require('assert');
const C = require('./calc.js');

const D = C.DEFAULTS;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

test('fuel cost per mile with defaults is about 32.9p', () => {
  assert.strictEqual(C.round2(C.fuelCostPerMile(D.price, D.mpg)), 0.33);
});

test('driving the commute costs £11.17', () => {
  assert.strictEqual(C.round2(C.drivingCost(D)), 11.17);
});

test('walked or cycled day saves £5.67 fuel', () => {
  const s = C.entrySaving('train', D);
  assert.strictEqual(s.fuel, 5.67);
  assert.strictEqual(s.wear, 3.40);
});

test('station run fuel is £1.73', () => {
  assert.strictEqual(C.round2(C.stationFuel(D)), 1.73);
});

// The brief says "about £3.97". The formula it gives works out at £3.936,
// which rounds to £3.94, so that is what we check.
test('drove-to-station day saves £3.94 fuel', () => {
  const s = C.entrySaving('station', D);
  assert.strictEqual(s.fuel, 3.94);
  assert.strictEqual(s.wear, 3.04);
});

test('display value adds wear only when toggled on', () => {
  const e = { fuel: 5.67, wear: 3.4 };
  assert.strictEqual(C.displayValue(e, false), 5.67);
  assert.strictEqual(C.displayValue(e, true), 9.07);
});

test('week starts on Monday', () => {
  assert.strictEqual(C.mondayOf('2026-11-23'), '2026-11-23'); // Monday
  assert.strictEqual(C.mondayOf('2026-11-29'), '2026-11-23'); // Sunday
  assert.strictEqual(C.mondayOf('2026-11-01'), '2026-10-26'); // Sunday
});

test('totals split by period and count train days once per date', () => {
  const entries = [
    { date: '2026-11-23', type: 'train', fuel: 5.67, wear: 3.4 },
    { date: '2026-11-23', type: 'custom', fuel: 15, wear: 0 },
    { date: '2026-11-20', type: 'station', fuel: 3.94, wear: 3.04 },
    { date: '2026-11-02', type: 'train', fuel: 5.67, wear: 3.4 },
    { date: '2026-10-30', type: 'train', fuel: 5.67, wear: 3.4 },
    { date: '2025-12-01', type: 'custom', fuel: 20, wear: 0 }
  ];
  const t = C.totals(entries, '2026-11-23', false);
  assert.strictEqual(t.today, 20.67);
  assert.strictEqual(t.week, 20.67);
  assert.strictEqual(t.month, 30.28);
  assert.strictEqual(t.year, 35.95);
  assert.strictEqual(t.all, 55.95);
  assert.strictEqual(t.trainDaysMonth, 3);
});

test('cumulative chart data steps up on logged days', () => {
  const entries = [
    { date: '2026-11-02', type: 'train', fuel: 5.67, wear: 0 },
    { date: '2026-11-04', type: 'train', fuel: 5.67, wear: 0 }
  ];
  const c = C.cumulativeByDay(entries, 2026, 10, false);
  assert.strictEqual(c.length, 30);
  assert.deepStrictEqual(c.slice(0, 5), [0, 5.67, 5.67, 11.34, 11.34]);
  assert.strictEqual(c[29], 11.34);
});

test('money and date formatting', () => {
  assert.strictEqual(C.money(5.666), '£5.67');
  assert.strictEqual(C.money(1234.5), '£1,234.50');
  assert.strictEqual(C.shortDate('2026-11-23'), 'Mon 23 Nov');
});

test('CSV round trip keeps commas and quotes in labels', () => {
  const entries = [
    { date: '2026-11-23', type: 'custom', label: 'Lunch, "packed"', fuel: 15, wear: 0 },
    { date: '2026-11-22', type: 'train', label: 'Train, walked', fuel: 5.67, wear: 3.4 }
  ];
  const back = C.entriesFromCSV(C.toCSV(entries));
  assert.strictEqual(back.skipped, 0);
  assert.deepStrictEqual(back.entries, entries.map(e => ({ date: e.date, type: e.type, label: e.label, fuel: e.fuel, wear: e.wear })));
});

test('CSV import skips bad rows', () => {
  const r = C.entriesFromCSV('date,label,type,fuel_saving,wear_saving\n2026-02-30,x,train,1,0\nnope,y,train,1,0\n2026-02-03,z,weird,2,abc\n');
  assert.strictEqual(r.skipped, 2);
  assert.strictEqual(r.entries[0].type, 'custom');
  assert.strictEqual(r.entries[0].wear, 0);
});

test('settings validation rejects zero, negative and blank', () => {
  const r = C.validateSettings(Object.assign({}, D, { mpg: 0, fare: -1, price: '' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.mpg && r.errors.fare && r.errors.price);
  assert.strictEqual(C.validateSettings(D).ok, true);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
