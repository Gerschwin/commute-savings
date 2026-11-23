/* Commute Savings: app logic. Depends on calc.js (window.Calc). */
(function () {
  'use strict';
  var C = window.Calc;

  /* ================= storage ================= */
  // IndexedDB with a localStorage fallback. Two lists (entries, fills) plus settings.
  var DB_NAME = 'commute-savings';
  var LS = { entries: 'cs.entries', fills: 'cs.fills', exercise: 'cs.exercise', settings: 'cs.settings' };

  var store = (function () {
    var dbp = null;
    var mode = 'idb';

    function openDB() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
        var req;
        try { req = indexedDB.open(DB_NAME, 3); } catch (e) { return reject(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('fills')) db.createObjectStore('fills', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('exercise')) db.createObjectStore('exercise', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('blocked')); };
      });
      return dbp;
    }

    function tx(storeName, txMode, fn) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(storeName, txMode);
          var result = fn(t.objectStore(storeName));
          t.oncomplete = function () { resolve(result && 'result' in result ? result.result : result); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error); };
        });
      });
    }

    function lsGet(key, fallback) {
      try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    }
    function lsSet(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full or blocked */ }
    }

    return {
      mode: function () { return mode; },
      init: function () {
        return openDB().then(function () { mode = 'idb'; }).catch(function () { mode = 'ls'; });
      },
      load: function (name) {
        if (mode === 'ls') return Promise.resolve(lsGet(LS[name], []));
        return tx(name, 'readonly', function (s) { return s.getAll(); });
      },
      put: function (name, list) {
        if (mode === 'ls') {
          var byId = {};
          lsGet(LS[name], []).concat(list).forEach(function (e) { byId[e.id] = e; });
          lsSet(LS[name], Object.keys(byId).map(function (k) { return byId[k]; }));
          return Promise.resolve();
        }
        return tx(name, 'readwrite', function (s) { list.forEach(function (e) { s.put(e); }); });
      },
      del: function (name, id) {
        if (mode === 'ls') {
          lsSet(LS[name], lsGet(LS[name], []).filter(function (e) { return e.id !== id; }));
          return Promise.resolve();
        }
        return tx(name, 'readwrite', function (s) { s.delete(id); });
      },
      replace: function (name, list) {
        if (mode === 'ls') { lsSet(LS[name], list); return Promise.resolve(); }
        return tx(name, 'readwrite', function (s) { s.clear(); list.forEach(function (e) { s.put(e); }); });
      },
      loadSettings: function () {
        if (mode === 'ls') return Promise.resolve(lsGet(LS.settings, null));
        return tx('kv', 'readonly', function (s) { return s.get('settings'); });
      },
      saveSettings: function (obj) {
        if (mode === 'ls') { lsSet(LS.settings, obj); return Promise.resolve(); }
        return tx('kv', 'readwrite', function (s) { s.put(obj, 'settings'); });
      }
    };
  })();

  /* ================= state ================= */
  var state = {
    entries: [],
    settings: Object.assign({}, C.DEFAULTS),
    listLimit: 30,
    fills: [],
    stats: null,
    exercise: []
  };

  function todayISO() { return C.toISO(new Date()); }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function sortEntries() {
    state.entries.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.ts || 0) - (a.ts || 0);
    });
  }

  function sanitiseEntry(e) {
    if (!e || !C.isISODate(e.date)) return null;
    var fuel = Number(e.fuel), wear = Number(e.wear || 0);
    if (!isFinite(fuel)) return null;
    var out = {
      id: String(e.id || uid()),
      date: e.date,
      ts: Number(e.ts) || Date.now(),
      type: C.TYPES.indexOf(e.type) >= 0 ? e.type : 'custom',
      label: String(e.label || '').slice(0, 120),
      fuel: C.round2(fuel),
      wear: isFinite(wear) ? C.round2(wear) : 0
    };
    // What the day was worked out with (kept for the log list; older entries won't have these).
    ['fare', 'mpg', 'price'].forEach(function (k) {
      if (e[k] != null && isFinite(Number(e[k]))) out[k] = Number(e[k]);
    });
    if (e.code) out.code = String(e.code).slice(0, 20);
    ['ex', 'ex2'].forEach(function (k) {
      if (e[k]) { var ex = sanitiseEx(Object.assign({ date: e.date }, e[k])); if (ex) out[k] = exPart(ex); }
    });
    return out;
  }

  function sanitiseFill(f) {
    if (!f || !C.isISODate(f.date)) return null;
    var odo = Number(f.odo), litres = Number(f.litres), cost = Number(f.cost);
    if (!(odo > 0) || !(litres > 0) || !(cost > 0)) return null;
    return { id: String(f.id || uid()), date: f.date, ts: Number(f.ts) || Date.now(), odo: odo, litres: litres, cost: cost, full: !!f.full };
  }

  /* Exercise records. Commute walks/rides live on the train entry (entry.ex)
     so undo and delete keep them together; other exercise is its own list. */
  function sanitiseEx(x) {
    if (!x || !C.isISODate(x.date)) return null;
    var miles = Number(x.miles) || 0, steps = Number(x.steps) || 0;
    if (!(miles > 0) && !(steps > 0)) return null;
    return {
      id: String(x.id || uid()), date: x.date, ts: Number(x.ts) || Date.now(),
      kind: ['walk', 'run', 'cycle', 'phone'].indexOf(x.kind) >= 0 ? x.kind : 'walk',
      label: String(x.label || '').slice(0, 80),
      miles: miles, steps: Math.round(steps), mins: Math.round(Number(x.mins) || 0),
      kcal: x.kcal == null || !isFinite(Number(x.kcal)) ? null : Math.round(Number(x.kcal))
    };
  }
  function exPart(x) { return { kind: x.kind, miles: x.miles, steps: x.steps, mins: x.mins, kcal: x.kcal }; }

  /* Records logged before weight or height were set have no calories or
     steps; work them out now from the miles, so adding them later fills
     in the past too. */
  function fillIn(x) {
    var s = state.settings;
    var needKcal = x.kcal == null && s.weightKg > 0;
    var needSteps = !x.steps && x.kind !== 'cycle' && s.heightCm > 0;
    if (!(x.miles > 0) || (!needKcal && !needSteps)) return x;
    var r = C.exerciseCalc({ kind: x.kind, miles: x.miles, mins: x.mins }, s);
    var y = Object.assign({}, x);
    if (needKcal) y.kcal = r.kcal;
    if (needSteps) y.steps = r.steps;
    return y;
  }
  function entryExercise(e) {
    return [e.ex, e.ex2].filter(Boolean).map(fillIn);
  }
  /* "4.8 mi walked, 10,460 steps, 430 kcal" for a train day. */
  function exSummary(parts) {
    if (!parts.length) return '';
    var steps = 0, kcal = 0, anyKcal = false;
    var bits = parts.map(function (x) {
      steps += x.steps || 0;
      if (x.kcal != null) { kcal += x.kcal; anyKcal = true; }
      return x.miles + ' mi ' + (x.kind === 'cycle' ? 'cycled' : 'walked');
    });
    if (steps) bits.push(fmtInt(steps) + ' steps');
    if (anyKcal) bits.push(fmtInt(kcal) + ' kcal');
    return bits.join(', ');
  }

  /* Every exercise record, commute ones included, newest first. A phone
     steps record becomes the walking above what the app already has that day. */
  function allExercise() {
    var list = state.exercise.filter(function (x) { return x.kind !== 'phone'; }).map(fillIn);
    state.entries.forEach(function (e) {
      if (e.ex) list.push(Object.assign({ id: 'e:' + e.id, entryId: e.id, date: e.date, ts: e.ts, label: 'Commute' }, fillIn(e.ex)));
      if (e.ex2) list.push(Object.assign({ id: 'e2:' + e.id, entryId: e.id, date: e.date, ts: e.ts, label: 'Commute' }, fillIn(e.ex2)));
    });
    state.exercise.forEach(function (ph) {
      if (ph.kind !== 'phone') return;
      var other = 0;
      list.forEach(function (x) { if (x.date === ph.date && x.kind !== 'cycle') other += x.steps || 0; });
      var w = C.phoneWalk(ph.steps, other, state.settings);
      list.push(Object.assign({ id: ph.id, date: ph.date, ts: ph.ts, label: 'Phone steps', phoneTotal: ph.steps, phoneOther: other }, w));
    });
    return list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.ts || 0) - (a.ts || 0); });
  }

  function recalcStats() {
    state.stats = C.fillStats(state.fills, state.settings.odoUnit);
  }

  /* Fare typed into "Ticket cost today", or the usual fare if blank or invalid. */
  function dayFare() {
    var raw = $('dayFare').value.trim();
    if (raw === '') return null;
    var v = parseFloat(raw.replace(/[£,\s]/g, ''));
    return isFinite(v) && v >= 0 ? C.round2(v) : null;
  }

  /* Settings a train day logged right now would use. */
  function current() {
    return C.effectiveSettings(state.settings, state.stats, dayFare(), selectedDate());
  }

  /* ================= DOM helpers ================= */
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  /* ================= toast with undo ================= */
  var toastTimer = null, toastUndo = null;
  function toast(text, undoFn) {
    clearTimeout(toastTimer);
    $('toastText').textContent = text;
    toastUndo = undoFn || null;
    $('toastUndo').hidden = !undoFn;
    $('toast').hidden = false;
    toastTimer = setTimeout(hideToast, undoFn ? 6000 : 3500);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    toastUndo = null;
  }
  $('toastUndo').addEventListener('click', function () {
    var fn = toastUndo;
    hideToast();
    if (fn) fn();
  });

  /* ================= actions ================= */
  function addEntry(entry, silent) {
    state.entries.push(entry);
    sortEntries();
    render();
    store.put('entries', [entry]).catch(saveFailed);
    if (!silent) {
      var exNote = exSummary(entryExercise(entry));
      if (exNote) exNote = ' · ' + exNote;
      toast('Added ' + C.money(C.displayValue(entry, state.settings.includeWear)) + exNote + ' · ' + C.shortDate(entry.date), function () {
        removeEntry(entry.id, true);
        toast('Removed');
      });
    }
  }

  function removeEntry(id, silent) {
    var entry = null;
    state.entries = state.entries.filter(function (e) {
      if (e.id === id) { entry = e; return false; }
      return true;
    });
    if (!entry) return;
    render();
    store.del('entries', id).catch(saveFailed);
    if (!silent) {
      toast('Deleted ' + (entry.label || 'entry'), function () {
        addEntry(entry, true);
        toast('Restored');
      });
    }
  }

  function saveFailed(err) {
    console.error(err);
    toast('Could not save. Storage may be full or blocked.');
  }

  function selectedDate() {
    var v = $('logDate').value;
    return C.isISODate(v) ? v : todayISO();
  }

  function logTrain(mode, label) {
    var date = selectedDate();
    var already = state.entries.some(function (e) { return e.date === date && e.type !== 'custom'; });
    if (already && !confirm('A commute day is already logged for ' + C.shortDate(date) + '. Add another?')) return;
    var eff = current();
    var s = C.entrySaving(mode, eff);
    var entry = { id: uid(), date: date, ts: Date.now(), type: mode, label: label, fuel: s.fuel, wear: s.wear };
    if (mode === 'train' || mode === 'station') {
      entry.fare = C.round2(eff.fare);
      if (eff.fareCode) entry.code = eff.fareCode;
    }
    if (mode !== 'off') { entry.mpg = Math.round(eff.mpg * 10) / 10; entry.price = Math.round(eff.price * 1000) / 1000; }
    var how = mode === 'station' ? 'station' : /cycled/i.test(label) ? 'cycled' : /walked/i.test(label) ? 'walked' : '';
    var parts = C.commuteExercise(how, state.settings);
    if (parts[0]) entry.ex = parts[0];
    if (parts[1]) entry.ex2 = parts[1];
    addEntry(entry);
  }

  function parseAmount(str) {
    var v = parseFloat(String(str).replace(/[£,\s]/g, ''));
    return isFinite(v) ? C.round2(v) : NaN;
  }

  /* ================= rendering ================= */
  function render() {
    var s = state.settings;
    var today = todayISO();
    var t = C.totals(state.entries, today, s.includeWear);
    var now = C.parseISO(today);

    // hero
    $('monthName').textContent = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    $('heroAmount').textContent = C.money(t.month);
    $('heroDays').textContent = t.trainDaysMonth + (t.trainDaysMonth === 1 ? ' train day' : ' train days');

    var pct = s.target > 0 ? Math.max(0, Math.min(100, t.month / s.target * 100)) : 0;
    $('progressFill').style.width = pct + '%';
    $('progress').setAttribute('aria-valuenow', String(Math.round(pct)));
    var toGo = C.round2(s.target - t.month);
    var toGoEl = $('toGo');
    if (toGo <= 0) { toGoEl.textContent = 'Target reached'; toGoEl.className = 'reached'; }
    else { toGoEl.textContent = C.money(toGo) + ' to go'; toGoEl.className = ''; }
    $('targetText').textContent = 'target ' + C.money(s.target);

    // button amounts (what a tap would add now)
    var eff = current();
    var tr = C.displayValue(C.entrySaving('train', eff), s.includeWear);
    var st = C.displayValue(C.entrySaving('station', eff), s.includeWear);
    var usual = C.usualFare(s, selectedDate());
    var basis = 'Ticket ' + C.money(eff.fare) + (eff.fareCode ? ' with ' + eff.fareCode : '') + '. ';
    if (usual.expired) basis = 'Code ' + (s.discountCode || '') + ' ended ' + C.shortDate(s.discountEnds) + ', so the full fare is used. ';
    $('basis').textContent = basis + 'Working out with ' + eff.mpg.toFixed(1) + ' mpg' + (eff.source.mpg === 'fills' ? ' (real)' : '') +
      ' and petrol at ' + (eff.price * 100).toFixed(1) + 'p a litre' + (eff.source.price === 'fills' ? ' (last fill)' : '') + '.';
    $('dayFare').placeholder = usual.fare.toFixed(2);
    $('chipReturnName').textContent = usual.code ? usual.code + ' return' : 'Day return';
    $('chipReturn').textContent = C.money(usual.fare);
    $('chipFull').textContent = C.money(s.fare);
    $('chipFullBtn').hidden = !usual.code;
    $('chipSingles').textContent = C.money(usual.single * 2);
    var df = dayFare();
    document.querySelectorAll('[data-fare]').forEach(function (b) {
      var v = fareFor(b.dataset.fare);
      var on = df === null ? b.dataset.fare === 'return' : C.round2(v) === df;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-amount="train"]').forEach(function (n) { n.textContent = '+' + C.money(tr); });
    var lf = C.displayValue(C.entrySaving('lift', eff), s.includeWear);
    document.querySelectorAll('[data-amount="lift"]').forEach(function (n) { n.textContent = '+' + C.money(lf); });
    document.querySelectorAll('[data-amount="station"]').forEach(function (n) { n.textContent = (st >= 0 ? '+' : '') + C.money(st); });

    // totals
    $('tToday').textContent = C.money(t.today);
    $('tWeek').textContent = C.money(t.week);
    $('tMonth').textContent = C.money(t.month);
    $('tYear').textContent = C.money(t.year);
    $('tAll').textContent = C.money(t.all);
    $('wearHint').textContent = s.includeWear ? 'Totals include van wear.' : 'Fuel savings only. Van wear can be added in Settings.';

    renderList();
    renderFuel();
    renderExercise();
    renderChart();
  }

  var DELETE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  function entrySub(e) {
    var fuel = e.mpg ? e.mpg.toFixed(1) + ' mpg · ' + (e.price * 100).toFixed(1) + 'p/L' : '';
    if (e.type === 'off') return 'Holiday, sick or home. Keeps your streak.';
    if (e.type === 'lift') return 'No fare, whole drive saved' + (fuel ? ' · ' + fuel : '');
    if (e.fare != null) return 'Ticket ' + C.money(e.fare) + (e.code ? ' (' + e.code + ')' : '') + (fuel ? ' · ' + fuel : '');
    return '';
  }

  function renderList() {
    var list = $('logList');
    list.textContent = '';
    var shown = state.entries.slice(0, state.listLimit);
    shown.forEach(function (e) {
      var v = C.displayValue(e, state.settings.includeWear);
      var del = el('button', { type: 'button', class: 'del', 'aria-label': 'Delete ' + (e.label || 'entry') + ' on ' + C.shortDate(e.date) });
      del.innerHTML = DELETE_ICON;
      del.addEventListener('click', function () { removeEntry(e.id); });
      list.appendChild(el('li', null, [
        el('div', null, [
          el('span', { class: 'when', text: C.shortDate(e.date) + (e.date.slice(0, 4) !== todayISO().slice(0, 4) ? ' ' + e.date.slice(0, 4) : '') }),
          el('span', { class: 'what', text: e.label || (e.type === 'custom' ? 'Other saving' : 'Train') }),
          entrySub(e) ? el('span', { class: 'sub', text: entrySub(e) }) : null,
          exSummary(entryExercise(e)) ? el('span', { class: 'sub ex-sub', text: exSummary(entryExercise(e)) }) : null
        ]),
        el('span', { class: 'amt' + (v < 0 ? ' neg' : ''), text: C.money(v) }),
        del
      ]));
    });
    $('logEmpty').hidden = state.entries.length > 0;
    var more = $('showMore');
    more.hidden = state.entries.length <= state.listLimit;
    more.textContent = 'Show more (' + (state.entries.length - state.listLimit) + ' older)';
  }

  /* ---------- chart: stepped cumulative area in inline SVG ---------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function renderChart() {
    var box = $('chart');
    var W = Math.max(200, Math.floor(box.clientWidth));
    var H = Math.max(120, Math.floor(box.clientHeight));
    var today = todayISO();
    var d = C.parseISO(today);
    var y = d.getFullYear(), m = d.getMonth();
    var days = C.daysInMonth(y, m);
    var todayIdx = d.getDate(); // 1-based
    var cum = C.cumulativeByDay(state.entries, y, m, state.settings.includeWear);
    var target = state.settings.target;
    var maxVal = Math.max(target * 1.15, Math.max.apply(null, cum.concat([0])) * 1.1, 1);
    var minVal = Math.min(0, Math.min.apply(null, cum));

    var padL = 8, padR = 8, padT = 10, padB = 24;
    var iw = W - padL - padR, ih = H - padT - padB;
    var X = function (i) { return padL + (i / days) * iw; };      // i = 0..days (day boundaries)
    var Y = function (v) { return padT + ih - ((v - minVal) / (maxVal - minVal)) * ih; };

    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true' });

    // baseline
    root.appendChild(svg('line', { class: 'grid', x1: padL, x2: W - padR, y1: Y(0), y2: Y(0) }));

    // stepped area up to today (future days are not drawn)
    var pts = [];
    for (var i = 0; i < todayIdx; i++) {
      pts.push([X(i), Y(cum[i])], [X(i + 1), Y(cum[i])]);
    }
    if (pts.length) {
      var line = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L');
      var area = line + ' L' + X(todayIdx).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z';
      root.appendChild(svg('path', { class: 'area', d: area }));
      root.appendChild(svg('path', { class: 'line', d: line }));
      root.appendChild(svg('circle', { cx: X(todayIdx), cy: Y(cum[todayIdx - 1]), r: 4.5 }));
    }

    // today marker
    if (todayIdx < days) {
      root.appendChild(svg('line', { class: 'today', x1: X(todayIdx), x2: X(todayIdx), y1: padT, y2: Y(0) }));
    }

    // dashed target line + label
    var ty = Y(target);
    root.appendChild(svg('line', { class: 'target', x1: padL, x2: W - padR, y1: ty, y2: ty }));
    var tl = svg('text', { class: 'target-label', x: padL + 2, y: ty - 6 });
    tl.textContent = 'Target ' + C.money(target).replace('.00', '');
    root.appendChild(tl);

    // day labels
    var ticks = [1, 8, 15, 22, days];
    ticks.forEach(function (day, k) {
      var tx = svg('text', {
        x: X(day - 0.5), y: H - 6,
        'text-anchor': k === 0 ? 'start' : (k === ticks.length - 1 ? 'end' : 'middle')
      });
      if (k === 0) tx.setAttribute('x', X(0));
      if (k === ticks.length - 1) tx.setAttribute('x', X(days));
      tx.textContent = String(day);
      root.appendChild(tx);
    });

    box.textContent = '';
    box.appendChild(root);
    box.setAttribute('aria-label', 'Cumulative savings this month: ' + C.money(cum[todayIdx - 1]) + ' of a ' + C.money(target) + ' target.');
  }

  /* ================= fuel log ================= */
  function sortFills() {
    state.fills.sort(function (a, b) { return b.odo - a.odo || (a.date < b.date ? 1 : -1); });
  }

  function renderFuel() {
    var st = state.stats || C.fillStats([], 'mi');
    var s = state.settings;
    $('fMpg').textContent = st.mpg ? st.mpg.toFixed(1) : '–';
    $('fPrice').textContent = st.price ? (st.price * 100).toFixed(1) + 'p' : '–';
    var eff = C.effectiveSettings(s, st, null, todayISO());
    $('fPerMile').textContent = st.mpg || st.price ? (C.fuelCostPerMile(eff.price, eff.mpg) * 100).toFixed(1) + 'p' : '–';

    var note;
    if (!state.fills.length) note = 'No fill-ups yet, so your Settings figures (' + s.mpg + ' mpg, ' + (s.price * 100).toFixed(1) + 'p a litre) are used.';
    else if (!st.mpg) note = 'Real mpg appears after your next full tank. Until then ' + s.mpg + ' mpg from Settings is used.';
    else {
      note = 'Average of your last ' + st.used + (st.used === 1 ? ' tank' : ' tanks');
      if (st.used > 1 && st.lastMpg) note += ', last tank ' + st.lastMpg.toFixed(1) + ' mpg';
      note += '. Petrol price from ' + C.shortDate(st.priceDate) + '.';
      var drive = C.drivingCost(eff);
      note += ' The ' + s.commuteMiles + ' mile commute costs ' + C.money(drive) + ' in fuel.';
    }
    $('fuelNote').textContent = note;
    $('useFills').checked = !!s.useFills;
    var changes = C.recalcEntries(state.entries, state.fills, s);
    $('recalcBox').hidden = !changes.length;
    $('recalcBtn').textContent = 'Recalculate ' + changes.length + ' past day' + (changes.length === 1 ? '' : 's') + ' with real figures';
    if (!changes.length) $('recalcPanel').hidden = true;
    $('odoUnit').value = s.odoUnit;

    var list = $('fillList');
    list.textContent = '';
    state.fills.slice(0, 8).forEach(function (f) {
      var del = el('button', { type: 'button', class: 'del', 'aria-label': 'Delete fill-up on ' + C.shortDate(f.date) });
      del.innerHTML = DELETE_ICON;
      del.addEventListener('click', function () { removeFill(f.id); });
      var unit = s.odoUnit === 'km' ? ' km' : ' mi';
      list.appendChild(el('li', null, [
        el('div', null, [
          el('span', { class: 'when', text: C.shortDate(f.date) + ' · ' + Math.round(f.odo).toLocaleString('en-GB') + unit }),
          el('span', { class: 'what', text: f.litres.toFixed(2) + ' L at ' + (f.cost / f.litres * 100).toFixed(1) + 'p' + (f.full ? '' : ' (top-up)') })
        ]),
        el('span', { class: 'amt plain', text: C.money(f.cost) }),
        del
      ]));
    });
  }

  function addFill(fill, silent) {
    state.fills.push(fill);
    sortFills();
    recalcStats();
    render();
    store.put('fills', [fill]).catch(saveFailed);
    if (!silent) {
      var st = state.stats;
      var msg = 'Fill-up added' + (st.mpg ? ' · ' + st.mpg.toFixed(1) + ' mpg' : '');
      toast(msg, function () { removeFill(fill.id, true); toast('Removed'); });
    }
  }

  function removeFill(id, silent) {
    var fill = null;
    state.fills = state.fills.filter(function (f) { if (f.id === id) { fill = f; return false; } return true; });
    if (!fill) return;
    recalcStats();
    render();
    store.del('fills', id).catch(saveFailed);
    if (!silent) toast('Deleted fill-up', function () { addFill(fill, true); toast('Restored'); });
  }

  /* Rework past train days with the real mpg and price of the time (preview, confirm, undo). */
  function withChanges(entries, changes) {
    var by = {};
    changes.forEach(function (c) { by[c.id] = c; });
    return entries.map(function (e) {
      var c = by[e.id];
      if (!c) return e;
      return Object.assign({}, e, { fuel: c.fuel, mpg: c.mpg, price: c.price, fare: c.fare != null ? c.fare : e.fare, recalc: Date.now() });
    });
  }

  $('recalcBtn').addEventListener('click', function () {
    var changes = C.recalcEntries(state.entries, state.fills, state.settings);
    if (!changes.length) return;
    var text = changes.length + (changes.length === 1 ? ' day changes. ' : ' days change. ') + changeSummary(changes);
    text += 'Each day uses the mpg of the tank you were on and the petrol price of the time. The fare you paid stays the same.';
    $('recalcText').textContent = text;
    $('recalcGo').textContent = 'Update ' + changes.length + (changes.length === 1 ? ' day' : ' days');
    $('recalcPanel').hidden = false;
    $('recalcBtn').hidden = true;
  });
  $('recalcCancel').addEventListener('click', function () {
    $('recalcPanel').hidden = true;
    $('recalcBtn').hidden = false;
  });
  $('recalcGo').addEventListener('click', function () {
    var changes = C.recalcEntries(state.entries, state.fills, state.settings);
    $('recalcPanel').hidden = true;
    $('recalcBtn').hidden = false;
    applyChanges(changes);
  });

  function changeSummary(changes) {
    var inc = state.settings.includeWear, today = todayISO();
    var before = C.totals(state.entries, today, inc), after = C.totals(withChanges(state.entries, changes), today, inc);
    var text = '';
    if (before.month !== after.month) text += 'This month: ' + C.money(before.month) + ' becomes ' + C.money(after.month) + '. ';
    if (before.all !== before.month || after.all !== after.month) {
      text += 'All time: ' + C.money(before.all) + ' becomes ' + C.money(after.all) + '. ';
    }
    return text;
  }

  function applyChanges(changes) {
    if (!changes.length) return;
    var ids = {};
    changes.forEach(function (c) { ids[c.id] = true; });
    var previous = state.entries.filter(function (e) { return ids[e.id]; }).map(function (e) { return Object.assign({}, e); });
    var before = C.totals(state.entries, todayISO(), state.settings.includeWear).all;
    state.entries = withChanges(state.entries, changes);
    var updated = state.entries.filter(function (e) { return ids[e.id]; });
    store.put('entries', updated).catch(saveFailed);
    render();
    var diff = C.round2(C.totals(state.entries, todayISO(), state.settings.includeWear).all - before);
    toast('Updated ' + changes.length + (changes.length === 1 ? ' day' : ' days') + ' (' + (diff >= 0 ? '+' : '') + C.money(diff) + ')', function () {
      var back = {};
      previous.forEach(function (e) { back[e.id] = e; });
      state.entries = state.entries.map(function (e) { return back[e.id] || e; });
      store.put('entries', previous).catch(saveFailed);
      render();
      toast('Recalculation undone');
    });
  }

  /* Offer to apply a new Settings mpg or petrol price to past days. */
  var pendingSet = null;
  function offerSettingsRecalc(oldS, newS) {
    var changes = C.recalcFromSettings(state.entries, oldS, newS);
    if (!changes.length) { $('setRecalc').hidden = true; pendingSet = null; return false; }
    pendingSet = { oldS: oldS, newS: newS };
    var what = [];
    if (Math.abs(oldS.mpg - newS.mpg) >= 0.05) what.push(oldS.mpg + ' to ' + newS.mpg + ' mpg');
    if (Math.abs(oldS.price - newS.price) >= 0.0005) what.push(C.money(oldS.price) + ' to ' + C.money(newS.price) + ' a litre');
    var n = changes.length + (changes.length === 1 ? ' past day' : ' past days');
    $('setRecalcText').textContent = 'Use ' + what.join(' and ') + ' for the ' + n + ' worked out with the old figure? ' +
      changeSummary(changes) + 'Days from your fuel log and the fares you paid stay as they are.';
    $('setRecalcGo').textContent = 'Update ' + n;
    $('setRecalc').hidden = false;
    return true;
  }
  $('setRecalcGo').addEventListener('click', function () {
    $('setRecalc').hidden = true;
    if (!pendingSet) return;
    var changes = C.recalcFromSettings(state.entries, pendingSet.oldS, pendingSet.newS);
    pendingSet = null;
    applyChanges(changes);
  });
  $('setRecalcNo').addEventListener('click', function () {
    $('setRecalc').hidden = true;
    pendingSet = null;
    toast('Past days left as they were');
  });

  var fillForm = $('fillForm');
  function fillRaw() {
    return {
      date: fillForm.elements.date.value, odo: fillForm.elements.odo.value,
      litres: fillForm.elements.litres.value, cost: fillForm.elements.cost.value, full: fillForm.elements.full.checked
    };
  }
  fillForm.addEventListener('input', function () {
    var r = C.validateFill(fillRaw());
    var p = $('fillPreview');
    p.textContent = '';
    if (!r.errors.litres && !r.errors.cost) p.textContent = (r.fill.cost / r.fill.litres * 100).toFixed(1) + 'p a litre.';
    var last = state.fills[0];
    if (!r.errors.odo && last && r.fill.odo > last.odo) {
      var unit = state.settings.odoUnit === 'km' ? ' km' : ' miles';
      p.textContent += ' ' + Math.round(r.fill.odo - last.odo).toLocaleString('en-GB') + unit + ' since the last fill.';
    }
  });
  fillForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    fillForm.querySelectorAll('[data-ferr]').forEach(function (n) { n.textContent = ''; });
    var r = C.validateFill(fillRaw());
    var dup = !r.errors.odo && state.fills.some(function (f) { return f.odo === r.fill.odo; });
    if (dup) { r.ok = false; r.errors.odo = 'A fill-up at this reading is already logged'; }
    if (!r.ok) {
      Object.keys(r.errors).forEach(function (k) {
        var n = fillForm.querySelector('[data-ferr="' + k + '"]');
        if (n) n.textContent = r.errors[k];
      });
      return;
    }
    var last = state.fills[0];
    if (last && r.fill.odo < last.odo && r.fill.date > last.date &&
        !confirm('That reading is lower than your last fill (' + Math.round(last.odo) + '). Add it anyway?')) return;
    addFill(Object.assign({ id: uid(), ts: Date.now() }, r.fill));
    ['odo', 'litres', 'cost'].forEach(function (k) { fillForm.elements[k].value = ''; });
    fillForm.elements.full.checked = true;
    $('fillPreview').textContent = '';
  });

  function saveSettingsQuietly() {
    store.saveSettings(state.settings).catch(saveFailed);
  }
  $('useFills').addEventListener('change', function () {
    state.settings = Object.assign({}, state.settings, { useFills: $('useFills').checked });
    saveSettingsQuietly();
    render();
  });
  $('odoUnit').addEventListener('change', function () {
    state.settings = Object.assign({}, state.settings, { odoUnit: $('odoUnit').value });
    saveSettingsQuietly();
    recalcStats();
    render();
  });

  $('logDate').addEventListener('change', render);

  function fareFor(kind) {
    var s = state.settings;
    if (kind === 'return') return C.usualFare(s, selectedDate()).fare;
    if (kind === 'full') return s.fare;
    return C.usualFare(s, selectedDate()).single * 2;
  }

  document.querySelectorAll('[data-fare]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = fareFor(b.dataset.fare);
      $('dayFare').value = C.round2(v).toFixed(2);
      $('dayFare').setAttribute('aria-invalid', 'false');
      render();
    });
  });

  $('dayFare').addEventListener('input', function () {
    var raw = $('dayFare').value.trim();
    $('dayFare').setAttribute('aria-invalid', raw !== '' && dayFare() === null ? 'true' : 'false');
    render();
  });

  /* ================= exercise ================= */
  var KIND_WORD = { walk: 'Walk', run: 'Run', cycle: 'Cycle' };

  function fmtInt(n) { return Math.round(n).toLocaleString('en-GB'); }

  /* A rotating, honest motivator built from this month's numbers. */
  /* A food the month's calories add up to, the biggest one that fits at least once. */
  var FOODS = [
    { kcal: 2500, one: 'a whole day of eating', many: 'whole days of eating' },
    { kcal: 800, one: 'a takeaway curry', many: 'takeaway curries' },
    { kcal: 330, one: 'a sausage roll', many: 'sausage rolls' },
    { kcal: 230, one: 'a chocolate bar', many: 'chocolate bars' },
    { kcal: 200, one: 'a pint of lager', many: 'pints of lager' },
    { kcal: 90, one: 'a chocolate biscuit', many: 'chocolate biscuits' }
  ];
  function foodLine(kcal) {
    if (!(kcal > 0)) return '';
    for (var i = 0; i < FOODS.length; i++) {
      var n = kcal / FOODS[i].kcal;
      if (n >= 1) {
        var whole = Math.floor(n * 2) / 2;
        return '≈ ' + (whole === 1 ? FOODS[i].one : String(whole).replace('.5', '½') + ' ' + FOODS[i].many);
      }
    }
    return '≈ ' + Math.round(kcal / 90 * 10) / 10 + ' of a biscuit';
  }

  function motivator(t, s) {
    var lines = [];
    if (t.kcal >= 3500) lines.push('That\'s roughly ' + (t.kcal / 3500).toFixed(1) + ' lb of body fat worth of energy this month.');
    if (t.kcal >= 230) lines.push('You\'ve burned off about ' + fmtInt(t.kcal / 230) + ' chocolate bar' + (t.kcal >= 460 ? 's' : '') + ' this month.');
    if (t.kcal >= 200) lines.push('That\'s about ' + fmtInt(t.kcal / 200) + ' pint' + (t.kcal >= 400 ? 's' : '') + ' of lager worked off this month.');
    if (t.steps >= 10000) lines.push(fmtInt(t.steps) + ' steps this month, about ' + (t.steps / 10000).toFixed(1) + ' days\' worth of the 10,000 a day target.');
    if (t.miles > 0) lines.push(t.miles + ' miles under your own steam this month instead of sitting in traffic on the M8.');
    if (t.streak >= 3) lines.push(t.streak + ' active days in a row. Keep it going tomorrow.');
    if (!lines.length) return t.allMiles > 0 ? 'New month, fresh start. Walk or cycle to the station to get going.' : 'Walk or cycle to the station and it shows up here.';
    var d = new Date();
    return lines[(d.getDate() + d.getMonth()) % lines.length];
  }

  function renderExercise() {
    var s = state.settings;
    var list = allExercise();
    var rest = {};
    state.entries.forEach(function (e) { if (e.type === 'off') rest[e.date] = true; });
    var t = C.exerciseTotals(list, todayISO(), rest);
    var noBody = !(s.weightKg > 0) || !(s.heightCm > 0);
    $('exProfileHint').hidden = !noBody;
    $('exWalk').innerHTML = (t.walk + t.run) + '<small>mi</small>';
    $('exCycle').innerHTML = t.cycle + '<small>mi</small>';
    $('exSteps').textContent = t.steps ? fmtInt(t.steps) : (s.heightCm > 0 ? '0' : '–');
    $('exKcal').textContent = t.kcal ? fmtInt(t.kcal) : (s.weightKg > 0 ? '0' : '–');
    $('exKcalFood').textContent = foodLine(t.kcal);
    $('exStepsDay').textContent = t.steps && t.activeDays ? 'about ' + fmtInt(t.steps / t.activeDays) + ' a day' : '';

    var pct = s.activeGoal > 0 ? Math.min(100, t.miles / s.activeGoal * 100) : 0;
    $('exProgressFill').style.width = pct + '%';
    $('exProgress').setAttribute('aria-valuenow', String(Math.round(pct)));
    var left = Math.round((s.activeGoal - t.miles) * 10) / 10;
    $('exGoalText').textContent = left <= 0 ? 'Goal reached' : left + ' active miles to go';
    $('exGoalText').className = left <= 0 ? 'reached' : '';
    $('exGoalTarget').textContent = 'goal ' + s.activeGoal + ' mi';
    $('exMotivator').textContent = motivator(t, s);
    $('exStreak').hidden = t.streak < 2;
    $('exStreak').textContent = t.streak + ' day streak';

    var ul = $('exList');
    ul.textContent = '';
    list.slice(0, 8).forEach(function (x) {
      var bits = [x.miles + ' mi'];
      if (x.steps) bits.push(fmtInt(x.steps) + ' steps');
      if (x.mins) bits.push(x.mins + ' min');
      var what = KIND_WORD[x.kind] + ', ' + bits.join(', ');
      if (x.phoneTotal != null) {
        what = fmtInt(x.phoneTotal) + ' on the phone' + (x.extra
          ? ', ' + fmtInt(x.extra) + ' more than logged, ' + x.miles + ' mi'
          : ', no more than already logged');
      }
      var children = [
        el('div', null, [
          el('span', { class: 'when', text: C.shortDate(x.date) + ' · ' + (x.entryId ? 'Commute' : (x.label || KIND_WORD[x.kind])) }),
          el('span', { class: 'what', text: what })
        ]),
        el('span', { class: 'amt', text: x.kcal != null ? fmtInt(x.kcal) + ' kcal' : '' })
      ];
      if (x.entryId) {
        children.push(el('span', { class: 'del', title: 'Delete the train day to remove this', 'aria-hidden': 'true' }));
      } else {
        var del = el('button', { type: 'button', class: 'del', 'aria-label': 'Delete ' + (x.phoneTotal != null ? 'phone steps' : KIND_WORD[x.kind].toLowerCase()) + ' on ' + C.shortDate(x.date) });
        del.innerHTML = DELETE_ICON;
        del.addEventListener('click', function () { removeExercise(x.id); });
        children.push(del);
      }
      ul.appendChild(el('li', null, children));
    });
  }

  function addExercise(x, silent) {
    state.exercise.push(x);
    render();
    store.put('exercise', [x]).catch(saveFailed);
    if (!silent) {
      toast('Added ' + x.miles + ' mi ' + KIND_WORD[x.kind].toLowerCase() + (x.kcal != null ? ' · ' + fmtInt(x.kcal) + ' kcal' : ''),
        function () { removeExercise(x.id, true); toast('Removed'); });
    }
  }

  function removeExercise(id, silent) {
    var x = null;
    state.exercise = state.exercise.filter(function (r) { if (r.id === id) { x = r; return false; } return true; });
    if (!x) return;
    render();
    store.del('exercise', id).catch(saveFailed);
    if (!silent) toast('Deleted exercise', function () { addExercise(x, true); toast('Restored'); });
  }

  var exForm = $('exForm');
  function exInput() {
    return {
      kind: exForm.elements.kind.value,
      miles: parseFloat(exForm.elements.miles.value) || 0,
      steps: parseInt(String(exForm.elements.steps.value).replace(/[,\s]/g, ''), 10) || 0,
      mins: parseInt(exForm.elements.mins.value, 10) || 0
    };
  }
  function exPreview() {
    var inp = exInput();
    $('exStepsField').hidden = inp.kind === 'cycle';
    $('exError').textContent = '';
    if (!inp.miles && !inp.steps) {
      $('exPreview').textContent = 'Your commute walking and cycling is added for you when you log a train day (distances in Settings).';
      return;
    }
    if (!inp.miles && !(state.settings.heightCm > 0)) {
      $('exPreview').textContent = 'Add your height in Settings to turn steps into miles.';
      return;
    }
    var r = C.exerciseCalc(inp, state.settings);
    var bits = [r.miles + ' mi'];
    if (r.steps && !inp.steps) bits.push('about ' + fmtInt(r.steps) + ' steps');
    bits.push(r.mins + ' min');
    if (r.kcal != null) bits.push('about ' + fmtInt(r.kcal) + ' kcal');
    $('exPreview').textContent = bits.join(', ') + '.';
  }
  exForm.addEventListener('input', exPreview);
  exForm.addEventListener('change', exPreview);
  exForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var inp = exInput();
    if (inp.kind === 'cycle') inp.steps = 0;
    var err = '';
    if (!inp.miles && !inp.steps) err = inp.kind === 'cycle' ? 'Enter the miles.' : 'Enter miles or steps.';
    else if (!inp.miles && !(state.settings.heightCm > 0)) err = 'Add your height in Settings first, or enter miles.';
    else if (inp.miles > 200 || inp.steps > 100000) err = 'That looks too big, check the figure.';
    $('exError').textContent = err;
    if (err) return;
    var date = C.isISODate(exForm.elements.date.value) ? exForm.elements.date.value : todayISO();
    var r = C.exerciseCalc(inp, state.settings);
    addExercise(sanitiseEx(Object.assign({ id: uid(), ts: Date.now(), date: date }, r)));
    ['miles', 'steps', 'mins'].forEach(function (k) { exForm.elements[k].value = ''; });
    exPreview();
  });
  $('exOpenSettings').addEventListener('click', function () { openSettings(); });

  /* Phone steps: one total per day; saving again for the same day replaces it. */
  var phoneForm = $('phoneForm');
  function phonePreview() {
    var n = parseInt(String(phoneForm.elements.steps.value).replace(/[,\s]/g, ''), 10) || 0;
    var date = C.isISODate(phoneForm.elements.date.value) ? phoneForm.elements.date.value : todayISO();
    var other = 0;
    allExercise().forEach(function (x) { if (x.date === date && x.phoneTotal == null && x.kind !== 'cycle') other += x.steps || 0; });
    if (!n) {
      $('phonePreview').textContent = other ? 'The app has ' + fmtInt(other) + ' steps for that day so far. Only steps above that are added.'
        : 'Only steps above what the app already has for that day are added, as easy walking.';
      return;
    }
    var w = C.phoneWalk(n, other, state.settings);
    $('phonePreview').textContent = w.extra
      ? fmtInt(w.extra) + ' more than logged: ' + w.miles + ' mi' + (w.kcal != null ? ', ' + fmtInt(w.kcal) + ' kcal' : '') + '.'
      : 'No more than the ' + fmtInt(other) + ' steps already logged for that day, so nothing extra.';
  }
  phoneForm.addEventListener('input', phonePreview);
  phoneForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var n = parseInt(String(phoneForm.elements.steps.value).replace(/[,\s]/g, ''), 10) || 0;
    if (!(n > 0) || n > 100000) { $('phonePreview').textContent = n > 100000 ? 'That looks too big, check the figure.' : 'Enter the steps from your phone.'; return; }
    var date = C.isISODate(phoneForm.elements.date.value) ? phoneForm.elements.date.value : todayISO();
    var old = state.exercise.filter(function (x) { return x.kind === 'phone' && x.date === date; });
    var rec = sanitiseEx({ id: uid(), ts: Date.now(), date: date, kind: 'phone', steps: n, miles: 0 });
    state.exercise = state.exercise.filter(function (x) { return old.indexOf(x) < 0; });
    old.forEach(function (x) { store.del('exercise', x.id).catch(saveFailed); });
    state.exercise.push(rec);
    store.put('exercise', [rec]).catch(saveFailed);
    render();
    phoneForm.elements.steps.value = '';
    phonePreview();
    var shown = allExercise().filter(function (x) { return x.id === rec.id; })[0];
    toast('Saved ' + fmtInt(n) + ' steps for ' + C.shortDate(date) + (shown && shown.extra ? ' · +' + shown.miles + ' mi' + (shown.kcal != null ? ', ' + fmtInt(shown.kcal) + ' kcal' : '') : ''), function () {
      state.exercise = state.exercise.filter(function (x) { return x.id !== rec.id; }).concat(old);
      store.del('exercise', rec.id).catch(saveFailed);
      if (old.length) store.put('exercise', old).catch(saveFailed);
      render();
      toast('Undone');
    });
  });

  /* ================= settings form ================= */
  var form = $('settingsForm');

  /* £ boxes show two decimal places (petrol price keeps a third if it has one, e.g. 1.459). */
  function moneyText(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[£,\s]/g, ''));
    if (!isFinite(n)) return String(v == null ? '' : v);
    var three = Math.round(n * 1000) / 1000;
    return Math.abs(three * 100 - Math.round(three * 100)) > 1e-6 ? three.toFixed(3) : n.toFixed(2);
  }
  document.addEventListener('change', function (ev) {
    var n = ev.target;
    if (n && n.hasAttribute && n.hasAttribute('data-money') && n.value.trim() !== '') n.value = moneyText(n.value);
  });

  function fillSettingsForm(s) {
    C.FIELDS.concat(C.OPTIONAL).forEach(function (k) {
      var n = form.elements[k];
      n.value = n.hasAttribute('data-money') ? moneyText(s[k]) : String(s[k]);
    });
    form.elements.includeWear.checked = !!s.includeWear;
    form.elements.discountOn.checked = !!s.discountOn;
    form.elements.discountCode.value = s.discountCode || '';
    form.elements.discountEnds.value = s.discountEnds || '';
    form.elements.weightUnit.value = s.weightUnit || 'st';
    form.elements.weightKg.value = C.formatWeight(s.weightKg, s.weightUnit);
    form.elements.heightCm.value = s.heightCm ? C.formatHeight(s.heightCm) : '';
    clearSettingsErrors();
    updateBodyConv();
    updatePreview();
  }

  function clearSettingsErrors() {
    form.querySelectorAll('[data-err]').forEach(function (n) { n.textContent = ''; });
    C.FIELDS.concat(C.OPTIONAL, ['weightKg', 'heightCm']).forEach(function (k) { form.elements[k].removeAttribute('aria-invalid'); });
  }

  function readSettingsForm() {
    var raw = {};
    C.FIELDS.concat(C.OPTIONAL).forEach(function (k) { raw[k] = form.elements[k].value; });
    raw.includeWear = form.elements.includeWear.checked;
    raw.useFills = state.settings.useFills;
    raw.odoUnit = state.settings.odoUnit;
    raw.discountOn = form.elements.discountOn.checked;
    raw.discountCode = form.elements.discountCode.value;
    raw.discountEnds = form.elements.discountEnds.value;
    raw.weightUnit = form.elements.weightUnit.value;
    var w = C.parseWeight(form.elements.weightKg.value, raw.weightUnit);
    var h = C.parseHeight(form.elements.heightCm.value);
    raw.weightKg = isFinite(w) ? w : 0;
    raw.heightCm = isFinite(h) ? h : 0;
    var r = C.validateSettings(raw);
    if (!isFinite(w)) { r.ok = false; r.errors.weightKg = 'Enter a weight, e.g. 14 7 or 92'; }
    if (!isFinite(h)) { r.ok = false; r.errors.heightCm = "Enter a height, e.g. 5'10 or 178"; }
    if (r.settings.weightKg) r.settings.weightKg = Math.round(r.settings.weightKg * 10) / 10;
    if (r.settings.heightCm) r.settings.heightCm = Math.round(r.settings.heightCm);
    return r;
  }

  function updateBodyConv() {
    var unit = form.elements.weightUnit.value;
    var w = C.parseWeight(form.elements.weightKg.value, unit);
    var h = C.parseHeight(form.elements.heightCm.value);
    $('weightConv').textContent = w > 0 ? '= ' + (unit === 'kg' ? C.formatWeight(w, 'st') : C.formatWeight(w, 'kg')) : '';
    $('heightConv').textContent = h > 0 ? '= ' + Math.round(h) + ' cm (' + C.formatHeight(h) + ')' : '';
  }

  function legText(s) {
    var say = function (parts) {
      return parts.map(function (x) { return x.miles + ' mi ' + (x.kind === 'cycle' ? 'cycled' : 'walked'); }).join(' + ') || 'nothing';
    };
    return 'Walked days: ' + say(C.commuteExercise('walked', s)) + '. Cycled days: ' + say(C.commuteExercise('cycled', s)) +
      '. Drove to station: ' + say(C.commuteExercise('station', s)) + '. Set station to work to 0 if you don\'t walk that bit.';
  }

  function updatePreview() {
    var r = readSettingsForm();
    var p = $('settingsPreview');
    $('legHint').textContent = r.ok ? legText(r.settings) : '';
    if (!r.ok) { p.textContent = ''; return; }
    var eff = C.effectiveSettings(r.settings, state.stats, null, todayISO());
    var a = C.entrySaving('train', eff), b = C.entrySaving('station', eff);
    p.textContent = (eff.source.mpg === 'fills' || eff.source.price === 'fills' ? 'With these settings and your fuel log' : 'With these settings') + ': walked or cycled ' + C.money(a.fuel) + ' fuel + ' + C.money(a.wear) +
      ' wear, drove to station ' + C.money(b.fuel) + ' fuel + ' + C.money(b.wear) + ' wear.';
  }

  form.addEventListener('input', function () { updatePreview(); updateBodyConv(); });
  form.elements.weightUnit.addEventListener('change', updateBodyConv);
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    clearSettingsErrors();
    var r = readSettingsForm();
    if (!r.ok) {
      var first = null;
      Object.keys(r.errors).forEach(function (k) {
        form.querySelector('[data-err="' + k + '"]').textContent = r.errors[k];
        form.elements[k].setAttribute('aria-invalid', 'true');
        if (!first) first = form.elements[k];
      });
      if (first) first.focus();
      return;
    }
    var oldSettings = state.settings;
    state.settings = r.settings;
    store.saveSettings(r.settings).catch(saveFailed);
    render();
    closeSettings();
    if (offerSettingsRecalc(oldSettings, r.settings)) toast('Settings saved');
    else toast('Settings saved');
  });
  // km/L to mpg helper
  $('kmplUse').addEventListener('click', function () {
    var v = parseFloat($('kmplIn').value);
    if (!(v > 0)) { $('kmplOut').textContent = 'Enter the km/L figure from the dashboard.'; return; }
    var mpg = Math.round(C.kmplToMpg(v) * 10) / 10;
    form.elements.mpg.value = String(mpg);
    $('kmplOut').textContent = v + ' km/L is ' + mpg + ' mpg. Press Save settings to keep it.';
    updatePreview();
  });

  // Season ticket / Flexipass helper: price ÷ days travelled
  $('passUse').addEventListener('click', function () {
    var price = parseFloat(String($('passPrice').value).replace(/[£,\s]/g, ''));
    var days = parseInt($('passDays').value, 10);
    if (!(price > 0) || !(days > 0)) { $('passOut').textContent = 'Enter the ticket price and the number of days you will travel on it.'; return; }
    var perDay = C.round2(price / days);
    form.elements.fare.value = perDay.toFixed(2);
    $('passOut').textContent = C.money(price) + ' over ' + days + ' days is ' + C.money(perDay) + ' a day. Press Save settings to keep it.';
    updatePreview();
  });

  $('resetSettings').addEventListener('click', function () {
    fillSettingsForm(C.DEFAULTS);
  });

  function openSettings() {
    fillSettingsForm(state.settings);
    $('settings').hidden = false;
    $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeSettings() {
    $('settings').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // Install card: only in a browser tab, only when Chrome offers to install.
  var installEvt = null;
  function inApp() {
    return ['fullscreen', 'standalone', 'minimal-ui'].some(function (m) {
      return window.matchMedia && matchMedia('(display-mode: ' + m + ')').matches;
    }) || navigator.standalone === true;
  }
  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    installEvt = ev;
    var snoozed = 0;
    try { snoozed = Number(localStorage.getItem('cs.installSnooze')) || 0; } catch (e) {}
    if (!inApp() && Date.now() > snoozed) $('installCard').hidden = false;
  });
  $('installGo').addEventListener('click', function () {
    $('installCard').hidden = true;
    if (!installEvt) return;
    installEvt.prompt();
    installEvt = null;
  });
  $('installNo').addEventListener('click', function () {
    $('installCard').hidden = true;
    try { localStorage.setItem('cs.installSnooze', String(Date.now() + 7 * 864e5)); } catch (e) {}
  });
  window.addEventListener('appinstalled', function () {
    $('installCard').hidden = true;
    toast('Installed. Open it from the new icon on your home screen.');
  });

  // Theme: follow the phone (auto), or always dark / light. Per device.
  var THEMES = ['auto', 'dark', 'light'];
  var THEME_NAMES = { auto: 'Match phone', dark: 'Dark', light: 'Light' };
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : 'auto';
  }
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try { if (t === 'auto') localStorage.removeItem('cs.theme'); else localStorage.setItem('cs.theme', t); } catch (e) {}
    var dark = t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      if (t === 'auto') m.setAttribute('content', m.getAttribute('media').indexOf('dark') > -1 ? '#111111' : '#ffffff');
      else m.setAttribute('content', dark ? '#111111' : '#ffffff');
    });
    $('themeBtn').setAttribute('aria-label', 'Theme: ' + THEME_NAMES[t] + '. Tap to change.');
  }
  applyTheme(currentTheme());
  $('themeBtn').addEventListener('click', function () {
    var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next);
    toast('Theme: ' + THEME_NAMES[next]);
  });

  $('openSettings').addEventListener('click', function () {
    if ($('settings').hidden) openSettings(); else closeSettings();
  });
  $('closeSettings').addEventListener('click', closeSettings);

  /* ================= wiring ================= */
  document.querySelectorAll('.big-btn').forEach(function (b) {
    b.addEventListener('click', function () { logTrain(b.dataset.mode, b.dataset.label); });
  });

  document.querySelectorAll('#chips .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      $('otherLabel').value = c.dataset.label;
      $('otherAmount').value = Number(c.dataset.amount).toFixed(2);
      $('otherError').textContent = '';
      $('otherAmount').focus();
    });
  });

  $('otherForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var label = $('otherLabel').value.trim();
    var amount = parseAmount($('otherAmount').value);
    var err = '';
    if (!label) err = 'Say what the saving was.';
    else if (!(amount > 0)) err = 'Enter an amount above £0.';
    $('otherError').textContent = err;
    if (err) return;
    addEntry({ id: uid(), date: selectedDate(), ts: Date.now(), type: 'custom', label: label, fuel: amount, wear: 0 });
    $('otherLabel').value = '';
    $('otherAmount').value = '';
  });

  $('showMore').addEventListener('click', function () {
    state.listLimit += 50;
    renderList();
  });

  /* ---------- export / import ---------- */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function readFile(input, cb) {
    var f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { cb(String(r.result)); };
    r.onerror = function () { toast('Could not read that file.'); };
    r.readAsText(f);
  }

  function fingerprint(e) { return [e.date, e.type, e.label, e.fuel, e.wear].join('|'); }

  $('exportCsv').addEventListener('click', function () {
    if (!state.entries.length) { toast('Nothing to export yet.'); return; }
    var oldestFirst = state.entries.slice().reverse();
    download('commute-savings-' + todayISO() + '.csv', '﻿' + C.toCSV(oldestFirst), 'text/csv;charset=utf-8');
  });

  $('importCsv').addEventListener('change', function (ev) {
    readFile(ev.target, function (text) {
      var r;
      try { r = C.entriesFromCSV(text); } catch (e) { toast(e.message); return; }
      var seen = {};
      state.entries.forEach(function (e) { seen[fingerprint(e)] = true; });
      var now = Date.now();
      var fresh = r.entries.filter(function (e) { return !seen[fingerprint(e)]; }).map(function (e, i) {
        return Object.assign({ id: uid(), ts: now + i }, e);
      });
      var dupes = r.entries.length - fresh.length;
      if (!fresh.length) { toast('No new entries found' + (dupes ? ' (' + dupes + ' already here).' : '.')); return; }
      state.entries = state.entries.concat(fresh);
      sortEntries();
      render();
      store.put('entries', fresh).catch(saveFailed);
      var ids = fresh.map(function (e) { return e.id; });
      toast('Imported ' + fresh.length + (dupes ? ', ' + dupes + ' already here' : '') + (r.skipped ? ', ' + r.skipped + ' skipped' : ''), function () {
        state.entries = state.entries.filter(function (e) { return ids.indexOf(e.id) < 0; });
        render();
        Promise.all(ids.map(function (id) { return store.del('entries', id); })).catch(saveFailed);
        toast('Import undone');
      });
    });
  });

  $('backupJson').addEventListener('click', function () {
    var data = { app: 'commute-savings', version: 1, exported: new Date().toISOString(), settings: state.settings, entries: state.entries, fills: state.fills, exercise: state.exercise };
    download('commute-savings-backup-' + todayISO() + '.json', JSON.stringify(data, null, 2), 'application/json');
  });

  $('restoreJson').addEventListener('change', function (ev) {
    readFile(ev.target, function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { toast('That is not a valid backup file.'); return; }
      var list = Array.isArray(data) ? data : (data && data.entries);
      if (!Array.isArray(list)) { toast('That is not a Commute Savings backup.'); return; }
      var clean = list.map(sanitiseEntry).filter(Boolean);
      var msg = 'Replace everything on this device with the backup?\n\n' + clean.length + ' entries in the backup, ' +
        state.entries.length + ' on this device now.';
      if (!confirm(msg)) return;
      var prevEntries = state.entries.slice(), prevSettings = state.settings, prevFills = state.fills.slice();
      var restoreFills = Array.isArray(data.fills);
      var prevEx = state.exercise.slice(), restoreEx = Array.isArray(data.exercise);
      if (restoreEx) {
        state.exercise = data.exercise.map(sanitiseEx).filter(Boolean);
        store.replace('exercise', state.exercise).catch(saveFailed);
      }
      if (restoreFills) {
        state.fills = data.fills.map(sanitiseFill).filter(Boolean);
        store.replace('fills', state.fills).catch(saveFailed);
      }
      state.entries = clean;
      sortEntries();
      if (data.settings) {
        var v = C.validateSettings(data.settings);
        if (v.ok) { state.settings = v.settings; store.saveSettings(v.settings).catch(saveFailed); }
      }
      recalcStats();
      render();
      store.replace('entries', clean).catch(saveFailed);
      toast('Restored ' + clean.length + ' entries', function () {
        state.entries = prevEntries;
        state.settings = prevSettings;
        if (restoreFills) { state.fills = prevFills; store.replace('fills', prevFills).catch(saveFailed); }
        if (restoreEx) { state.exercise = prevEx; store.replace('exercise', prevEx).catch(saveFailed); }
        recalcStats();
        sortEntries();
        render();
        store.replace('entries', prevEntries).catch(saveFailed);
        store.saveSettings(prevSettings).catch(saveFailed);
        toast('Restore undone');
      });
    });
  });

  /* ---------- date picker ---------- */
  function resetDate() {
    var t = todayISO();
    fillForm.elements.date.max = t;
    if (!fillForm.elements.date.value) fillForm.elements.date.value = t;
    exForm.elements.date.max = t;
    phoneForm.elements.date.max = t;
    if (!phoneForm.elements.date.value) phoneForm.elements.date.value = t;
    if (!exForm.elements.date.value) exForm.elements.date.value = t;
    $('logDate').max = t;
    if (!$('logDate').value || $('logDate').value > t) $('logDate').value = t;
  }

  // Keep "today" right if the app stays open past midnight.
  var lastDay = todayISO();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var t = todayISO();
    if (t !== lastDay) { lastDay = t; $('logDate').value = t; resetDate(); render(); }
  });

  if ('ResizeObserver' in window) {
    var lastW = 0;
    new ResizeObserver(function (entries) {
      var w = Math.round(entries[0].contentRect.width);
      if (w !== lastW) { lastW = w; renderChart(); }
    }).observe($('chart'));
  } else {
    window.addEventListener('resize', renderChart);
  }

  /* ================= boot ================= */
  resetDate();
  store.init()
    .then(function () { return Promise.all([store.load('entries'), store.loadSettings(), store.load('fills'), store.load('exercise')]); })
    .then(function (res) {
      state.entries = (res[0] || []).map(sanitiseEntry).filter(Boolean);
      state.fills = (res[2] || []).map(sanitiseFill).filter(Boolean);
      state.exercise = (res[3] || []).map(sanitiseEx).filter(Boolean);
      if (res[1]) {
        var v = C.validateSettings(res[1]);
        if (v.ok) state.settings = v.settings;
      }
      sortEntries();
      recalcStats();
      $('storageNote').textContent = store.mode() === 'idb' ? '' : 'Saving in basic browser storage (IndexedDB is unavailable here).';
      render();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    })
    .catch(function (err) { console.error(err); render(); toast('Could not load saved data.'); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // When a new version takes over, reload once so it shows straight away.
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) { hadController = true; return; }
      reloaded = true;
      location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // Android keeps the app in memory, so check for a new version each time it comes back.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function (e) { console.warn('SW failed', e); });
    });
    // Show the installed version in the footer.
    if (window.caches) caches.keys().then(function (keys) {
      var k = keys.filter(function (n) { return n.indexOf('cs-shell-') === 0; }).sort().pop();
      if (k) $('appVersion').textContent = ' · ' + k.replace('cs-shell-', '');
    }).catch(function () {});
  }
})();
