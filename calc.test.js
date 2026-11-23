// Run with: node calc.test.js
'use strict';
const assert = require('assert');
const C = require('./calc.js');

// The brief's worked examples used a £5.50 fare; the default is now the real £6.10.
const D = Object.assign({}, C.DEFAULTS, { fare: 5.5 });
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

test('with the real £6.10 fare: walked £5.07, drove to station £3.34', () => {
  assert.strictEqual(C.DEFAULTS.fare, 6.1);
  assert.strictEqual(C.entrySaving('train', C.DEFAULTS).fuel, 5.07);
  assert.strictEqual(C.entrySaving('station', C.DEFAULTS).fuel, 3.34);
});

test('km/L converts to UK mpg', () => {
  assert.strictEqual(C.round2(C.kmplToMpg(10)), 28.25);
});

test('real mpg uses full-to-full fills and counts partial top-ups', () => {
  const fills = [
    { date: '2026-11-01', odo: 10000, litres: 50, cost: 79.5, full: true },
    { date: '2026-11-08', odo: 10150, litres: 20, cost: 32, full: false },  // top-up
    { date: '2026-11-15', odo: 10300, litres: 40, cost: 64.4, full: true }, // 300 mi on 60 L
    { date: '2026-11-22', odo: 10520, litres: 44, cost: 68.2, full: true }  // 220 mi on 44 L
  ];
  const s = C.fillStats(fills, 'mi');
  assert.strictEqual(s.intervals.length, 2);
  assert.strictEqual(C.round2(s.intervals[0].mpg), 22.73); // 300 / (60 / 4.546)
  assert.strictEqual(C.round2(s.intervals[1].mpg), 22.73); // 220 / (44 / 4.546)
  assert.strictEqual(C.round2(s.mpg), 22.73);
  assert.strictEqual(C.round2(s.price), 1.55);              // latest fill 68.20 / 44
  assert.strictEqual(s.priceDate, '2026-11-22');
});

test('km odometer is converted to miles', () => {
  const s = C.fillStats([
    { date: '2026-11-01', odo: 100000, litres: 40, cost: 60, full: true },
    { date: '2026-11-10', odo: 100500, litres: 50, cost: 75, full: true }
  ], 'km');
  assert.strictEqual(C.round2(s.mpg), 28.25); // 500 km on 50 L = 10 km/L
});

test('one fill gives a price but no mpg yet', () => {
  const s = C.fillStats([{ date: '2026-11-01', odo: 1, litres: 40, cost: 63.6, full: true }], 'mi');
  assert.strictEqual(s.mpg, null);
  assert.strictEqual(C.round2(s.price), 1.59);
});

test('effective settings use real figures only when switched on', () => {
  const stats = { mpg: 25, price: 1.45 };
  const on = C.effectiveSettings(Object.assign({}, D, { useFills: true }), stats, 6.1);
  assert.strictEqual(on.mpg, 25); assert.strictEqual(on.price, 1.45); assert.strictEqual(on.fare, 6.1);
  assert.strictEqual(on.source.mpg, 'fills');
  const off = C.effectiveSettings(Object.assign({}, D, { useFills: false }), stats, null);
  assert.strictEqual(off.mpg, 22); assert.strictEqual(off.fare, 5.5);
  const none = C.effectiveSettings(Object.assign({}, D, { useFills: true }), { mpg: null, price: 1.5 }, null);
  assert.strictEqual(none.mpg, 22); assert.strictEqual(none.price, 1.5);
});

test('fill validation catches silly prices', () => {
  assert.strictEqual(C.validateFill({ date: '2026-11-01', odo: '1000', litres: '40', cost: '£63.60', full: true }).ok, true);
  const bad = C.validateFill({ date: '2026-11-01', odo: '1000', litres: '40', cost: '6.36' });
  assert.ok(/a litre/.test(bad.errors.cost));
});

test('older saved settings without newer fields still load', () => {
  const old = { price: 1.6, mpg: 21, commuteMiles: 34, fare: 5.5, stationMiles: 3.6, stationMpg: 15, wearPence: 10, target: 90, includeWear: false };
  const r = C.validateSettings(old);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.settings.mpg, 21);
  assert.strictEqual(r.settings.single, 5.5);
  assert.strictEqual(r.settings.useFills, true);
});

test('two singles make the train dearer than a return', () => {
  const s = C.entrySaving('train', Object.assign({}, C.DEFAULTS, { fare: 11 }));
  assert.strictEqual(s.fuel, 0.17);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
