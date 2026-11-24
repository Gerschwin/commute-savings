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
    if (e.route) out.route = String(e.route).slice(0, 30);
    if (Number(e.miles) > 0) out.miles = Number(e.miles);
    if (e.trip) out.trip = true;
    ['ex', 'ex2'].forEach(function (k) {
      if (e[k]) { var ex = sanitiseEx(Object.assign({ date: e.date }, e[k])); if (ex) out[k] = exPart(ex); }
    });
    return out;
  }

  function sanitiseFill(f) {
    if (!f || !C.isISODate(f.date)) return null;
    var odo = Number(f.odo), litres = Number(f.litres), cost = Number(f.cost);
    if (!(odo > 0) || !(litres > 0) || !(cost > 0)) return null;
    var out = { id: String(f.id || uid()), date: f.date, ts: Number(f.ts) || Date.now(), odo: odo, litres: litres, cost: cost, full: !!f.full };
    if (Number(f.ppl) > 0) out.ppl = Number(f.ppl);
    return out;
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
    return C.effectiveSettings(routeNow(), state.stats, dayFare(), selectedDate());
  }

  /* Journey picked in Log a day: '' = the usual commute, a saved trip's id, or 'oneoff'. */
  var logRoute = '';
  function oneOffTrip() {
    var m = parseFloat(String($('oneOffMiles').value).replace(/[,\s]/g, ''));
    return { name: $('oneOffName').value.trim().slice(0, 30) || 'One-off trip', miles: m > 0 ? m : 0, fare: 0, work: false };
  }
  function routeNow() {
    if (logRoute === 'oneoff') return C.routeSettings(state.settings, oneOffTrip());
    return C.routeSettings(state.settings, logRoute);
  }
  /* A one-off trip can't be worked out until it has miles and a fare. */
  function oneOffMissing() {
    if (logRoute !== 'oneoff') return '';
    if (!(oneOffTrip().miles > 0)) return 'Enter the driving miles for this trip.';
    if (dayFare() === null) return 'Enter what the ticket cost.';
    return '';
  }
  function setRoute(r) {
    logRoute = r;
    $('dayFare').value = '';
    if (r !== 'oneoff') { $('oneOffName').value = ''; $('oneOffMiles').value = ''; }
    render();
  }
  /* Miles walked on a walked day, and the legs, for a journey's settings. */
  function walkInfo(rs, name) {
    var legs = [];
    if (rs.homeLeg > 0) legs.push(rs.homeLeg + ' to the station');
    var work = rs.tripWork === undefined || rs.tripWork ? Number(state.settings.workLeg) || 0 : 0;
    if (work > 0) legs.push(work + ' station to work');
    var extra = C.round2((Number(rs.workLeg) || 0) - work);
    if (extra > 0) legs.push(extra + ' at ' + name);
    var total = C.commuteExercise('walked', rs).reduce(function (a, p) { return a + p.miles; }, 0);
    return { legs: legs, total: Math.round(total * 10) / 10 };
  }
  var routeSig = '';
  function renderRoutes() {
    var s = state.settings, trips = s.trips || [];
    if (logRoute && logRoute !== 'oneoff' && !C.tripFor(s, logRoute)) logRoute = '';
    var opts = [{ id: '', name: 'Work', rs: s }].concat(trips.map(function (t) {
      return { id: t.id, name: t.name, rs: C.routeSettings(s, t) };
    }));
    var text = opts.map(function (o) {
      var w = walkInfo(o.rs, o.name);
      return o.name + ' · ' + o.rs.commuteMiles + ' mi drive' + (w.total ? ' · ' + w.total + ' mi walk' : '');
    }).concat(['One-off trip…']);
    var sig = JSON.stringify(text);
    var sel = $('journeySel');
    if (sig !== routeSig) {
      routeSig = sig;
      sel.textContent = '';
      opts.forEach(function (o, i) { sel.appendChild(el('option', { value: o.id, text: text[i] })); });
      sel.appendChild(el('option', { value: 'oneoff', text: 'One-off trip…' }));
    }
    sel.value = logRoute;
    var rs = routeNow(), name = rs.routeName || 'Work';
    var w = walkInfo(rs, name);
    $('journeyInfo').textContent = logRoute === 'oneoff' ? 'A trip you don\'t make often. Only the walk to the station is counted.'
      : (w.legs.length ? 'Walking each way (miles): ' + w.legs.join(', ') + '. ' + w.total + ' mi on a walked day.' : 'No walking counted.') +
        (rs.tripWork === false ? ' Not a work day.' : '');
    $('oneOffBox').hidden = logRoute !== 'oneoff';
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
    var missing = oneOffMissing();
    if (missing) { toast(missing); (logRoute === 'oneoff' && !(oneOffTrip().miles > 0) ? $('oneOffMiles') : $('dayFare')).focus(); return; }
    var eff = current();
    var isTrip = !!(eff.routeName && !eff.tripWork);
    var already = !isTrip && state.entries.some(function (e) { return e.date === date && e.type !== 'custom' && !e.trip; });
    if (already && !confirm('A commute day is already logged for ' + C.shortDate(date) + '. Add another?')) return;
    var s = C.entrySaving(mode, eff);
    var entry = { id: uid(), date: date, ts: Date.now(), type: mode, label: label, fuel: s.fuel, wear: s.wear };
    if (mode === 'train' || mode === 'station') {
      entry.fare = C.round2(eff.fare);
      if (eff.fareCode) entry.code = eff.fareCode;
    }
    if (mode !== 'off' && eff.routeName) {
      entry.route = eff.routeName;
      entry.miles = eff.commuteMiles;
      if (isTrip) entry.trip = true;
    }
    if (mode !== 'off') { entry.mpg = Math.round(eff.mpg * 10) / 10; entry.price = Math.round(eff.price * 1000) / 1000; }
    var how = mode === 'station' ? 'station' : /cycled/i.test(label) ? 'cycled' : /walked/i.test(label) ? 'walked' : '';
    var parts = C.commuteExercise(how, eff);
    if (parts[0]) entry.ex = parts[0];
    if (parts[1]) entry.ex2 = parts[1];
    addEntry(entry);
    if (logRoute) setRoute('');
  }

  function parseAmount(str) {
    var v = parseFloat(String(str).replace(/[£,\s]/g, ''));
    return isFinite(v) ? C.round2(v) : NaN;
  }

  /* The month the totals use: calendar month or pay month, per Settings. */
  function payPeriod(dateISO) { return C.periodFor(dateISO || todayISO(), state.settings); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dm(iso) { return Number(iso.slice(8, 10)) + ' ' + MON[Number(iso.slice(5, 7)) - 1]; }

  /* ================= rendering ================= */
  function render() {
    var s = state.settings;
    var today = todayISO();
    var p = payPeriod();
    var t = C.totals(state.entries, today, s.includeWear, p);
    var now = C.parseISO(today);

    // hero
    $('monthName').textContent = s.monthStart === 'calendar'
      ? now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      : dm(p.start) + ' to ' + dm(p.end);
    $('heroLabel').textContent = s.monthStart === 'calendar' ? 'saved this month' : 'saved this pay month';
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
    var rs = routeNow();
    renderRoutes();
    var oneOff = logRoute === 'oneoff', missing = oneOffMissing();
    var isTrip = !!(eff.routeName && !eff.tripWork);
    $('offBtn').hidden = isTrip;
    $('offHint').hidden = isTrip;
    $('fareChips').hidden = oneOff;
    var usual = C.usualFare(rs, selectedDate());
    var where = (isTrip ? 'Trip to ' : '') + (eff.routeName || 'Work') + ', ' + eff.commuteMiles + ' miles driving. ';
    var basis = where + 'Ticket ' + C.money(eff.fare) + (eff.fareCode ? ' with ' + eff.fareCode : '') + '. ';
    if (usual.expired) basis = where + 'Code ' + (s.discountCode || '') + ' ended ' + C.shortDate(s.discountEnds) + ', so the full fare is used. ';
    $('basis').textContent = basis + 'Working out with ' + eff.mpg.toFixed(1) + ' mpg' + (eff.source.mpg === 'fills' ? ' (real)' : '') +
      ' and petrol at ' + (eff.price * 100).toFixed(1) + 'p a litre' + (eff.source.price === 'fills' ? ' (from your fill-up)' : '') + '.';
    $('dayFare').placeholder = oneOff ? 'What the ticket cost' : usual.fare.toFixed(2);
    if (missing) $('basis').textContent = missing + ' Working out with ' + eff.mpg.toFixed(1) + ' mpg and petrol at ' + (eff.price * 100).toFixed(1) + 'p a litre.';
    $('chipReturnName').textContent = usual.code ? usual.code + ' return' : 'Day return';
    $('chipReturn').textContent = C.money(usual.fare);
    $('chipFull').textContent = C.money(rs.fare);
    $('chipFullBtn').hidden = !usual.code || !(rs.fare > 0);
    $('chipSingles').parentNode.hidden = !!rs.routeName && !rs.tripSingle; // no single fare saved for this trip
    $('chipSingles').textContent = C.money(usual.single * 2);
    var df = dayFare();
    document.querySelectorAll('[data-fare]').forEach(function (b) {
      var v = fareFor(b.dataset.fare);
      var on = df === null ? b.dataset.fare === 'return' : C.round2(v) === df;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var lf = C.displayValue(C.entrySaving('lift', eff), s.includeWear);
    var dash = oneOff && !(oneOffTrip().miles > 0);
    document.querySelectorAll('[data-amount="train"]').forEach(function (n) { n.textContent = missing ? '+£–' : '+' + C.money(tr); });
    document.querySelectorAll('[data-amount="lift"]').forEach(function (n) { n.textContent = dash ? '+£–' : '+' + C.money(lf); });
    document.querySelectorAll('[data-amount="station"]').forEach(function (n) { n.textContent = missing ? '+£–' : (st >= 0 ? '+' : '') + C.money(st); });

    // totals
    $('tToday').textContent = C.money(t.today);
    $('tWeek').textContent = C.money(t.week);
    $('tMonth').textContent = C.money(t.month);
    $('tMonthLabel').textContent = s.monthStart === 'calendar' ? 'This month' : 'This pay month';
    $('tYear').textContent = C.money(t.year);
    $('tAll').textContent = C.money(t.all);
    $('tripsNote').hidden = !(t.tripsAll > 0);
    $('tripsNote').textContent = 'Includes ' + C.money(t.tripsMonth) + ' from trips this ' + (s.monthStart === 'calendar' ? 'month' : 'pay month') +
      ' (' + C.money(t.tripsAll) + ' all time).';
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
    var via = e.route ? (e.trip ? 'Trip: ' : 'Via ') + e.route + ' (' + e.miles + ' mi) · ' : '';
    if (e.type === 'lift') return via + 'No fare, whole drive saved' + (fuel ? ' · ' + fuel : '');
    if (e.fare != null) return via + 'Ticket ' + C.money(e.fare) + (e.code ? ' (' + e.code + ')' : '') + (fuel ? ' · ' + fuel : '');
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
    var p = payPeriod(today);
    var days = p.days;
    var todayIdx = C.dayInPeriod(today, p); // 1-based
    var cum = C.cumulativeByPeriod(state.entries, p, state.settings.includeWear);
    var dateOf = function (i) { var x = C.parseISO(p.start); x.setDate(x.getDate() + i - 1); return x.getDate(); };
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
      tx.textContent = String(dateOf(day));
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
          el('span', { class: 'what', text: f.litres.toFixed(2) + ' L at ' + (C.fillPrice(f) * 100).toFixed(1) + 'p' + (f.full ? '' : ' (top-up)') })
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
      // Days around this fill-up may now have a different petrol price: offer the update straight away.
      if (C.recalcEntries(state.entries, state.fills, state.settings).length) {
        $('recalcBtn').click();
        $('recalcBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
        msg += ' · past days can be updated';
      }
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
    var p = payPeriod(today);
    var before = C.totals(state.entries, today, inc, p), after = C.totals(withChanges(state.entries, changes), today, inc, p);
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
      litres: fillForm.elements.litres.value, ppl: fillForm.elements.ppl.value, cost: fillForm.elements.cost.value, full: fillForm.elements.full.checked
    };
  }
  /* Litres, price a litre and paid: once two are typed, the third fills in
     (marked .auto). Typing in a filled box makes it yours again. */
  var FILL_TRIO = ['litres', 'ppl', 'cost'];
  function trioNum(v) { var n = parseFloat(String(v).replace(/[£,\s]/g, '')); return n > 0 ? n : 0; }
  function autoFillTrio(target) {
    var el = fillForm.elements;
    if (target && FILL_TRIO.indexOf(target.name) >= 0) target.classList.remove('auto');
    var typed = FILL_TRIO.filter(function (k) { return el[k].value.trim() !== '' && !el[k].classList.contains('auto'); });
    var open = FILL_TRIO.filter(function (k) { return typed.indexOf(k) < 0; });
    if (open.length !== 1) {
      open.forEach(function (k) { if (el[k].classList.contains('auto')) { el[k].value = ''; el[k].classList.remove('auto'); } });
      return;
    }
    var L = trioNum(el.litres.value), P = trioNum(el.ppl.value), Q = trioNum(el.cost.value);
    if (P > 0 && P < 5) P = P * 100;
    var k = open[0], v = '';
    if (k === 'cost' && L && P) v = (Math.round(L * P) / 100).toFixed(2);
    else if (k === 'litres' && Q && P) v = (Math.round(Q / P * 10000) / 100).toFixed(2);
    else if (k === 'ppl' && L && Q) v = (Math.round(Q / L * 1000) / 10).toFixed(1);
    el[k].value = v;
    el[k].classList.toggle('auto', v !== '');
  }
  fillForm.addEventListener('input', function (ev) {
    autoFillTrio(ev.target);
    var r = C.validateFill(fillRaw());
    var p = $('fillPreview');
    p.textContent = '';
    var raw = fillRaw();
    if (!r.errors.litres && !r.errors.cost && !r.errors.ppl) {
      var bits = [];
      if (!String(raw.cost).trim()) bits.push('Paid ' + C.money(r.fill.cost) + '.');
      else if (!String(raw.litres).trim()) bits.push(r.fill.litres.toFixed(2) + ' litres.');
      if (!String(raw.ppl).trim()) bits.push((r.fill.cost / r.fill.litres * 100).toFixed(1) + 'p a litre.');
      p.textContent = bits.join(' ');
    }
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
    ['odo', 'litres', 'ppl', 'cost'].forEach(function (k) { fillForm.elements[k].value = ''; fillForm.elements[k].classList.remove('auto'); });
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
  // The calendar icon is hidden, so tapping anywhere on the date opens the picker.
  $('logDate').addEventListener('click', function () {
    try { if (this.showPicker) this.showPicker(); } catch (e) {}
  });
  ['oneOffName', 'oneOffMiles'].forEach(function (id) { $(id).addEventListener('input', render); });
  $('journeySel').addEventListener('change', function () { setRoute($('journeySel').value); });

  function fareFor(kind) {
    var s = routeNow();
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
  /* Calories as body fat: about 3,500 kcal a pound (7,700 a kilo). A rule of
     thumb, fine for a motivator. Shown in st & lb, lb or kg, as in Settings. */
  function fatText(kcal) {
    if (!(kcal > 0)) return '';
    if (state.settings.weightUnit === 'kg') {
      var kg = kcal / 7700;
      return kg >= 1 ? kg.toFixed(1) + ' kg' : fmtInt(kg * 1000) + ' g';
    }
    var lb = kcal / 3500;
    if (state.settings.weightUnit === 'st' && lb >= 14) {
      var st = Math.floor(lb / 14), rest = Math.round(lb - st * 14);
      if (rest === 14) { st++; rest = 0; }
      return st + ' st' + (rest ? ' ' + rest + ' lb' : '');
    }
    if (lb >= 1) return lb.toFixed(1) + ' lb';
    var oz = Math.round(lb * 16);
    return oz >= 1 ? oz + ' oz' : 'under 1 oz';
  }
  function foodLine(kcal) {
    var f = fatText(kcal);
    return f ? '≈ ' + f + ' of fat' : '';
  }

  function motivator(t, s) {
    if (t.allKcal > 0) return 'About ' + fatText(t.allKcal) + ' of fat burned off so far.';
    if (!(s.weightKg > 0)) return 'Add your weight in Settings to see how much fat you\'ve burned off.';
    return 'Walk or cycle to the station and the fat you burn off shows up here.';
  }

  function renderExercise() {
    var s = state.settings;
    var list = allExercise();
    var rest = {};
    state.entries.forEach(function (e) { if (e.type === 'off') rest[e.date] = true; });
    var t = C.exerciseTotals(list, todayISO(), rest, payPeriod());
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
    form.elements.monthStart.value = s.monthStart || 'payday';
    form.elements.payDay.value = String(s.payDay || 28);
    form.elements.payWeekend.checked = !!s.payWeekend;
    renderTripRows(s.trips || []);
    form.elements.weightUnit.value = s.weightUnit || 'st';
    form.elements.weightKg.value = C.formatWeight(s.weightKg, s.weightUnit);
    form.elements.heightCm.value = s.heightCm ? C.formatHeight(s.heightCm) : '';
    clearSettingsErrors();
    updateBodyConv();
    updatePreview();
  }

  function clearSettingsErrors() {
    form.querySelectorAll('[data-err]').forEach(function (n) { n.textContent = ''; });
    C.FIELDS.concat(C.OPTIONAL, ['weightKg', 'heightCm', 'payDay']).forEach(function (k) { form.elements[k].removeAttribute('aria-invalid'); });
    form.querySelectorAll('[name^="trips."]').forEach(function (n) { n.removeAttribute('aria-invalid'); });
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
    raw.monthStart = form.elements.monthStart.value;
    raw.payDay = form.elements.payDay.value;
    raw.payWeekend = form.elements.payWeekend.checked;
    raw.trips = readTripRows();
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

  /* Saved trips editor in Settings. Inputs are named trips.<n>.<field>. */
  var TRIP_MONEY = [['fare', 'Return (£)', ''], ['codeFare', 'Return, code (£)', 'none'], ['single', 'Single (£)', 'half return'], ['codeSingle', 'Single, code (£)', 'half return']];
  function renderTripRows(trips) {
    var list = $('tripsList');
    list.textContent = '';
    trips.forEach(function (t, i) {
      var p = 'trips.' + i + '.';
      var row = el('div', { class: 'trip-row', 'data-id': t.id || '' });
      var grid = el('div', { class: 'discount-grid' });
      var field = function (cls, label, name, val, attrs) {
        var inp = el('input', Object.assign({ name: p + name, autocomplete: 'off' }, attrs || {}));
        inp.value = val;
        grid.appendChild(el('label', { class: 'field' + cls }, [el('span', { text: label }), inp, el('em', { class: 'error', 'data-err': p + name })]));
      };
      field(' span2', 'Name', 'name', t.name || '', { maxlength: '30', placeholder: 'e.g. Edinburgh' });
      field(' span2', 'Driving it, round trip (miles)', 'miles', t.miles ? String(t.miles) : '', { inputmode: 'decimal' });
      field(' span2', 'Extra walk from the far station, each way (miles)', 'walk', t.walk ? String(t.walk) : '', { inputmode: 'decimal', placeholder: 'none' });
      TRIP_MONEY.forEach(function (m) { field('', m[1], m[0], t[m[0]] ? moneyText(t[m[0]]) : '', { inputmode: 'decimal', 'data-money': '', placeholder: m[2] }); });
      row.appendChild(grid);
      var cb = el('input', { type: 'checkbox', name: p + 'work', role: 'switch' });
      cb.checked = !!t.work;
      row.appendChild(el('label', { class: 'toggle' }, [cb, el('span', { class: 'toggle-track', 'aria-hidden': 'true' }), el('span', { text: 'Work day (counts as a commute, walks to work too)' })]));
      var del = el('button', { type: 'button', class: 'btn ghost small trip-del', text: 'Remove ' + (t.name || 'trip') });
      del.addEventListener('click', function () {
        var rows = readTripRows();
        rows.splice(i, 1);
        renderTripRows(rows);
        updatePreview();
      });
      row.appendChild(del);
      list.appendChild(row);
    });
  }
  function readTripRows() {
    return Array.prototype.map.call($('tripsList').querySelectorAll('.trip-row'), function (row, i) {
      var p = 'trips.' + i + '.', g = function (k) { return form.elements[p + k]; };
      var t = { id: row.getAttribute('data-id') || uid(), name: g('name').value, miles: g('miles').value, walk: g('walk').value, work: g('work').checked };
      TRIP_MONEY.forEach(function (m) { t[m[0]] = g(m[0]).value; });
      return t;
    });
  }
  $('addTrip').addEventListener('click', function () {
    var rows = readTripRows();
    if (rows.length >= 12) { toast('Up to 12 saved trips.'); return; }
    rows.push({ id: uid(), name: '', miles: '', walk: '', fare: '', codeFare: '', single: '', codeSingle: '', work: false });
    renderTripRows(rows);
    form.elements['trips.' + (rows.length - 1) + '.name'].focus();
  });

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
    $('payDayBox').hidden = form.elements.monthStart.value !== 'payday';
    if (r.ok) {
      var pp = C.periodFor(todayISO(), r.settings);
      var nx = new Date(C.parseISO(pp.end)); nx.setDate(nx.getDate() + 1);
      $('payHint').textContent = r.settings.monthStart === 'calendar' ? 'Totals run from the 1st to the end of each month.'
        : 'This pay month: ' + dm(pp.start) + ' to ' + dm(pp.end) + '. Next starts ' + dm(C.toISO(nx)) + '.';
    } else $('payHint').textContent = '';
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

  /* ================= Google Drive sync ================= */
  // The OAuth client ID from Google Cloud (it isn't secret). Empty until set up.
  var GOOGLE_CLIENT_ID = '';
  var SYNC_KEY = 'cs.sync', BASE_KEY = 'cs.syncBase';
  var sync = { busy: false, applying: false, timer: null, again: false, msg: '', err: false, lastTry: 0 };

  function syncLs(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k));
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function syncInfo() { return syncLs(SYNC_KEY) || {}; }
  function syncOn() { return !!syncInfo().on; }

  function localData() {
    return { settings: state.settings, entries: state.entries, fills: state.fills, exercise: state.exercise };
  }
  function cleanData(d) {
    if (!d || typeof d !== 'object') return null;
    var v = d.settings ? C.validateSettings(d.settings) : null;
    return {
      settings: v && v.ok ? v.settings : null,
      entries: (d.entries || []).map(sanitiseEntry).filter(Boolean),
      fills: (d.fills || []).map(sanitiseFill).filter(Boolean),
      exercise: (d.exercise || []).map(sanitiseEx).filter(Boolean)
    };
  }
  function fileData(d) {
    return { app: 'commute-savings', version: 1, exported: new Date().toISOString(),
      settings: d.settings, entries: d.entries, fills: d.fills, exercise: d.exercise };
  }

  /* Put merged data on this device, writing only the lists that changed. */
  function applyData(d) {
    sync.applying = true;
    var jobs = [];
    ['entries', 'fills', 'exercise'].forEach(function (n) {
      if (!window.CSync.same(state[n], d[n])) { state[n] = d[n].slice(); jobs.push(store.replace(n, state[n])); }
    });
    if (d.settings && !window.CSync.same(state.settings, d.settings)) {
      state.settings = Object.assign({}, d.settings);
      jobs.push(store.saveSettings(state.settings));
    }
    sync.applying = false;
    if (!jobs.length) return Promise.resolve(false);
    sortEntries();
    recalcStats();
    render();
    return Promise.all(jobs).then(function () { return true; });
  }

  function syncAgo(t) {
    if (!t) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var d = new Date(t), today = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return d.toDateString() === today.toDateString() ? 'at ' + hm : C.shortDate(C.toISO(d)) + ' ' + hm;
  }

  function renderSync() {
    var box = $('syncBox');
    if (!GOOGLE_CLIENT_ID || !window.CSync) { box.hidden = true; $('syncBtn').hidden = true; return; }
    box.hidden = false;
    var info = syncInfo(), on = !!info.on;
    $('syncBtn').hidden = !on;
    $('syncBtn').classList.toggle('spin', sync.busy);
    $('syncDot').hidden = !(on && (sync.err || !window.CSync.auth.valid()));
    $('syncDot').classList.toggle('err', sync.err);
    $('syncOff').hidden = !on;
    $('syncActions').hidden = !$('syncChoice').hidden;
    $('syncGo').textContent = on ? (sync.busy ? 'Syncing…' : 'Sync now') : 'Turn on sync';
    $('syncGo').disabled = sync.busy;
    var text;
    if (!on) text = 'Keep your phone and computer the same. Your data is saved in a hidden app folder in your own Google Drive, which only this app can see.';
    else {
      text = 'On' + (info.email ? ' for ' + info.email : '') + '. ';
      if (sync.busy) text += 'Syncing…';
      else if (sync.msg) text += sync.msg;
      else if (info.last) text += 'Last synced ' + syncAgo(info.last) + '.';
      if (!sync.busy && !sync.err && !window.CSync.auth.valid()) text += ' Tap Sync to update.';
    }
    $('syncText').textContent = text;
  }

  function syncFail(err) {
    sync.busy = false;
    sync.err = !(err && err.needTap);
    sync.msg = err && err.needTap ? '' : (navigator.onLine === false ? 'Offline, it will sync when you have signal.' : (err && err.message || 'Sync failed') + '.');
    renderSync();
    return Promise.reject(err);
  }

  /* One sync: read Drive, merge, save here, then save to Drive. If another
     device saved in between, start again (up to twice). */
  function runSync(opts) {
    opts = opts || {};
    if (!GOOGLE_CLIENT_ID || !window.CSync) return Promise.resolve();
    if (sync.busy) { sync.again = true; return Promise.resolve(); }
    var S = window.CSync, A = S.auth, D = S.drive;
    A.clientId = GOOGLE_CLIENT_ID;
    A.hint = syncInfo().email || '';
    sync.busy = true; sync.err = false; sync.msg = ''; sync.lastTry = Date.now();
    clearTimeout(sync.timer);
    renderSync();
    var token, file, tries = 0, pulledTotal = 0;

    function attempt() {
      tries++;
      return D.find(token).then(function (f) {
        file = f;
        return f ? D.read(token, f.id) : null;
      }).then(function (raw) {
        var remote = raw ? cleanData(raw) : null;
        var base = syncLs(BASE_KEY);
        var hasLocal = state.entries.length || state.fills.length || state.exercise.length;
        var remoteCount = remote ? remote.entries.length + remote.fills.length + remote.exercise.length : 0;
        if (!base && remoteCount && hasLocal && !opts.choice) return 'choose:' + remote.entries.length;
        var merged = opts.choice === 'drive' && remote
          ? { data: Object.assign({}, remote, { settings: remote.settings || state.settings }), pulled: remoteCount, dropped: 0 }
          : S.merge(localData(), base, remote);
        if (opts.choice === 'drive') opts.choice = 'combine'; // a retry merges from here on
        return applyData(merged.data).then(function (changed) {
          if (changed) pulledTotal += merged.pulled + merged.dropped;
          var snap = S.snapshot(merged.data);
          var upload = fileData(merged.data);
          var same = remote && S.same(cleanData(upload), remote);
          if (same) return snap;
          var check = file ? D.version(token, file.id) : Promise.resolve(null);
          return check.then(function (v) {
            if (file && String(v) !== String(file.version) && tries < 3) return 'retry';
            return (file ? D.update(token, file.id, upload) : D.create(token, upload)).then(function () { return snap; });
          });
        });
      }).then(function (r) {
        if (r === 'retry') return attempt();
        return r;
      });
    }

    return A.token(!!opts.interactive).then(function (t) {
      token = t;
      return attempt();
    }).then(function (r) {
      sync.busy = false;
      if (typeof r === 'string' && r.indexOf('choose:') === 0) {
        var n = Number(r.slice(7));
        $('syncChoiceText').textContent = 'Google Drive already has data from another device (' + n + (n === 1 ? ' day' : ' days') +
          '). This device has ' + state.entries.length + (state.entries.length === 1 ? ' day' : ' days') +
          '. Use the Drive copy here, or combine the two?';
        $('syncChoice').hidden = false;
        renderSync();
        $('syncBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      $('syncChoice').hidden = true;
      syncLs(BASE_KEY, r);
      var info = syncInfo();
      info.last = Date.now();
      syncLs(SYNC_KEY, info);
      renderSync();
      if (!info.email) D.email(token).then(function (em) {
        if (!em) return;
        var i = syncInfo(); i.email = em; syncLs(SYNC_KEY, i); renderSync();
      }).catch(function () {});
      if (opts.interactive || pulledTotal) toast(pulledTotal ? 'Synced · ' + pulledTotal + (pulledTotal === 1 ? ' change' : ' changes') + ' from Drive' : 'Synced');
      if (sync.again) { sync.again = false; scheduleSync(1000); }
    }).catch(function (err) {
      if (opts.interactive && !(err && err.needTap)) toast(err && err.message || 'Sync failed');
      return syncFail(err).catch(function () {});
    });
  }

  /* After any change, sync a few seconds later while signed in. */
  function scheduleSync(ms) {
    if (!GOOGLE_CLIENT_ID || !syncOn() || sync.applying) return;
    clearTimeout(sync.timer);
    if (!window.CSync.auth.valid()) { renderSync(); return; }
    sync.timer = setTimeout(function () { runSync(); }, ms || 4000);
  }
  ['put', 'del', 'replace', 'saveSettings'].forEach(function (k) {
    var fn = store[k];
    store[k] = function () {
      var p = fn.apply(store, arguments);
      if (!sync.applying) scheduleSync();
      return p;
    };
  });

  function startSync() {
    var info = syncInfo();
    if (!info.on) { info.on = true; syncLs(SYNC_KEY, info); }
    return runSync({ interactive: true });
  }
  $('syncGo').addEventListener('click', startSync);
  $('syncBtn').addEventListener('click', startSync);
  $('syncUseDrive').addEventListener('click', function () {
    if (!confirm('Replace what is on this device with the Google Drive copy?')) return;
    $('syncChoice').hidden = true;
    runSync({ interactive: true, choice: 'drive' });
  });
  $('syncCombine').addEventListener('click', function () {
    $('syncChoice').hidden = true;
    runSync({ interactive: true, choice: 'combine' });
  });
  $('syncOff').addEventListener('click', function () {
    if (!confirm('Stop syncing this device? Your data stays here and on Google Drive.')) return;
    window.CSync.auth.signOut();
    syncLs(SYNC_KEY, null);
    syncLs(BASE_KEY, null);
    sync.msg = ''; sync.err = false;
    $('syncChoice').hidden = true;
    renderSync();
    toast('Sync turned off on this device');
  });

  function syncWake() {
    if (!GOOGLE_CLIENT_ID || !syncOn() || sync.busy) return;
    if (Date.now() - sync.lastTry < 30000) return;
    if (window.CSync.auth.valid()) runSync();
    else renderSync();
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') syncWake(); });
  window.addEventListener('online', function () { sync.lastTry = 0; syncWake(); });

  // Load Google's sign in script early, so tapping Sync can open its window straight away.
  function preloadGoogle() {
    if (GOOGLE_CLIENT_ID && window.CSync && navigator.onLine !== false) window.CSync.auth.load().catch(function () {});
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
      renderSync();
      if (syncOn()) { preloadGoogle(); syncWake(); }
      else if (GOOGLE_CLIENT_ID) setTimeout(preloadGoogle, 3000);
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
