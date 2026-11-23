/* Commute Savings service worker.
   Changed files reach phones on their own (one app open later). Bump VERSION
   when you add or rename files, so the old cache is cleared out. */
var VERSION = 'v1.7.0';
var SHELL = 'cs-shell-' + VERSION;
var FONTS = 'cs-fonts-v1';

var CORE = [
  './',
  'index.html',
  'styles.css',
  'calc.js',
  'app.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

var FONT_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Sofia+Sans+Condensed:wght@700;800;900&display=swap';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      // cache: 'reload' skips the browser's own cache, so a new version never
      // installs with stale copies of the files.
      return cache.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    })
      .then(function () {
        // Save the font CSS and every font file it points to, so text looks right offline.
        // Failure here (no signal) is fine; fonts are also cached as they are used.
        return caches.open(FONTS).then(function (c) {
          return fetch(FONT_CSS).then(function (r) {
            if (!r.ok) return;
            return r.clone().text().then(function (css) {
              var urls = css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || [];
              return Promise.all([c.put(FONT_CSS, r)].concat(urls.map(function (u) {
                return fetch(u).then(function (f) { if (f.ok) return c.put(u, f); });
              })));
            });
          }).catch(function () {});
        });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('cs-') === 0 && k !== SHELL && k !== FONTS;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Google Fonts: cache first, then network (fonts never change at a given URL).
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONTS).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Our own files: stale-while-revalidate. Answer from the cache straight away
  // (instant, works offline) and fetch a fresh copy in the background, so a
  // change you deploy shows up the next time the app is opened.
  var key = req.mode === 'navigate' ? 'index.html' : req;
  event.respondWith(
    caches.open(SHELL).then(function (cache) {
      return cache.match(key, { ignoreSearch: true }).then(function (hit) {
        var network = fetch(req, { cache: 'no-cache' }).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
          return res;
        });
        if (hit) {
          event.waitUntil(network.catch(function () {}));
          return hit;
        }
        return network;
      });
    })
  );
});
