/* Commute Savings: app logic. Depends on calc.js (window.Calc). */
(function () {
  'use strict';
  var C = window.Calc;

  /* ================= storage ================= */
  var DB_NAME = 'commute-savings';
  var LS_ENTRIES = 'cs.entries';
  var LS_SETTINGS = 'cs.settings';

  var store = (function () {
    var dbp = null;

    function openDB() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
        var req;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('blocked')); };
      });
      return dbp;
    }

    function tx(storeName, mode, fn) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(storeName, mode);
          var s = t.objectStore(storeName);
          var result = fn(s);
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

    var mode = 'idb';
    var api = {
      mode: function () { return mode; },
      init: function () {
        return openDB().then(function () { mode = 'idb'; })
          .catch(function () { mode = 'ls'; });
      },
      loadEntries: function () {
        if (mode === 'ls') return Promise.resolve(lsGet(LS_ENTRIES, []));
        return tx('entries', 'readonly', function (s) { return s.getAll(); });
      },
      putEntries: function (list) {
        if (mode === 'ls') {
          var all = lsGet(LS_ENTRIES, []);
          var byId = {};
          all.forEach(function (e) { byId[e.id] = e; });
          list.forEach(function (e) { byId[e.id] = e; });
          lsSet(LS_ENTRIES, Object.keys(byId).map(function (k) { return byId[k]; }));
          return Promise.resolve();
        }
        return tx('entries', 'readwrite', function (s) { list.forEach(function (e) { s.put(e); }); });
      },
      deleteEntry: function (id) {
        if (mode === 'ls') {
          lsSet(LS_ENTRIES, lsGet(LS_ENTRIES, []).filter(function (e) { return e.id !== id; }));
          return Promise.resolve();
        }
        return tx('entries', 'readwrite', function (s) { s.delete(id); });
      },
      replaceEntries: function (list) {
        if (mode === 'ls') { lsSet(LS_ENTRIES, list); return Promise.resolve(); }
        return tx('entries', 'readwrite', function (s) {
          s.clear();
          list.forEach(function (e) { s.put(e); });
        });
      },
      loadSettings: function () {
        if (mode === 'ls') return Promise.resolve(lsGet(LS_SETTINGS, null));
        return tx('kv', 'readonly', function (s) { return s.get('settings'); });
      },
      saveSettings: function (obj) {
        if (mode === 'ls') { lsSet(LS_SETTINGS, obj); return Promise.resolve(); }
        return tx('kv', 'readwrite', function (s) { s.put(obj, 'settings'); });
      }
    };
    return api;
  })();

  /* ================= state ================= */
  var state = {
    entries: [],
    settings: Object.assign({}, C.DEFAULTS),
    listLimit: 30
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
    return {
      id: String(e.id || uid()),
      date: e.date,
      ts: Number(e.ts) || Date.now(),
      type: ['train', 'station', 'custom'].indexOf(e.type) >= 0 ? e.type : 'custom',
      label: String(e.label || '').slice(0, 120),
      fuel: C.round2(fuel),
      wear: isFinite(wear) ? C.round2(wear) : 0
    };
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
    store.putEntries([entry]).catch(saveFailed);
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
    store.deleteEntry(id).catch(saveFailed);
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
    var s = C.entrySaving(mode, state.settings);
    addEntry({ id: uid(), date: date, ts: Date.now(), type: mode, label: label, fuel: s.fuel, wear: s.wear });
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
    var tr = C.displayValue(C.entrySaving('train', s), s.includeWear);
    var st = C.displayValue(C.entrySaving('station', s), s.includeWear);
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
          el('span', { class: 'what', text: e.label || (e.type === 'custom' ? 'Other saving' : 'Train') })
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
    return C.validateSettings(raw);
  }

  function updatePreview() {
    var r = readSettingsForm();
    var p = $('settingsPreview');
    if (!r.ok) { p.textContent = ''; return; }
    var a = C.entrySaving('train', r.settings), b = C.entrySaving('station', r.settings);
    p.textContent = 'With these settings: walked or cycled ' + C.money(a.fuel) + ' fuel + ' + C.money(a.wear) +
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
      store.putEntries(fresh).catch(saveFailed);
      var ids = fresh.map(function (e) { return e.id; });
      toast('Imported ' + fresh.length + (dupes ? ', ' + dupes + ' already here' : '') + (r.skipped ? ', ' + r.skipped + ' skipped' : ''), function () {
        state.entries = state.entries.filter(function (e) { return ids.indexOf(e.id) < 0; });
        render();
        Promise.all(ids.map(store.deleteEntry)).catch(saveFailed);
        toast('Import undone');
      });
    });
  });

  $('backupJson').addEventListener('click', function () {
    var data = { app: 'commute-savings', version: 1, exported: new Date().toISOString(), settings: state.settings, entries: state.entries };
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
      var prevEntries = state.entries.slice(), prevSettings = state.settings;
      state.entries = clean;
      sortEntries();
      if (data.settings) {
        var v = C.validateSettings(data.settings);
        if (v.ok) { state.settings = v.settings; store.saveSettings(v.settings).catch(saveFailed); }
      }
      render();
      store.replaceEntries(clean).catch(saveFailed);
      toast('Restored ' + clean.length + ' entries', function () {
        state.entries = prevEntries;
        state.settings = prevSettings;
        sortEntries();
        render();
        store.replaceEntries(prevEntries).catch(saveFailed);
        store.saveSettings(prevSettings).catch(saveFailed);
        toast('Restore undone');
      });
    });
  });

  /* ---------- date picker ---------- */
  function resetDate() {
    var t = todayISO();
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
    .then(function () { return Promise.all([store.loadEntries(), store.loadSettings()]); })
    .then(function (res) {
      state.entries = (res[0] || []).map(sanitiseEntry).filter(Boolean);
      if (res[1]) {
        var v = C.validateSettings(res[1]);
        if (v.ok) state.settings = v.settings;
      }
      sortEntries();
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
