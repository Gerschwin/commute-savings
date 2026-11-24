// Run with: node calc.test.js
'use strict';
const assert = require('assert');
const C = require('./calc.js');

// The brief's worked examples used a £5.50 fare and no discount code.
const D = Object.assign({}, C.DEFAULTS, { fare: 5.5, discountOn: false });
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

test('with BB1 (£5.45): walked £5.72, drove to station £3.99', () => {
  const eff = C.effectiveSettings(C.DEFAULTS, null, null, '2026-11-23');
  assert.strictEqual(eff.fare, 5.45);
  assert.strictEqual(eff.fareCode, 'BB1');
  assert.strictEqual(C.entrySaving('train', eff).fuel, 5.72);
  assert.strictEqual(C.entrySaving('station', eff).fuel, 3.99);
});

test('full £6.10 fare: walked £5.07, drove to station £3.34', () => {
  assert.strictEqual(C.entrySaving('train', C.DEFAULTS).fuel, 5.07);
  assert.strictEqual(C.entrySaving('station', C.DEFAULTS).fuel, 3.34);
});

test('discount code stops after its end date and when switched off', () => {
  const s = Object.assign({}, C.DEFAULTS, { discountEnds: '2026-12-31' });
  assert.strictEqual(C.usualFare(s, '2026-12-31').fare, 5.45);
  assert.strictEqual(C.usualFare(s, '2026-12-31').single, 4.95);
  assert.strictEqual(C.usualFare(s, '2027-01-01').single, 5.5);
  const after = C.usualFare(s, '2027-01-01');
  assert.strictEqual(after.fare, 6.1);
  assert.strictEqual(after.expired, true);
  assert.strictEqual(C.usualFare(Object.assign({}, s, { discountOn: false }), '2026-12-01').fare, 6.1);
  // a typed fare overrides it, and drops the code label unless it matches
  const typed = C.effectiveSettings(s, null, 11, '2026-12-01');
  assert.strictEqual(typed.fare, 11);
  assert.strictEqual(typed.fareCode, null);
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

test('weight parsing: kg, stone and pounds', () => {
  assert.strictEqual(C.round2(C.parseWeight('92', 'kg')), 92);
  assert.strictEqual(C.round2(C.parseWeight('14st 7lb', 'kg')), 92.08);
  assert.strictEqual(C.round2(C.parseWeight('14 7', 'st')), 92.08);
  assert.strictEqual(C.round2(C.parseWeight('203', 'lb')), 92.08);
  assert.strictEqual(C.parseWeight('', 'st'), 0);
  assert.strictEqual(C.formatWeight(92.08, 'st'), '14 st 7 lb');
});

test('height parsing: cm and feet/inches', () => {
  assert.strictEqual(C.round2(C.parseHeight("5'10")), 177.8);
  assert.strictEqual(C.round2(C.parseHeight('5ft 10in')), 177.8);
  assert.strictEqual(C.round2(C.parseHeight('5 10')), 177.8);
  assert.strictEqual(C.parseHeight('178'), 178);
  assert.strictEqual(C.parseHeight('1.78m'), 178);
  assert.strictEqual(C.formatHeight(177.8), '5 ft 10 in');
});

test('MET lookup interpolates by speed', () => {
  assert.strictEqual(C.metFor('walk', 3), 3.5);
  assert.strictEqual(C.round2(C.metFor('walk', 3.25)), 3.9);
  assert.strictEqual(C.metFor('cycle', 11), 6.8);
  assert.strictEqual(C.metFor('cycle', 30), 12);
});

const ME = Object.assign({}, C.DEFAULTS, { weightKg: 90, heightCm: 178 });

test('commute walk: 3.6 miles at 3 mph, 90 kg', () => {
  const r = C.exerciseCalc({ kind: 'walk', miles: 3.6 }, ME);
  assert.strictEqual(r.mins, 72);
  assert.strictEqual(r.kcal, 270);           // (3.5 - 1) × 90 × 1.2
  assert.strictEqual(r.steps, 7843);         // 3.6 mi ÷ 0.7387 m step
});

test('commute cycle: 3.6 miles at 11 mph, 90 kg, no steps', () => {
  const r = C.exerciseCalc({ kind: 'cycle', miles: 3.6 }, ME);
  assert.strictEqual(r.mins, 20);
  assert.strictEqual(r.kcal, 171);           // 5.8 × 90 × 0.327 h
  assert.strictEqual(r.steps, 0);
});

test('steps in gives miles out, and no weight means no calories', () => {
  const r = C.exerciseCalc({ kind: 'walk', steps: 10000 }, Object.assign({}, ME, { weightKg: 0 }));
  assert.strictEqual(r.miles, 4.59);
  assert.strictEqual(r.kcal, null);
});

test('exercise totals and weekday streak', () => {
  const recs = [
    { date: '2026-11-23', kind: 'walk', miles: 3.6, steps: 7843, kcal: 270 }, // Mon
    { date: '2026-11-20', kind: 'cycle', miles: 3.6, steps: 0, kcal: 171 },   // Fri
    { date: '2026-11-19', kind: 'walk', miles: 2, steps: 4000, kcal: 150 },   // Thu
    { date: '2026-11-17', kind: 'walk', miles: 1, steps: 2000, kcal: 75 },    // Tue (Wed missed)
    { date: '2026-10-30', kind: 'walk', miles: 5, steps: 10000, kcal: 380 }
  ];
  const t = C.exerciseTotals(recs, '2026-11-23');
  assert.strictEqual(t.walk, 6.6);
  assert.strictEqual(t.cycle, 3.6);
  assert.strictEqual(t.miles, 10.2);
  assert.strictEqual(t.steps, 13843);
  assert.strictEqual(t.kcal, 666);
  assert.strictEqual(t.activeDays, 4);
  assert.strictEqual(t.streak, 3);          // Mon, (weekend skipped), Fri, Thu; Wed breaks it
  assert.strictEqual(t.allMiles, 15.2);
  // a day with nothing logged yet today does not break the streak
  assert.strictEqual(C.exerciseTotals(recs, '2026-11-24').streak, 3);
});

test('settings: weight and height are optional but sanity checked', () => {
  assert.strictEqual(C.validateSettings(Object.assign({}, C.DEFAULTS, { weightKg: 0 })).ok, true);
  assert.strictEqual(C.validateSettings(Object.assign({}, C.DEFAULTS, { weightKg: 5 })).ok, false);
  assert.strictEqual(C.validateSettings(Object.assign({}, C.DEFAULTS, { heightCm: 178 })).settings.heightCm, 178);
});

test('recalculating past days uses the tank and price of the time', () => {
  const fills = [
    { date: '2026-11-01', odo: 10000, litres: 50, cost: 79.5, full: true },   // 159p
    { date: '2026-11-15', odo: 10300, litres: 60, cost: 90, full: true },     // 150p, tank 1: 300 mi / 60 L = 22.73 mpg
    { date: '2026-11-29', odo: 10550, litres: 50, cost: 72.5, full: true }    // 145p, tank 2: 250 mi / 50 L = 22.73
  ];
  const entries = [
    { id: 'a', date: '2026-11-03', type: 'train', fuel: 5.67, fare: 5.5 },    // tank 1, 159p
    { id: 'b', date: '2026-11-20', type: 'station', fuel: 3.94, fare: 5.45 }, // tank 2, 150p
    { id: 'c', date: '2026-11-10', type: 'custom', fuel: 15 },                // never touched
    { id: 'd', date: '2026-10-20', type: 'train', fuel: 5.67 }                // before any fill: earliest price, average mpg, usual fare
  ];
  const ch = C.recalcEntries(entries, fills, C.DEFAULTS);
  const by = Object.fromEntries(ch.map(c => [c.id, c]));
  assert.ok(!by.c);
  // a: 34 × 1.59 × 4.546 / 22.727 − 5.50 = 10.81 − 5.50
  assert.strictEqual(by.a.fuel, 5.31);
  assert.strictEqual(by.a.price, 1.59);
  // b: 34 × 1.50 × 4.546 / 22.727 − 5.45 − 3.6 × 1.50 × 4.546 / 15
  assert.strictEqual(by.b.fuel, 3.11);
  // d: no stored fare, so the BB1 fare for that date (£5.45)
  assert.strictEqual(by.d.fare, 5.45);
  assert.strictEqual(by.d.fuel, 5.36);
});

test('one fill-up is enough to reprice past days, keeping their own mpg', () => {
  const one = [{ date: '2026-11-01', odo: 10000, litres: 50, cost: 72.5, ppl: 145, full: true }];
  const e = { id: 'a', date: '2026-11-03', type: 'train', fuel: 5.72, fare: 5.45, mpg: 22, price: 1.59 };
  const ch = C.recalcEntries([e], one, C.DEFAULTS);
  // 34 mi at 22 mpg and £1.45 = £10.19, less £5.45
  assert.deepStrictEqual([ch[0].mpg, ch[0].price, ch[0].fuel], [22, 1.45, 4.74]);
});

test('each day uses the price of the fill-up in the tank that day', () => {
  const fills = [
    { date: '2026-11-01', odo: 10000, litres: 50, cost: 72.5, full: true },   // 145p
    { date: '2026-11-15', odo: 10400, litres: 40, cost: 60, ppl: 150, full: true }
  ];
  const st = C.fillStats(fills, 'mi');
  const s = Object.assign({}, C.DEFAULTS, { useFills: true });
  assert.strictEqual(C.effectiveSettings(s, st, null, '2026-11-10').price, 1.45);
  assert.strictEqual(C.effectiveSettings(s, st, null, '2026-11-20').price, 1.5);
  assert.strictEqual(st.price, 1.5);
});

test('fill-up: any two of litres, pence a litre and paid', () => {
  const base = { date: '2026-11-20', odo: 1000, full: true };
  let r = C.validateFill(Object.assign({}, base, { litres: '40', ppl: '145.9', cost: '' }));
  assert.ok(r.ok); assert.strictEqual(r.fill.cost, 58.36); assert.strictEqual(r.fill.ppl, 145.9);
  r = C.validateFill(Object.assign({}, base, { litres: '', ppl: '145.9', cost: '58.36' }));
  assert.ok(r.ok); assert.strictEqual(r.fill.litres, 40);
  r = C.validateFill(Object.assign({}, base, { litres: '40', ppl: '1.459', cost: '' }));
  assert.strictEqual(r.fill.ppl, 145.9);
  assert.strictEqual(C.fillPrice(r.fill), 1.459);
  assert.ok(!C.validateFill(Object.assign({}, base, { litres: '40', ppl: '9', cost: '' })).ok);
});

test('changing Settings mpg reworks only days that used the Settings figure', () => {
  const S = Object.assign({}, C.DEFAULTS);
  const N = Object.assign({}, S, { mpg: 18 });
  const entries = [
    { id: 'a', date: '2026-11-03', type: 'train', fuel: 5.72, fare: 5.45, mpg: 22, price: 1.59 },
    { id: 'b', date: '2026-11-04', type: 'train', fuel: 5.72 },                                   // older entry, nothing stored
    { id: 'c', date: '2026-11-05', type: 'train', fuel: 4.9, fare: 5.45, mpg: 19.4, price: 1.52 }, // from the fuel log
    { id: 'd', date: '2026-11-05', type: 'other', fuel: 3 }
  ];
  const ch = C.recalcFromSettings(entries, S, N);
  const by = Object.fromEntries(ch.map(c => [c.id, c]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a', 'b']);
  // 34 × 1.59 × 4.546 / 18 − 5.45
  assert.strictEqual(by.a.fuel, 8.20);
  assert.strictEqual(by.a.mpg, 18);
  assert.strictEqual(by.b.fare, 5.45);
  assert.deepStrictEqual(C.recalcFromSettings(entries, S, Object.assign({}, S, { target: 50 })), []);
});

test('changing Settings petrol price keeps each day\'s mpg', () => {
  const S = Object.assign({}, C.DEFAULTS);
  const N = Object.assign({}, S, { price: 1.45 });
  const ch = C.recalcFromSettings([{ id: 'a', date: '2026-11-03', type: 'station', fuel: 3.99, fare: 5.45, mpg: 20, price: 1.59 }], S, N);
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].mpg, 20);
  assert.strictEqual(ch[0].price, 1.45);
});

test('commute exercise from the two legs', () => {
  const s = Object.assign({}, C.DEFAULTS); // 1.6 home leg, 0.8 work leg
  const w = C.commuteExercise('walked', s);
  assert.deepStrictEqual(w.map(x => [x.kind, x.miles]), [['walk', 4.8]]);
  const c = C.commuteExercise('cycled', s);
  assert.deepStrictEqual(c.map(x => [x.kind, x.miles]), [['cycle', 3.2], ['walk', 1.6]]);
  const d = C.commuteExercise('station', s);
  assert.deepStrictEqual(d.map(x => [x.kind, x.miles]), [['walk', 1.6]]);
  const none = Object.assign({}, s, { workLeg: 0 });
  assert.deepStrictEqual(C.commuteExercise('station', none), []);
  assert.deepStrictEqual(C.commuteExercise('cycled', none).map(x => x.kind), ['cycle']);
});

test('work leg may be 0 but not negative; old settings get the leg defaults', () => {
  assert.ok(C.validateSettings(Object.assign({}, C.DEFAULTS, { workLeg: 0 })).ok);
  assert.ok(C.validateSettings(Object.assign({}, C.DEFAULTS, { workLeg: '' })).ok);
  assert.ok(!C.validateSettings(Object.assign({}, C.DEFAULTS, { workLeg: -1 })).ok);
  const old = Object.assign({}, C.DEFAULTS); delete old.homeLeg; delete old.workLeg; old.walkMiles = 3.6;
  const v = C.validateSettings(old);
  assert.ok(v.ok);
  assert.strictEqual(v.settings.homeLeg, 1.6);
  assert.strictEqual(v.settings.workLeg, 0.8);
});

test('got a lift saves the whole drive; no commute saves nothing', () => {
  const lift = C.entrySaving('lift', C.DEFAULTS);
  // 34 × 1.59 × 4.546 / 22 = 11.17
  assert.strictEqual(lift.fuel, 11.17);
  assert.strictEqual(lift.wear, 3.4);
  assert.deepStrictEqual(C.entrySaving('off', C.DEFAULTS), { fuel: 0, wear: 0 });
});

test('lift and no commute days are not train days', () => {
  const t = C.totals([
    { date: '2026-11-02', type: 'train', fuel: 5 },
    { date: '2026-11-03', type: 'lift', fuel: 11.17 },
    { date: '2026-11-04', type: 'off', fuel: 0 }
  ], '2026-11-20', false);
  assert.strictEqual(t.trainDaysMonth, 1);
  assert.strictEqual(t.month, 16.17);
});

test('a No commute day does not break the streak', () => {
  // Fri 20 Nov today; active Mon 16 to Thu 19 except Wed 18 (holiday)
  const recs = ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20'].map(d => ({ date: d, kind: 'walk', miles: 1 }));
  assert.strictEqual(C.exerciseTotals(recs, '2026-11-20').streak, 2);
  assert.strictEqual(C.exerciseTotals(recs, '2026-11-20', { '2026-11-18': true }).streak, 4);
});

test('lift days are reworked with a new mpg, with no fare', () => {
  const S = Object.assign({}, C.DEFAULTS), N = Object.assign({}, S, { mpg: 18 });
  const ch = C.recalcFromSettings([{ id: 'l', date: '2026-11-03', type: 'lift', fuel: 11.17, mpg: 22, price: 1.59 },
    { id: 'o', date: '2026-11-04', type: 'off', fuel: 0 }], S, N);
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].fare, null);
  // 34 × 1.59 × 4.546 / 18
  assert.strictEqual(ch[0].fuel, 13.65);
});

test('phone steps add only the extra, at an easy pace', () => {
  const p = Object.assign({}, C.DEFAULTS, { weightKg: 90, heightCm: 178 });
  const r = C.phoneWalk(14000, 10457, p);
  assert.strictEqual(r.extra, 3543);
  assert.strictEqual(r.steps, 3543);
  // 3543 × 0.7387 m = 2617 m = 1.63 mi; at 2.5 mph that is 39 min
  assert.strictEqual(r.miles, 1.63);
  assert.strictEqual(r.mins, 39);
  assert.ok(r.kcal > 80 && r.kcal < 140, 'kcal ' + r.kcal);
  // fewer phone steps than the app already has: nothing added
  assert.strictEqual(C.phoneWalk(9000, 10457, p).miles, 0);
  // no height: a 175 cm step is assumed
  assert.ok(C.phoneWalk(5000, 0, C.DEFAULTS).miles > 2);
});

test('payday: 28th, or the Friday before at a weekend', () => {
  const s = { monthStart: 'payday', payDay: 28, payWeekend: true };
  assert.strictEqual(C.payday(2026, 10, s), '2026-11-27'); // Sat 28 Nov 2026 -> Fri 27
  assert.strictEqual(C.payday(2026, 11, s), '2026-12-28'); // Mon 28 Dec
  assert.strictEqual(C.payday(2027, 1, s), '2027-02-26');  // Sun 28 Feb 2027 -> Fri 26
  assert.strictEqual(C.payday(2026, 10, Object.assign({}, s, { payWeekend: false })), '2026-11-28');
  assert.strictEqual(C.payday(2026, 10, { monthStart: 'lastFri' }), '2026-11-27');
  assert.strictEqual(C.payday(2026, 11, { monthStart: 'lastFri' }), '2026-12-25');
  assert.strictEqual(C.payday(2026, 10, { monthStart: 'calendar' }), '2026-11-01');
});

test('pay month runs from payday to the day before the next', () => {
  const s = { monthStart: 'payday', payDay: 28, payWeekend: true };
  assert.deepStrictEqual(C.periodFor('2026-11-23', s), { start: '2026-10-28', end: '2026-11-26', days: 30 });
  assert.deepStrictEqual(C.periodFor('2026-11-27', s), { start: '2026-11-27', end: '2026-12-27', days: 31 });
  assert.deepStrictEqual(C.periodFor('2027-01-10', s), { start: '2026-12-28', end: '2027-01-27', days: 31 });
  assert.deepStrictEqual(C.periodFor('2026-11-23', { monthStart: 'calendar' }), { start: '2026-11-01', end: '2026-11-30', days: 30 });
});

test('totals and chart use the pay month', () => {
  const s = { monthStart: 'payday', payDay: 28, payWeekend: true };
  const p = C.periodFor('2026-11-23', s);
  const entries = [
    { date: '2026-10-27', type: 'train', fuel: 1 },  // before pay month
    { date: '2026-10-29', type: 'train', fuel: 2 },  // in (previous calendar month)
    { date: '2026-11-20', type: 'train', fuel: 3 }
  ];
  const t = C.totals(entries, '2026-11-23', false, p);
  assert.strictEqual(t.month, 5);
  assert.strictEqual(t.trainDaysMonth, 2);
  const cum = C.cumulativeByPeriod(entries, p, false);
  assert.strictEqual(cum.length, 30);
  assert.strictEqual(cum[1], 2);   // 29 Oct is day 2
  assert.strictEqual(cum[29], 5);
});

test('Milngavie trip: 46.2 miles driving, £6.80 BB1 return', () => {
  const s = C.effectiveSettings(C.routeSettings(C.DEFAULTS, 'milngavie'), null, null, '2026-11-23');
  assert.strictEqual(s.commuteMiles, 46.2);
  assert.strictEqual(s.fare, 6.8);
  assert.strictEqual(s.fareCode, 'BB1');
  assert.strictEqual(C.round2(C.drivingCost(s)), 15.18);
  assert.deepStrictEqual(C.entrySaving('train', s), { fuel: 8.38, wear: 4.62 });
  assert.deepStrictEqual(C.entrySaving('lift', s), { fuel: 15.18, wear: 4.62 });
});

test('no trip picked leaves the usual commute', () => {
  assert.strictEqual(C.routeSettings(C.DEFAULTS, '').commuteMiles, 34);
  assert.strictEqual(C.routeSettings(C.DEFAULTS, 'nope').commuteMiles, 34);
});

test('trip uses the full fares once the code ends', () => {
  const st = Object.assign({}, C.DEFAULTS, { discountEnds: '2026-12-31' });
  const u = C.usualFare(C.routeSettings(st, 'milngavie'), '2027-01-05');
  assert.deepStrictEqual([u.fare, u.single], [7.6, 7.3]);
  assert.strictEqual(C.usualFare(C.routeSettings(st, 'milngavie'), '2026-11-23').single, 6.55);
});

test('a trip with no code fare never uses the code', () => {
  const trip = { name: 'Edinburgh', miles: 80, fare: 16.5, codeFare: 0, work: false };
  const r = C.routeSettings(C.DEFAULTS, trip);
  const u = C.usualFare(r, '2026-11-23');
  assert.deepStrictEqual([u.fare, u.code], [16.5, null]);
  assert.strictEqual(r.workLeg, 0);   // not a work day: no station to work walk
  assert.strictEqual(r.tripWork, false);
  // 80 mi at 22 mpg and £1.59 = £26.28, less £16.50
  assert.strictEqual(C.entrySaving('train', C.effectiveSettings(r, null, null, '2026-11-23')).fuel, 9.78);
});

test('Milngavie walks: Airdrie station, Queen Street to work, and 0.7 miles from Milngavie, both ways', () => {
  const r = C.routeSettings(C.DEFAULTS, 'milngavie');
  assert.deepStrictEqual(C.commuteExercise('walked', r).map(p => p.miles), [6.2]);
  assert.deepStrictEqual(C.commuteExercise('cycled', r).map(p => [p.kind, p.miles]), [['cycle', 3.2], ['walk', 3]]);
  assert.deepStrictEqual(C.commuteExercise('station', r).map(p => p.miles), [3]);
  // saved before walks existed
  const old = C.validateSettings(Object.assign({}, C.DEFAULTS, { trips: [{ id: 'milngavie', name: 'Milngavie', miles: 46.2, fare: 7.6, codeFare: 6.8, work: true }] }));
  assert.strictEqual(old.settings.trips[0].walk, 0.7);
});

test('recalc keeps a trip day on its own miles', () => {
  const e = { id: 'r', date: '2026-11-23', type: 'train', fuel: 8.38, fare: 6.8, mpg: 22, price: 1.59, route: 'Milngavie', miles: 46.2 };
  const ch = C.recalcFromSettings([e], C.DEFAULTS, Object.assign({}, C.DEFAULTS, { mpg: 25 }));
  assert.strictEqual(ch[0].fuel, 6.56);
});

test('old second route settings become a saved trip', () => {
  const old = Object.assign({}, C.DEFAULTS, { route2On: true, route2Name: 'Milngavie', route2Miles: 46.2, route2Fare: 6.8, route2Full: 0 });
  delete old.trips;
  const v = C.validateSettings(old);
  assert.ok(v.ok);
  assert.deepStrictEqual(v.settings.trips.map(t => [t.name, t.miles, t.fare, t.codeFare, t.work]), [['Milngavie', 46.2, 7.6, 6.8, true]]);
  const off = Object.assign({}, old, { route2On: false });
  assert.deepStrictEqual(C.validateSettings(off).settings.trips, []);
});

test('saved trips are checked', () => {
  const bad = C.validateSettings(Object.assign({}, C.DEFAULTS, { trips: [{ name: 'X', miles: '', fare: '' }] }));
  assert.ok(bad.errors['trips.0.miles'] && bad.errors['trips.0.fare']);
  assert.ok(C.validateSettings(Object.assign({}, C.DEFAULTS, { trips: [] })).ok);
});

test('trip days count separately and not as train days', () => {
  const p = C.periodFor('2026-11-23', C.DEFAULTS);
  const t = C.totals([
    { date: '2026-11-20', type: 'train', fuel: 5, wear: 0 },
    { date: '2026-11-21', type: 'train', fuel: 9.78, wear: 0, trip: true, route: 'Edinburgh' }
  ], '2026-11-23', false, p);
  assert.deepStrictEqual([t.month, t.tripsMonth, t.tripsAll, t.trainDaysMonth], [14.78, 9.78, 9.78, 1]);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
