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
    fare: 6.1,          // ScotRail Airdrie–Glasgow Queen Street return, from £6.10 (Nov 2026)
    single: 5.5,        // Anytime Day Single, Airdrie–Glasgow Queen Street (Nov 2026)
    stationMiles: 3.6,  // drive-to-station round trip
    stationMpg: 15,     // mpg on short cold station runs
    wearPence: 10,      // van wear pence per mile
    target: 90,         // monthly target £
    includeWear: false,
    useFills: true,     // use real mpg and price from the fuel log when there is enough data
    odoUnit: 'mi'       // odometer unit for the fuel log ("mi" or "km")
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
  function effectiveSettings(settings, stats, farePaid) {
    var s = Object.assign({}, settings);
    var src = { mpg: 'settings', price: 'settings' };
    if (settings.useFills && stats) {
      if (stats.mpg) { s.mpg = stats.mpg; src.mpg = 'fills'; }
      if (stats.price) { s.price = stats.price; src.price = 'fills'; }
    }
    if (farePaid != null && isFinite(farePaid) && farePaid >= 0) s.fare = farePaid;
    s.source = src;
    return s;
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

  /* ---------- settings validation ---------- */
  var FIELDS = ['price', 'mpg', 'commuteMiles', 'fare', 'single', 'stationMiles', 'stationMpg', 'wearPence', 'target'];

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
    validateFill: validateFill
  };
});
