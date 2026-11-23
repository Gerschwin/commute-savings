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
    fare: 5.5,          // train return fare £
    stationMiles: 3.6,  // drive-to-station round trip
    stationMpg: 15,     // mpg on short cold station runs
    wearPence: 10,      // van wear pence per mile
    target: 90,         // monthly target £
    includeWear: false
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

  /* ---------- settings validation ---------- */
  var FIELDS = ['price', 'mpg', 'commuteMiles', 'fare', 'stationMiles', 'stationMpg', 'wearPence', 'target'];

  function validateSettings(raw) {
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
    validateSettings: validateSettings
  };
});
