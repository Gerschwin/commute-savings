/* Commute Savings: pure calculation and date helpers.
   Works in the browser (window.Calc) and in Node (require('./calc.js')). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LITRES_PER_GALLON = 4.546;

  var DEFAULTS = Object.freeze({
    price: 1.59,        // petrol £ per litre
    mpg: 22,            // van mpg (UK gallons)
    commuteMiles: 34,   // commute round trip
    fare: 6.1,          // full Anytime Day Return without a code, Airdrie–Glasgow Queen Street (Nov 2026)
    discountOn: true,   // use the discount code fare while it is active
    discountCode: 'BB1',
    discountFare: 5.45, // Anytime Day Return with BB1 (Nov 2026)
    discountSingle: 4.95, // Anytime Day Single with BB1 (Nov 2026)
    discountEnds: '',   // last day the code works, "YYYY-MM-DD", or '' if not known
    single: 5.5,        // Anytime Day Single, Airdrie–Glasgow Queen Street (Nov 2026)
    stationMiles: 3.6,  // drive-to-station round trip
    stationMpg: 15,     // mpg on short cold station runs
    wearPence: 10,      // van wear pence per mile
    target: 90,         // monthly target £
    includeWear: false,
    useFills: true,     // use real mpg and price from the fuel log when there is enough data
    odoUnit: 'mi',      // odometer unit for the fuel log ("mi" or "km")
    // exercise
    walkMiles: 3.6,     // walk to the station and back
    cycleMiles: 3.6,    // cycle to the station and back
    walkMph: 3,         // usual walking pace
    cycleMph: 11,       // usual cycling pace
    activeGoal: 30,     // active miles a month
    weightKg: 0,        // 0 = not set (calories need it)
    heightCm: 0,        // 0 = not set (steps need it)
    weightUnit: 'st'    // how weight is shown: "kg", "st" (stone and pounds) or "lb"
  });

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function fuelCostPerMile(price, mpg) {
    return price * LITRES_PER_GALLON / mpg;
  }

  function drivingCost(s) {
    return s.commuteMiles * fuelCostPerMile(s.price, s.mpg);
  }

  function stationFuel(s) {
    return s.stationMiles * s.price * LITRES_PER_GALLON / s.stationMpg;
  }

  /* Saving for a train day.
     mode: "train" (walked or cycled to the station) or "station" (drove to it).
     Returns unrounded {fuel, wear}; round when storing. */
  function trainSaving(mode, s) {
    var drive = drivingCost(s);
    if (mode === 'station') {
      return {
        fuel: drive - s.fare - stationFuel(s),
        wear: (s.commuteMiles - s.stationMiles) * s.wearPence / 100
      };
    }
    return {
      fuel: drive - s.fare,
      wear: s.commuteMiles * s.wearPence / 100
    };
  }

  /* Rounded values as stored on an entry. */
  function entrySaving(mode, s) {
    var r = trainSaving(mode, s);
    return { fuel: round2(r.fuel), wear: round2(r.wear) };
  }

  function displayValue(entry, includeWear) {
    return round2((entry.fuel || 0) + (includeWear ? (entry.wear || 0) : 0));
  }

  /* ---------- dates (local, "YYYY-MM-DD") ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toISO(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseISO(str) {
    var p = String(str).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function isISODate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    return toISO(parseISO(str)) === str;
  }

  function mondayOf(str) {
    var d = parseISO(str);
    var dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return toISO(d);
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  /* Totals for today, this week (Monday start), month, year, all time. */
  function totals(entries, todayISO, includeWear) {
    var t = { today: 0, week: 0, month: 0, year: 0, all: 0, trainDaysMonth: 0 };
    var weekStart = mondayOf(todayISO);
    var month = todayISO.slice(0, 7);
    var year = todayISO.slice(0, 4);
    var trainDates = {};
    entries.forEach(function (e) {
      var v = displayValue(e, includeWear);
      t.all += v;
      if (e.date.slice(0, 4) === year) t.year += v;
      if (e.date.slice(0, 7) === month) {
        t.month += v;
        if (e.type !== 'custom') trainDates[e.date] = true;
      }
      if (e.date >= weekStart && e.date <= todayISO) t.week += v;
      if (e.date === todayISO) t.today += v;
    });
    t.trainDaysMonth = Object.keys(trainDates).length;
    ['today', 'week', 'month', 'year', 'all'].forEach(function (k) { t[k] = round2(t[k]); });
    return t;
  }

  /* Cumulative savings per day of the month: array of length daysInMonth. */
  function cumulativeByDay(entries, year, monthIndex, includeWear) {
    var n = daysInMonth(year, monthIndex);
    var daily = new Array(n).fill(0);
    var prefix = year + '-' + pad(monthIndex + 1);
    entries.forEach(function (e) {
      if (e.date.slice(0, 7) === prefix) {
        daily[Number(e.date.slice(8, 10)) - 1] += displayValue(e, includeWear);
      }
    });
    var run = 0;
    return daily.map(function (v) { run += v; return round2(run); });
  }

  /* ---------- formatting ---------- */
  function money(n) {
    var v = round2(n);
    var neg = v < 0;
    var s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '−£' : '£') + s;
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function shortDate(str) {
    var d = parseISO(str);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(entries) {
    var rows = [['date', 'label', 'type', 'fuel_saving', 'wear_saving']];
    entries.forEach(function (e) {
      rows.push([e.date, e.label, e.type, round2(e.fuel).toFixed(2), round2(e.wear).toFixed(2)]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }

  /* CSV text -> {entries, skipped}. Entries lack id/ts; the app adds them. */
  function entriesFromCSV(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { entries: [], skipped: 0 };
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var col = function (name) { return head.indexOf(name); };
    var di = col('date'), li = col('label'), ti = col('type'), fi = col('fuel_saving'), wi = col('wear_saving');
    if (di < 0 || fi < 0) throw new Error('CSV needs at least date and fuel_saving columns');
    var out = [], skipped = 0;
    rows.slice(1).forEach(function (r) {
      var date = (r[di] || '').trim();
      var fuel = parseFloat(r[fi]);
      var wear = wi >= 0 ? parseFloat(r[wi]) : 0;
      var type = ti >= 0 ? (r[ti] || '').trim() : 'custom';
      if (!isISODate(date) || !isFinite(fuel)) { skipped++; return; }
      if (['train', 'station', 'custom'].indexOf(type) < 0) type = 'custom';
      out.push({
        date: date,
        type: type,
        label: li >= 0 ? (r[li] || '').trim() : '',
        fuel: round2(fuel),
        wear: isFinite(wear) ? round2(wear) : 0
      });
    });
    return { entries: out, skipped: skipped };
  }

  /* ---------- real fuel figures from fill-ups ---------- */
  var KM_PER_MILE = 1.609344;
  var MPG_PER_KMPL = 2.824809; // UK mpg = km/L × 4.546 ÷ 1.609344

  function kmplToMpg(kmpl) { return kmpl * MPG_PER_KMPL; }

  /* A fill: {date, odo, litres, cost, full}. odo is in odoUnit ("mi" or "km").
     Real mpg uses the full-to-full method: miles between two full tanks
     divided by all the fuel added after the first one, up to and including the second.
     Averages the most recent `window` intervals (default 5), weighted by fuel. */
  function fillStats(fills, odoUnit, window) {
    window = window || 5;
    var toMiles = odoUnit === 'km' ? 1 / KM_PER_MILE : 1;
    var sorted = fills.slice().filter(function (f) { return f.odo > 0 && f.litres > 0; })
      .sort(function (a, b) { return a.odo - b.odo || (a.date < b.date ? -1 : 1); });
    var intervals = [];
    var lastFull = null, litresSince = 0;
    sorted.forEach(function (f) {
      if (lastFull) litresSince += f.litres;
      if (f.full) {
        if (lastFull && f.odo > lastFull.odo) {
          var miles = (f.odo - lastFull.odo) * toMiles;
          intervals.push({ from: lastFull.date, to: f.date, miles: miles, litres: litresSince, mpg: miles / (litresSince / LITRES_PER_GALLON) });
        }
        lastFull = f;
        litresSince = 0;
      }
    });
    var recent = intervals.slice(-window);
    var miles = 0, litres = 0;
    recent.forEach(function (iv) { miles += iv.miles; litres += iv.litres; });
    var byDate = fills.slice().filter(function (f) { return f.litres > 0 && f.cost > 0; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.ts || 0) - (a.ts || 0); });
    var latest = byDate[0];
    return {
      intervals: intervals,
      used: recent.length,
      mpg: litres > 0 ? miles / (litres / LITRES_PER_GALLON) : null,
      lastMpg: intervals.length ? intervals[intervals.length - 1].mpg : null,
      price: latest ? latest.cost / latest.litres : null,
      priceDate: latest ? latest.date : null
    };
  }

  /* The settings a new entry is calculated with: saved settings, real
     fill-up figures if switched on and available, and the fare paid today. */
  function effectiveSettings(settings, stats, farePaid, dateISO) {
    var s = Object.assign({}, settings);
    var src = { mpg: 'settings', price: 'settings' };
    if (settings.useFills && stats) {
      if (stats.mpg) { s.mpg = stats.mpg; src.mpg = 'fills'; }
      if (stats.price) { s.price = stats.price; src.price = 'fills'; }
    }
    var usual = usualFare(settings, dateISO);
    s.fullFare = settings.fare;
    s.usualFare = usual.fare;
    s.fareCode = usual.code;
    if (farePaid != null && isFinite(farePaid) && farePaid >= 0) {
      s.fare = farePaid;
      if (round2(farePaid) !== round2(usual.fare)) s.fareCode = null;
    } else s.fare = usual.fare;
    s.source = src;
    return s;
  }

  /* The return fare to use on a date: the discount code fare while the code
     is switched on and not past its end date, otherwise the full fare. */
  function usualFare(settings, dateISO) {
    var on = settings.discountOn && settings.discountFare > 0 &&
      (!settings.discountEnds || !dateISO || dateISO <= settings.discountEnds);
    return on ? { fare: settings.discountFare, single: settings.discountSingle, code: settings.discountCode || 'discount', expired: false }
      : { fare: settings.fare, single: settings.single, code: null,
          expired: !!(settings.discountOn && settings.discountEnds && dateISO && dateISO > settings.discountEnds) };
  }

  /* Rework past train days with the real figures for the time:
     mpg from the tank in use that day (filled on or before it, next full fill after it),
     else the overall average; petrol price from the last fill on or before that day,
     else the earliest fill. The fare each day stored is kept (older entries without one
     use the usual fare for that date). Wear doesn't depend on mpg, so it is kept.
     Returns only the entries that change by at least 1p. */
  function recalcEntries(entries, fills, settings) {
    var stats = fillStats(fills, settings.odoUnit);
    if (!stats.mpg) return [];
    var byDate = fills.filter(function (f) { return f.litres > 0 && f.cost > 0 && isISODate(f.date); })
      .slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.ts || 0) - (b.ts || 0); });
    if (!byDate.length) return [];
    var changes = [];
    entries.forEach(function (e) {
      if (e.type !== 'train' && e.type !== 'station') return;
      var mpg = stats.mpg;
      for (var i = 0; i < stats.intervals.length; i++) {
        var iv = stats.intervals[i];
        if (iv.from <= e.date && e.date < iv.to) { mpg = iv.mpg; break; }
      }
      var fill = byDate[0];
      byDate.forEach(function (f) { if (f.date <= e.date) fill = f; });
      var price = fill.cost / fill.litres;
      var fare = e.fare != null && isFinite(e.fare) ? e.fare : usualFare(settings, e.date).fare;
      var s = Object.assign({}, settings, { mpg: mpg, price: price, fare: fare });
      var fuel = round2(trainSaving(e.type, s).fuel);
      if (Math.abs(fuel - (e.fuel || 0)) >= 0.005) {
        changes.push({ id: e.id, date: e.date, oldFuel: e.fuel || 0, fuel: fuel,
          mpg: Math.round(mpg * 10) / 10, price: Math.round(price * 1000) / 1000, fare: round2(fare) });
      }
    });
    return changes;
  }

  function validateFill(raw) {
    var errors = {};
    var num = function (v) { return parseFloat(String(v == null ? '' : v).replace(/[£,\s]/g, '')); };
    var f = { date: raw.date, odo: num(raw.odo), litres: num(raw.litres), cost: num(raw.cost), full: !!raw.full };
    if (!isISODate(f.date)) errors.date = 'Pick a date';
    if (!isFinite(f.odo) || f.odo <= 0) errors.odo = 'Enter the odometer reading';
    if (!isFinite(f.litres) || f.litres <= 0 || f.litres > 200) errors.litres = 'Enter litres added';
    if (!isFinite(f.cost) || f.cost <= 0) errors.cost = 'Enter what you paid';
    if (!errors.litres && !errors.cost) {
      var ppl = f.cost / f.litres;
      if (ppl < 0.5 || ppl > 4) errors.cost = 'That is ' + money(ppl) + ' a litre, check the figures';
    }
    return { ok: Object.keys(errors).length === 0, errors: errors, fill: f };
  }

  /* ---------- exercise ---------- */
  var M_PER_MILE = 1609.344;
  var KG_PER_LB = 0.45359237;

  /* MET values by speed (mph), from the Compendium of Physical Activities.
     Interpolated between points, clamped at the ends. */
  var MET_TABLE = {
    walk: [[2, 2.8], [2.5, 3.0], [3, 3.5], [3.5, 4.3], [4, 5.0], [4.5, 7.0]],
    run: [[4, 6.0], [5, 8.3], [6, 9.8], [7, 11.0], [8, 11.8], [9, 12.8], [10, 14.5]],
    cycle: [[5.5, 3.5], [9.4, 5.8], [11, 6.8], [13, 8.0], [15, 10.0], [17, 12.0]]
  };
  var DEFAULT_MPH = { walk: 3, run: 6, cycle: 11 };

  function metFor(kind, mph) {
    var t = MET_TABLE[kind] || MET_TABLE.walk;
    if (!(mph > 0)) mph = DEFAULT_MPH[kind] || 3;
    if (mph <= t[0][0]) return t[0][1];
    for (var i = 1; i < t.length; i++) {
      if (mph <= t[i][0]) {
        var a = t[i - 1], b = t[i];
        return a[1] + (b[1] - a[1]) * (mph - a[0]) / (b[0] - a[0]);
      }
    }
    return t[t.length - 1][1];
  }

  /* Step length in metres from height: walking about 41.5% of height, running about 65%. */
  function stepLength(heightCm, kind) {
    if (!(heightCm > 0)) return null;
    return heightCm / 100 * (kind === 'run' ? 0.65 : 0.415);
  }

  /* Fill in an exercise record. Give miles or steps (walk/run), minutes optional.
     Calories are "active" calories: (MET − 1) × kg × hours, i.e. on top of
     what you'd burn sitting still. Null when weight is not set. */
  function exerciseCalc(input, profile) {
    var kind = ['walk', 'run', 'cycle'].indexOf(input.kind) >= 0 ? input.kind : 'walk';
    var step = kind === 'cycle' ? null : stepLength(profile.heightCm, kind);
    var miles = Number(input.miles) || 0;
    var steps = Number(input.steps) || 0;
    if (!miles && steps && step) miles = steps * step / M_PER_MILE;
    if (!steps && miles && step) steps = Math.round(miles * M_PER_MILE / step);
    if (kind === 'cycle') steps = 0;
    var pace = kind === 'walk' ? profile.walkMph : kind === 'cycle' ? profile.cycleMph : DEFAULT_MPH.run;
    var mins = Number(input.mins) || 0;
    if (!mins && miles) mins = miles / (pace || DEFAULT_MPH[kind]) * 60;
    var mph = mins ? miles / (mins / 60) : pace;
    var kcal = null;
    if (profile.weightKg > 0 && mins) {
      kcal = Math.round((metFor(kind, mph) - 1) * profile.weightKg * (mins / 60));
    }
    return {
      kind: kind,
      miles: Math.round(miles * 100) / 100,
      steps: Math.round(steps),
      mins: Math.round(mins),
      kcal: kcal
    };
  }

  /* "92", "92kg", "14st 7", "14st 7lb", "14 7", "14.5", "203lb" -> kg. unit is the default unit. */
  function parseWeight(str, unit) {
    var s = String(str == null ? '' : str).toLowerCase().trim();
    if (!s) return 0;
    var nums = (s.match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) return NaN;
    if (/kg/.test(s)) unit = 'kg';
    else if (/st/.test(s)) unit = 'st';
    else if (/lb|pound/.test(s)) unit = 'lb';
    if (unit === 'kg') return nums[0];
    if (unit === 'lb') return nums[0] * KG_PER_LB;
    return (nums[0] * 14 + (nums[1] || 0)) * KG_PER_LB;
  }

  function formatWeight(kg, unit) {
    if (!(kg > 0)) return '';
    if (unit === 'kg') return (Math.round(kg * 10) / 10) + ' kg';
    var lb = kg / KG_PER_LB;
    if (unit === 'lb') return Math.round(lb) + ' lb';
    var st = Math.floor(lb / 14), rem = Math.round(lb - st * 14);
    if (rem === 14) { st++; rem = 0; }
    return st + ' st ' + rem + ' lb';
  }

  /* "178", "178cm", "5'10", "5 10", "5ft 10in", "5ft10", "1.78m" -> cm. */
  function parseHeight(str) {
    var s = String(str == null ? '' : str).toLowerCase().trim();
    if (!s) return 0;
    var nums = (s.match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) return NaN;
    if (/cm/.test(s)) return nums[0];
    if (/\d\s*m\b/.test(s) || (nums.length === 1 && nums[0] < 3)) return nums[0] * 100;
    if (/'|ft|foot|feet/.test(s) || (nums.length === 2 && nums[0] <= 8)) {
      return (nums[0] * 12 + (nums[1] || 0)) * 2.54;
    }
    if (nums[0] <= 8) return nums[0] * 12 * 2.54; // "6" = 6 ft
    return nums[0];
  }

  function formatHeight(cm) {
    if (!(cm > 0)) return '';
    var inches = Math.round(cm / 2.54);
    return Math.floor(inches / 12) + ' ft ' + (inches % 12) + ' in';
  }

  /* Exercise summary for the month of todayISO plus all time.
     records: [{date, kind, miles, steps, kcal}] */
  function exerciseTotals(records, todayISO) {
    var month = todayISO.slice(0, 7);
    var t = { walk: 0, cycle: 0, run: 0, miles: 0, steps: 0, kcal: 0, activeDays: 0, allMiles: 0, allKcal: 0, streak: 0 };
    var days = {};
    records.forEach(function (r) {
      t.allMiles += r.miles || 0;
      t.allKcal += r.kcal || 0;
      if (r.miles > 0 || r.steps > 0) days[r.date] = true;
      if (r.date.slice(0, 7) !== month || r.date > todayISO) return;
      t[r.kind] = (t[r.kind] || 0) + (r.miles || 0);
      t.miles += r.miles || 0;
      t.steps += r.steps || 0;
      t.kcal += r.kcal || 0;
    });
    Object.keys(days).forEach(function (d) { if (d.slice(0, 7) === month && d <= todayISO) t.activeDays++; });
    // Streak: weekdays in a row with some exercise, counting back from today.
    // Weekends never break it but count if active. Today not done yet doesn't break it either.
    var d = parseISO(todayISO);
    for (var i = 0; i < 400; i++) {
      var iso = toISO(d), dow = d.getDay(), weekend = dow === 0 || dow === 6;
      if (days[iso]) t.streak++;
      else if (!weekend && i > 0) break;
      d.setDate(d.getDate() - 1);
    }
    ['walk', 'cycle', 'run', 'miles', 'allMiles'].forEach(function (k) { t[k] = Math.round(t[k] * 10) / 10; });
    return t;
  }

  /* ---------- settings validation ---------- */
  var FIELDS = ['price', 'mpg', 'commuteMiles', 'fare', 'single', 'stationMiles', 'stationMpg', 'wearPence', 'target',
    'walkMiles', 'cycleMiles', 'walkMph', 'cycleMph', 'activeGoal', 'discountFare', 'discountSingle'];

  function validateSettings(raw) {
    // Settings saved by an older version may lack newer fields: fill them from the defaults.
    raw = Object.assign({}, DEFAULTS, raw || {});
    var errors = {}, clean = {};
    FIELDS.forEach(function (k) {
      var v = typeof raw[k] === 'number' ? raw[k] : parseFloat(String(raw[k] == null ? '' : raw[k]).trim());
      if (!isFinite(v) || v <= 0) errors[k] = 'Enter a number above 0';
      else clean[k] = v;
    });
    if (!errors.stationMiles && !errors.commuteMiles && clean.stationMiles >= clean.commuteMiles) {
      errors.stationMiles = 'Must be less than the commute miles';
    }
    clean.includeWear = !!raw.includeWear;
    clean.useFills = raw.useFills == null ? true : !!raw.useFills;
    clean.odoUnit = raw.odoUnit === 'km' ? 'km' : 'mi';
    // Optional body figures: 0 means not set.
    var w = Number(raw.weightKg) || 0, h = Number(raw.heightCm) || 0;
    if (w && (w < 25 || w > 300)) errors.weightKg = 'That weight looks wrong';
    else clean.weightKg = w;
    if (h && (h < 100 || h > 250)) errors.heightCm = 'That height looks wrong';
    else clean.heightCm = h;
    clean.discountOn = !!raw.discountOn;
    clean.discountCode = String(raw.discountCode || '').trim().slice(0, 20);
    clean.discountEnds = isISODate(String(raw.discountEnds || '')) ? raw.discountEnds : '';
    if (!errors.discountFare && !errors.fare && clean.discountFare > clean.fare) {
      errors.discountFare = 'Should be less than the full fare';
    }
    if (!errors.discountSingle && !errors.single && clean.discountSingle > clean.single) {
      errors.discountSingle = 'Should be less than the full single';
    }
    clean.weightUnit = ['kg', 'st', 'lb'].indexOf(raw.weightUnit) >= 0 ? raw.weightUnit : 'st';
    return { ok: Object.keys(errors).length === 0, errors: errors, settings: clean };
  }

  return {
    LITRES_PER_GALLON: LITRES_PER_GALLON,
    DEFAULTS: DEFAULTS,
    FIELDS: FIELDS,
    round2: round2,
    fuelCostPerMile: fuelCostPerMile,
    drivingCost: drivingCost,
    stationFuel: stationFuel,
    trainSaving: trainSaving,
    entrySaving: entrySaving,
    displayValue: displayValue,
    toISO: toISO,
    parseISO: parseISO,
    isISODate: isISODate,
    mondayOf: mondayOf,
    daysInMonth: daysInMonth,
    totals: totals,
    cumulativeByDay: cumulativeByDay,
    money: money,
    shortDate: shortDate,
    toCSV: toCSV,
    parseCSV: parseCSV,
    entriesFromCSV: entriesFromCSV,
    validateSettings: validateSettings,
    kmplToMpg: kmplToMpg,
    fillStats: fillStats,
    effectiveSettings: effectiveSettings,
    validateFill: validateFill,
    metFor: metFor,
    stepLength: stepLength,
    exerciseCalc: exerciseCalc,
    parseWeight: parseWeight,
    formatWeight: formatWeight,
    parseHeight: parseHeight,
    formatHeight: formatHeight,
    exerciseTotals: exerciseTotals,
    usualFare: usualFare,
    recalcEntries: recalcEntries
  };
});
