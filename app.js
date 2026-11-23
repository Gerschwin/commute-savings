/* Commute Savings: app logic. Depends on calc.js (window.Calc). */
(function () {
  'use strict';
  var C = window.Calc;

  /* ================= storage ================= */
  // IndexedDB with a localStorage fallback. Two lists (entries, fills) plus settings.
  var DB_NAME = 'commute-savings';
  var LS = { entries: 'cs.entries', fills: 'cs.fills', settings: 'cs.settings' };

  var store = (function () {
    var dbp = null;
    var mode = 'idb';

    function openDB() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
        var req;
        try { req = indexedDB.open(DB_NAME, 2); } catch (e) { return reject(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('fills')) db.createObjectStore('fills', { keyPath: 'id' });
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
    stats: null
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
      type: ['train', 'station', 'custom'].indexOf(e.type) >= 0 ? e.type : 'custom',
      label: String(e.label || '').slice(0, 120),
      fuel: C.round2(fuel),
      wear: isFinite(wear) ? C.round2(wear) : 0
    };
    // What the day was worked out with (kept for the log list; older entries won't have these).
    ['fare', 'mpg', 'price'].forEach(function (k) {
      if (e[k] != null && isFinite(Number(e[k]))) out[k] = Number(e[k]);
    });
    return out;
  }

  function sanitiseFill(f) {
    if (!f || !C.isISODate(f.date)) return null;
    var odo = Number(f.odo), litres = Number(f.litres), cost = Number(f.cost);
    if (!(odo > 0) || !(litres > 0) || !(cost > 0)) return null;
    return { id: String(f.id || uid()), date: f.date, ts: Number(f.ts) || Date.now(), odo: odo, litres: litres, cost: cost, full: !!f.full };
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
    return C.effectiveSettings(state.settings, state.stats, dayFare());
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
      toast('Added ' + C.money(C.displayValue(entry, state.settings.includeWear)) + ' · ' + C.shortDate(entry.date), function () {
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
    if (already && !confirm('A train day is already logged for ' + C.shortDate(date) + '. Add another?')) return;
    var eff = current();
    var s = C.entrySaving(mode, eff);
    addEntry({
      id: uid(), date: date, ts: Date.now(), type: mode, label: label, fuel: s.fuel, wear: s.wear,
      fare: C.round2(eff.fare), mpg: Math.round(eff.mpg * 10) / 10, price: Math.round(eff.price * 1000) / 1000
    });
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
    $('basis').textContent = 'Working out with ' + eff.mpg.toFixed(1) + ' mpg' + (eff.source.mpg === 'fills' ? ' (real)' : '') +
      ' and petrol at ' + (eff.price * 100).toFixed(1) + 'p a litre' + (eff.source.price === 'fills' ? ' (last fill)' : '') + '.';
    $('dayFare').placeholder = state.settings.fare.toFixed(2);
    $('chipReturn').textContent = C.money(state.settings.fare);
    $('chipSingles').textContent = C.money(state.settings.single * 2);
    var df = dayFare();
    document.querySelectorAll('[data-fare]').forEach(function (b) {
      var v = b.dataset.fare === 'return' ? state.settings.fare : state.settings.single * 2;
      var on = df === null ? b.dataset.fare === 'return' : C.round2(v) === df;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-amount="train"]').forEach(function (n) { n.textContent = '+' + C.money(tr); });
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
    renderChart();
  }

  var DELETE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

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
          e.fare != null ? el('span', { class: 'sub', text: 'Ticket ' + C.money(e.fare) + (e.mpg ? ' · ' + e.mpg.toFixed(1) + ' mpg · ' + (e.price * 100).toFixed(1) + 'p/L' : '') }) : null
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
    var eff = C.effectiveSettings(s, st, null);
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

  document.querySelectorAll('[data-fare]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.dataset.fare === 'return' ? state.settings.fare : state.settings.single * 2;
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

  /* ================= settings form ================= */
  var form = $('settingsForm');

  function fillSettingsForm(s) {
    C.FIELDS.forEach(function (k) { form.elements[k].value = String(s[k]); });
    form.elements.includeWear.checked = !!s.includeWear;
    clearSettingsErrors();
    updatePreview();
  }

  function clearSettingsErrors() {
    form.querySelectorAll('[data-err]').forEach(function (n) { n.textContent = ''; });
    C.FIELDS.forEach(function (k) { form.elements[k].removeAttribute('aria-invalid'); });
  }

  function readSettingsForm() {
    var raw = {};
    C.FIELDS.forEach(function (k) { raw[k] = form.elements[k].value; });
    raw.includeWear = form.elements.includeWear.checked;
    raw.useFills = state.settings.useFills;
    raw.odoUnit = state.settings.odoUnit;
    return C.validateSettings(raw);
  }

  function updatePreview() {
    var r = readSettingsForm();
    var p = $('settingsPreview');
    if (!r.ok) { p.textContent = ''; return; }
    var eff = C.effectiveSettings(r.settings, state.stats, null);
    var a = C.entrySaving('train', eff), b = C.entrySaving('station', eff);
    p.textContent = (eff.source.mpg === 'fills' || eff.source.price === 'fills' ? 'With these settings and your fuel log' : 'With these settings') + ': walked or cycled ' + C.money(a.fuel) + ' fuel + ' + C.money(a.wear) +
      ' wear, drove to station ' + C.money(b.fuel) + ' fuel + ' + C.money(b.wear) + ' wear.';
  }

  form.addEventListener('input', updatePreview);
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
    state.settings = r.settings;
    store.saveSettings(r.settings).catch(saveFailed);
    render();
    closeSettings();
    toast('Settings saved');
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
  $('openSettings').addEventListener('click', function () {
    if ($('settings').hidden) openSettings(); else closeSettings();
  });
  $('closeSettings').addEventListener('click', closeSettings);

  /* ================= wiring ================= */
  document.querySelectorAll('.big-btn').forEach(function (b) {
    b.addEventListener('click', function () { logTrain(b.dataset.mode, b.dataset.label); });
  });

  document.querySelectorAll('.chip').forEach(function (c) {
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
    var data = { app: 'commute-savings', version: 1, exported: new Date().toISOString(), settings: state.settings, entries: state.entries, fills: state.fills };
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
    .then(function () { return Promise.all([store.load('entries'), store.loadSettings(), store.load('fills')]); })
    .then(function (res) {
      state.entries = (res[0] || []).map(sanitiseEntry).filter(Boolean);
      state.fills = (res[2] || []).map(sanitiseFill).filter(Boolean);
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
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW failed', e); });
    });
  }
})();
