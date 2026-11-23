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
    monthStart: 'payday', // 'calendar', 'payday' (a date) or 'lastFri'
    payDay: 28,           // payday date when monthStart is 'payday'
    payWeekend: true,     // payday on a weekend moves to the Friday before
    // Saved trips, picked per day in Log a day. miles = driving it, round trip.
    // fare/single = full fares; codeFare/codeSingle = with the discount code (0 = no code fare).
    // walk = miles walked each way from the far station (blank: a work day walks the usual station to work leg, others none).
    // work = a work day (counts as a commute day).
    trips: [
      // Home to work 17, work to Milngavie 8.6, Milngavie to home 20.6. Fares Nov 2026.
      // Walks: home to Airdrie station, and 0.7 miles each way from Milngavie station.
      { id: 'milngavie', name: 'Milngavie', miles: 46.2, fare: 7.6, codeFare: 6.8, single: 7.3, codeSingle: 6.55, walk: 0.7, work: true }
    ],
    homeLeg: 1.6,       // home to your station, each way (miles)
    workLeg: 0.8,       // Glasgow station to work, each way (miles); 0 if none
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
    // Got a lift: the whole drive is saved, no fare. No commute: nothing saved.
    if (mode === 'lift') return { fuel: drive, wear: s.commuteMiles * s.wearPence / 100 };
    if (mode === 'off') return { fuel: 0, wear: 0 };
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


  /* ---------- pay month ---------- */
  /* Payday in a month, as an ISO date. */
  function payday(year, monthIndex, s) {
    var rule = s && s.monthStart;
    if (rule === 'lastFri') {
      var last = new Date(year, monthIndex + 1, 0);
      last.setDate(last.getDate() - ((last.getDay() - 5 + 7) % 7));
      return toISO(last);
    }
    if (rule !== 'payday') return toISO(new Date(year, monthIndex, 1));
    var d = new Date(year, monthIndex, Math.min(Math.max(1, s.payDay || 1), daysInMonth(year, monthIndex)));
    if (s.payWeekend) {
      if (d.getDay() === 6) d.setDate(d.getDate() - 1);
      else if (d.getDay() === 0) d.setDate(d.getDate() - 2);
    }
    return toISO(d);
  }

  /* The month containing a date: payday up to the day before the next one.
     {start, end, days} with start and end inclusive ISO dates. */
  function periodFor(dateISO, s) {
    var d = parseISO(dateISO), y = d.getFullYear(), m = d.getMonth();
    var p = payday(y, m, s), start, next;
    if (dateISO >= p) { start = p; next = payday(m === 11 ? y + 1 : y, (m + 1) % 12, s); }
    else { start = payday(m === 0 ? y - 1 : y, (m + 11) % 12, s); next = p; }
    var e = parseISO(next); e.setDate(e.getDate() - 1);
    var end = toISO(e);
    var days = Math.round((parseISO(end) - parseISO(start)) / 864e5) + 1;
    return { start: start, end: end, days: days };
  }
  function calendarPeriod(dateISO) {
    return periodFor(dateISO, { monthStart: 'calendar' });
  }
  /* Day number (1-based) of a date within a period. */
  function dayInPeriod(dateISO, p) {
    return Math.round((parseISO(dateISO) - parseISO(p.start)) / 864e5) + 1;
  }

  /* Totals for today, this week (Monday start), month (calendar or pay month: period), year, all time. */
  function totals(entries, todayISO, includeWear, period) {
    var t = { today: 0, week: 0, month: 0, year: 0, all: 0, trainDaysMonth: 0, tripsMonth: 0, tripsAll: 0 };
    var weekStart = mondayOf(todayISO);
    var p = period || calendarPeriod(todayISO);
    var year = todayISO.slice(0, 4);
    var trainDates = {};
    entries.forEach(function (e) {
      var v = displayValue(e, includeWear);
      t.all += v;
      if (e.trip) t.tripsAll += v;
      if (e.date.slice(0, 4) === year) t.year += v;
      if (e.date >= p.start && e.date <= p.end) {
        t.month += v;
        if (e.trip) t.tripsMonth += v;
        else if (e.type === 'train' || e.type === 'station') trainDates[e.date] = true;
      }
      if (e.date >= weekStart && e.date <= todayISO) t.week += v;
      if (e.date === todayISO) t.today += v;
    });
    t.trainDaysMonth = Object.keys(trainDates).length;
    ['today', 'week', 'month', 'year', 'all', 'tripsMonth', 'tripsAll'].forEach(function (k) { t[k] = round2(t[k]); });
    return t;
  }

  /* Cumulative savings per day of a period: array of length period.days. */
  function cumulativeByPeriod(entries, p, includeWear) {
    var daily = new Array(p.days).fill(0);
    entries.forEach(function (e) {
      if (e.date >= p.start && e.date <= p.end) daily[dayInPeriod(e.date, p) - 1] += displayValue(e, includeWear);
    });
    var run = 0;
    return daily.map(function (v) { run += v; return round2(run); });
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
      if (TYPES.indexOf(type) < 0) type = 'custom';
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

  function tripFor(settings, id) {
    return (settings.trips || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  /* Settings for a day on a saved trip (by id) or a one-off trip (an object):
     its driving miles and fares stand in for the usual ones, so every sum
     works unchanged. A trip that isn't a work day walks only the home leg. */
  function routeSettings(settings, trip) {
    if (typeof trip === 'string') trip = tripFor(settings, trip);
    if (!trip) return settings;
    var full = trip.fare > 0 ? trip.fare : 0, code = trip.codeFare > 0 ? trip.codeFare : 0;
    var o = {
      commuteMiles: Number(trip.miles) || 0,
      fare: full, single: trip.single > 0 ? trip.single : full / 2,
      routeName: trip.name || 'Trip', tripWork: !!trip.work, tripSingle: trip.single > 0
    };
    if (code) { o.discountFare = code; o.discountSingle = trip.codeSingle > 0 ? trip.codeSingle : code / 2; }
    else o.discountOn = false;
    o.workLeg = trip.walk > 0 ? Number(trip.walk) : trip.work ? settings.workLeg : 0;
    return Object.assign({}, settings, o);
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
      if (e.type !== 'train' && e.type !== 'station' && e.type !== 'lift') return;
      var mpg = stats.mpg;
      for (var i = 0; i < stats.intervals.length; i++) {
        var iv = stats.intervals[i];
        if (iv.from <= e.date && e.date < iv.to) { mpg = iv.mpg; break; }
      }
      var fill = byDate[0];
      byDate.forEach(function (f) { if (f.date <= e.date) fill = f; });
      var price = fill.cost / fill.litres;
      var fare = e.type === 'lift' ? 0 : e.fare != null && isFinite(e.fare) ? e.fare : usualFare(settings, e.date).fare;
      var s = Object.assign({}, settings, { mpg: mpg, price: price, fare: fare }, e.miles > 0 ? { commuteMiles: e.miles } : {});
      var fuel = round2(trainSaving(e.type, s).fuel);
      if (Math.abs(fuel - (e.fuel || 0)) >= 0.005) {
        changes.push({ id: e.id, date: e.date, oldFuel: e.fuel || 0, fuel: fuel,
          mpg: Math.round(mpg * 10) / 10, price: Math.round(price * 1000) / 1000, fare: e.type === 'lift' ? null : round2(fare) });
      }
    });
    return changes;
  }

  /* After mpg or petrol price is changed in Settings: rework the past train
     days that were worked out with the old Settings figure (stored mpg/price
     equal to the old one, or not stored). Days that used fuel-log figures
     are left alone. The fare paid is kept. */
  function recalcFromSettings(entries, oldS, newS) {
    var mpgChanged = Math.abs(oldS.mpg - newS.mpg) >= 0.05;
    var priceChanged = Math.abs(oldS.price - newS.price) >= 0.0005;
    if (!mpgChanged && !priceChanged) return [];
    var changes = [];
    entries.forEach(function (e) {
      if (e.type !== 'train' && e.type !== 'station' && e.type !== 'lift') return;
      var mpg = e.mpg > 0 ? e.mpg : oldS.mpg;
      var price = e.price > 0 ? e.price : oldS.price;
      var usedMpg = mpgChanged && Math.abs(mpg - oldS.mpg) < 0.05;
      var usedPrice = priceChanged && Math.abs(price - oldS.price) < 0.0005;
      if (!usedMpg && !usedPrice) return;
      if (usedMpg) mpg = newS.mpg;
      if (usedPrice) price = newS.price;
      var fare = e.type === 'lift' ? 0 : e.fare != null && isFinite(e.fare) ? e.fare : usualFare(newS, e.date).fare;
      var fuel = round2(trainSaving(e.type, Object.assign({}, newS, { mpg: mpg, price: price, fare: fare }, e.miles > 0 ? { commuteMiles: e.miles } : {})).fuel);
      if (Math.abs(fuel - (e.fuel || 0)) >= 0.005) {
        changes.push({ id: e.id, date: e.date, oldFuel: e.fuel || 0, fuel: fuel,
          mpg: Math.round(mpg * 10) / 10, price: Math.round(price * 1000) / 1000, fare: e.type === 'lift' ? null : round2(fare) });
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

  /* The exercise a train day brings, from the two legs in Settings.
     walked: walk both legs there and back. cycled: cycle the home leg, walk
     the work leg. drove to station: walk the work leg. */
  function commuteExercise(how, s) {
    var home = 2 * (Number(s.homeLeg) || 0), work = 2 * (Number(s.workLeg) || 0);
    var parts = [];
    if (how === 'walked') parts.push({ kind: 'walk', miles: home + work });
    else if (how === 'cycled') { parts.push({ kind: 'cycle', miles: home }); parts.push({ kind: 'walk', miles: work }); }
    else if (how === 'station') parts.push({ kind: 'walk', miles: work });
    return parts.filter(function (p) { return p.miles > 0; }).map(function (p) {
      p.miles = Math.round(p.miles * 100) / 100;
      return exerciseCalc(p, s);
    });
  }

  /* Steps from the phone for a whole day. Only the steps above what the app
     already has for that day (otherSteps) are added, as easy walking at
     2.5 mph, since much of a day's steps is slow pottering about. Without a
     height, a 175 cm step length is assumed. */
  var EASY_MPH = 2.5;
  function phoneWalk(total, otherSteps, profile) {
    var extra = Math.max(0, Math.round((Number(total) || 0) - (Number(otherSteps) || 0)));
    if (!extra) return { kind: 'walk', miles: 0, steps: 0, mins: 0, kcal: null, extra: 0 };
    var p = Object.assign({}, profile, { heightCm: profile.heightCm > 0 ? profile.heightCm : 175 });
    var miles = extra * stepLength(p.heightCm, 'walk') / M_PER_MILE;
    var r = exerciseCalc({ kind: 'walk', miles: miles, steps: extra, mins: miles / EASY_MPH * 60 }, p);
    r.extra = extra;
    return r;
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
  /* restDays: dates logged as No commute; like weekends they never break the streak. */
  function exerciseTotals(records, todayISO, restDays, period) {
    restDays = restDays || {};
    var p = period || calendarPeriod(todayISO);
    var t = { walk: 0, cycle: 0, run: 0, miles: 0, steps: 0, kcal: 0, activeDays: 0, allMiles: 0, allKcal: 0, streak: 0 };
    var days = {};
    records.forEach(function (r) {
      t.allMiles += r.miles || 0;
      t.allKcal += r.kcal || 0;
      if (r.miles > 0 || r.steps > 0) days[r.date] = true;
      if (r.date < p.start || r.date > p.end || r.date > todayISO) return;
      t[r.kind] = (t[r.kind] || 0) + (r.miles || 0);
      t.miles += r.miles || 0;
      t.steps += r.steps || 0;
      t.kcal += r.kcal || 0;
    });
    Object.keys(days).forEach(function (d) { if (d >= p.start && d <= p.end && d <= todayISO) t.activeDays++; });
    // Streak: weekdays in a row with some exercise, counting back from today.
    // Weekends never break it but count if active. Today not done yet doesn't break it either.
    var d = parseISO(todayISO);
    for (var i = 0; i < 400; i++) {
      var iso = toISO(d), dow = d.getDay(), weekend = dow === 0 || dow === 6 || !!restDays[iso];
      if (days[iso]) t.streak++;
      else if (!weekend && i > 0) break;
      d.setDate(d.getDate() - 1);
    }
    ['walk', 'cycle', 'run', 'miles', 'allMiles'].forEach(function (k) { t[k] = Math.round(t[k] * 10) / 10; });
    return t;
  }

  var TYPES = ['train', 'station', 'lift', 'off', 'custom'];

  /* ---------- settings validation ---------- */
  var FIELDS = ['price', 'mpg', 'commuteMiles', 'fare', 'single', 'stationMiles', 'stationMpg', 'wearPence', 'target',
    'homeLeg', 'walkMph', 'cycleMph', 'activeGoal', 'discountFare', 'discountSingle'];
  var OPTIONAL = ['workLeg'];

  /* v1.14 kept one "second route" in route2 fields; turn it into a saved trip. */
  function tripsFromOld(raw) {
    if (!raw || raw.route2Miles == null) return null;
    if (raw.route2On === false) return [];
    var name = String(raw.route2Name || '').trim() || 'Milngavie';
    if (name === 'Milngavie' && Number(raw.route2Miles) === 46.2) return DEFAULTS.trips.map(function (t) { return Object.assign({}, t); });
    var code = Number(raw.route2Fare) || 0, full = Number(raw.route2Full) || code;
    return [{ id: 'r2', name: name, miles: Number(raw.route2Miles) || 0, fare: full, codeFare: code,
      single: Number(raw.route2Single) || 0, codeSingle: Number(raw.route2CodeSingle) || 0, work: true }];
  }

  function validateSettings(raw) {
    var oldTrips = raw && !Array.isArray(raw.trips) ? tripsFromOld(raw) : null;
    // Settings saved by an older version may lack newer fields: fill them from the defaults.
    raw = Object.assign({}, DEFAULTS, raw || {});
    if (oldTrips) raw.trips = oldTrips;
    var errors = {}, clean = {};
    FIELDS.forEach(function (k) {
      var v = typeof raw[k] === 'number' ? raw[k] : parseFloat(String(raw[k] == null ? '' : raw[k]).trim());
      if (!isFinite(v) || v <= 0) errors[k] = 'Enter a number above 0';
      else clean[k] = v;
    });
    // Optional distances: 0 is allowed.
    OPTIONAL.forEach(function (k) {
      var v = typeof raw[k] === 'number' ? raw[k] : parseFloat(String(raw[k] == null || raw[k] === '' ? '0' : raw[k]).trim());
      if (!isFinite(v) || v < 0) errors[k] = 'Enter 0 or more';
      else clean[k] = v;
    });
    if (!errors.stationMiles && !errors.commuteMiles && clean.stationMiles >= clean.commuteMiles) {
      errors.stationMiles = 'Must be less than the commute miles';
    }
    clean.monthStart = ['calendar', 'payday', 'lastFri'].indexOf(raw.monthStart) >= 0 ? raw.monthStart : 'payday';
    var pd = parseInt(raw.payDay, 10);
    if (clean.monthStart === 'payday' && !(pd >= 1 && pd <= 31)) errors.payDay = 'Enter a date from 1 to 31';
    else clean.payDay = pd >= 1 && pd <= 31 ? pd : 28;
    clean.payWeekend = !!raw.payWeekend;
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
    clean.trips = (Array.isArray(raw.trips) ? raw.trips : []).slice(0, 12).map(function (t, i) {
      t = t || {};
      var num = function (k) {
        var v = typeof t[k] === 'number' ? t[k] : parseFloat(String(t[k] == null || t[k] === '' ? '0' : t[k]).replace(/[£,\s]/g, ''));
        if (!isFinite(v) || v < 0) { errors['trips.' + i + '.' + k] = 'Enter 0 or more'; return 0; }
        return v;
      };
      var out = {
        id: String(t.id || ('t' + Date.now().toString(36) + i)).slice(0, 40),
        name: String(t.name || '').trim().slice(0, 30) || 'Trip',
        // Milngavie saved before walks existed gets its 0.7 mile walk.
        walk: t.walk == null && t.id === 'milngavie' ? 0.7 : num('walk'),
        miles: num('miles'), fare: num('fare'), codeFare: num('codeFare'), single: num('single'), codeSingle: num('codeSingle'),
        work: !!t.work
      };
      if (!errors['trips.' + i + '.miles'] && !(out.miles > 0)) errors['trips.' + i + '.miles'] = 'Enter the driving miles';
      if (!errors['trips.' + i + '.fare'] && !(out.fare > 0)) errors['trips.' + i + '.fare'] = 'Enter the return fare';
      return out;
    });
    clean.weightUnit = ['kg', 'st', 'lb'].indexOf(raw.weightUnit) >= 0 ? raw.weightUnit : 'st';
    return { ok: Object.keys(errors).length === 0, errors: errors, settings: clean };
  }

  return {
    LITRES_PER_GALLON: LITRES_PER_GALLON,
    DEFAULTS: DEFAULTS,
    FIELDS: FIELDS,
    routeSettings: routeSettings,
    tripFor: tripFor,
    TYPES: TYPES,
    OPTIONAL: OPTIONAL,
    commuteExercise: commuteExercise,
    phoneWalk: phoneWalk,
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
    cumulativeByPeriod: cumulativeByPeriod,
    payday: payday,
    periodFor: periodFor,
    dayInPeriod: dayInPeriod,
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
    recalcFromSettings: recalcFromSettings,
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
