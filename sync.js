/* Commute Savings: Google Drive sync.
   merge() is pure and tested in sync.test.js. auth and drive are browser only,
   and app.js reads them from window.CSync each time, so they can be swapped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.CSync = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {
  'use strict';

  var LISTS = ['entries', 'fills', 'exercise'];

  /* JSON with sorted keys, so the same record always gives the same text. */
  function stable(v) {
    if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }

  /* What was last agreed with Drive: each record's text by id, plus settings. */
  function snapshot(data) {
    var snap = { settings: data.settings ? stable(data.settings) : null };
    LISTS.forEach(function (n) {
      var m = {};
      (data[n] || []).forEach(function (r) { m[r.id] = stable(r); });
      snap[n] = m;
    });
    return snap;
  }

  function byId(list) {
    var m = {};
    (list || []).forEach(function (r) { m[r.id] = r; });
    return m;
  }

  /* Three way merge of one list.
     local, remote: arrays of records. base: {id: text} from the last sync.
     A record changed or added here wins. One unchanged here takes Drive's
     copy, or goes if Drive no longer has it. One deleted here stays deleted. */
  function mergeList(local, base, remote) {
    var L = byId(local), R = byId(remote || []), B = base || {};
    var ids = {}, out = [], pulled = 0, dropped = 0;
    [L, R, B].forEach(function (m) { Object.keys(m).forEach(function (id) { ids[id] = true; }); });
    Object.keys(ids).forEach(function (id) {
      var l = L[id], r = R[id], b = B[id];
      var ls = l ? stable(l) : null, rs = r ? stable(r) : null;
      if (l) {
        if (ls === b) {
          if (r) { out.push(r); if (rs !== ls) pulled++; }
          else dropped++;
        } else out.push(l);
      } else if (b === undefined && r) {
        out.push(r); pulled++;
      }
    });
    return { list: out, pulled: pulled, dropped: dropped };
  }

  /* local, remote: {settings, entries, fills, exercise}. remote may be null
     (nothing on Drive yet). base: a snapshot, or null on a first sync, when
     the two are combined and Drive's settings are used. */
  function merge(local, base, remote) {
    var out = {}, pulled = 0, dropped = 0;
    LISTS.forEach(function (n) {
      var m = mergeList(local[n], base ? base[n] : {}, remote ? remote[n] : []);
      out[n] = m.list; pulled += m.pulled; dropped += m.dropped;
    });
    var ls = local.settings ? stable(local.settings) : null;
    if (!remote || !remote.settings) out.settings = local.settings;
    else if (!base || ls === base.settings) out.settings = remote.settings;
    else out.settings = local.settings;
    return { data: out, pulled: pulled, dropped: dropped };
  }

  function same(a, b) { return stable(a) === stable(b); }

  var api = { LISTS: LISTS, stable: stable, snapshot: snapshot, mergeList: mergeList, merge: merge, same: same };
  if (!win) return api;

  /* ---------- Google sign in (browser) ---------- */
  var SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  var TOKEN_KEY = 'cs.syncToken';
  var gisP = null;

  function lsGet(k) { try { return JSON.parse(win.localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) win.localStorage.removeItem(k); else win.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function needTap() { var e = new Error('Tap Sync to sign in to Google'); e.needTap = true; return e; }

  var auth = {
    clientId: '',
    hint: '',
    load: function () {
      if (gisP) return gisP;
      gisP = new Promise(function (resolve, reject) {
        if (win.google && win.google.accounts && win.google.accounts.oauth2) return resolve();
        var s = win.document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { gisP = null; reject(new Error('Could not reach Google')); };
        win.document.head.appendChild(s);
      });
      return gisP;
    },
    valid: function () {
      var t = lsGet(TOKEN_KEY);
      return !!(t && t.t && t.exp > Date.now() + 60000);
    },
    /* A token from the last hour is reused. Otherwise a Google window is
       needed, which a browser only allows straight after a tap. */
    token: function (interactive) {
      var t = lsGet(TOKEN_KEY);
      if (t && t.t && t.exp > Date.now() + 60000) return Promise.resolve(t.t);
      if (!interactive) return Promise.reject(needTap());
      var self = this;
      return self.load().then(function () {
        return new Promise(function (resolve, reject) {
          var client = win.google.accounts.oauth2.initTokenClient({
            client_id: self.clientId,
            scope: SCOPE,
            login_hint: self.hint || undefined,
            callback: function (r) {
              if (!r || r.error || !r.access_token) return reject(new Error(r && r.error_description || 'Google sign in failed'));
              lsSet(TOKEN_KEY, { t: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
              resolve(r.access_token);
            },
            error_callback: function (e) {
              reject(new Error(e && e.type === 'popup_closed' ? 'Google sign in was closed' :
                e && e.type === 'popup_failed_to_open' ? 'The Google window was blocked. Tap Sync again.' : 'Google sign in failed'));
            }
          });
          client.requestAccessToken({ prompt: '' });
        });
      });
    },
    forget: function () { lsSet(TOKEN_KEY, null); },
    signOut: function () {
      var t = lsGet(TOKEN_KEY);
      lsSet(TOKEN_KEY, null);
      if (t && t.t && win.google && win.google.accounts && win.google.accounts.oauth2) {
        try { win.google.accounts.oauth2.revoke(t.t, function () {}); } catch (e) {}
      }
    }
  };

  /* ---------- Drive (browser) ---------- */
  var FILE = 'commute-savings.json';
  var API = 'https://www.googleapis.com/drive/v3/files';
  var UP = 'https://www.googleapis.com/upload/drive/v3/files';

  function call(token, url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
    return win.fetch(url, Object.assign({}, opts, { headers: headers, cache: 'no-store' })).then(function (res) {
      if (res.status === 401) { auth.forget(); throw needTap(); }
      if (!res.ok) throw new Error('Google Drive said ' + res.status);
      return res.json();
    }, function () { throw new Error('No connection to Google Drive'); });
  }

  var drive = {
    /* The app's own hidden folder in your Drive. Returns {id, version} or null. */
    find: function (token) {
      var q = encodeURIComponent("name='" + FILE + "' and trashed=false");
      return call(token, API + '?spaces=appDataFolder&pageSize=10&fields=files(id,version,modifiedTime)&orderBy=modifiedTime%20desc&q=' + q)
        .then(function (r) { return (r.files && r.files[0]) || null; });
    },
    read: function (token, id) { return call(token, API + '/' + id + '?alt=media'); },
    version: function (token, id) {
      return call(token, API + '/' + id + '?fields=version').then(function (r) { return r.version; });
    },
    create: function (token, data) {
      var b = 'cs' + Date.now().toString(36);
      var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: FILE, parents: ['appDataFolder'], mimeType: 'application/json' }) +
        '\r\n--' + b + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(data) + '\r\n--' + b + '--';
      return call(token, UP + '?uploadType=multipart&fields=id,version', {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
      });
    },
    update: function (token, id, data) {
      return call(token, UP + '/' + id + '?uploadType=media&fields=id,version', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
    },
    email: function (token) {
      return call(token, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')
        .then(function (r) { return r.user && r.user.emailAddress || ''; });
    }
  };

  api.auth = auth;
  api.drive = drive;
  return api;
});
