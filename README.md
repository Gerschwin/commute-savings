# Commute Savings

A small phone app that tracks the money you save each day by taking the train
from Airdrie to Glasgow instead of driving the Vellfire, plus any other small
savings. It is plain HTML, CSS and JavaScript with no build step, installs to
your home screen and works fully offline. All data stays on your phone.

## What's in the folder

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `styles.css` | Look and feel, light and dark mode |
| `app.js` | Buttons, storage (IndexedDB, falls back to localStorage), chart, import and export |
| `calc.js` | The pure money and date calculations |
| `calc.test.js` | Tests for `calc.js`, run with Node |
| `manifest.json` | Tells the phone the app's name, icon and colours |
| `sw.js` | Service worker, keeps a copy of the app so it opens offline |
| `icons/` | App icons (SVG originals plus PNGs) |

## How the sums work

1 UK gallon = 4.546 litres.

* Fuel cost per mile = price × 4.546 ÷ mpg
* Driving cost for the day = commute miles × fuel cost per mile
* Train, walked or cycled: fuel saving = driving cost − fare, wear saving = commute miles × wear pence ÷ 100
* Train, drove to station: station fuel = station miles × price × 4.546 ÷ station mpg,
  fuel saving = driving cost − fare − station fuel,
  wear saving = (commute miles − station miles) × wear pence ÷ 100

Each entry stores its fuel saving and wear saving, worked out with the settings
at the moment you logged it. Changing a setting later never rewrites old days.
The figure shown is the fuel saving, plus the wear saving if "Include van wear
in totals" is switched on.

With the brief's original figures (22 mpg, £1.59 a litre, £5.50 fare):

* Walked or cycled: £5.67 fuel saving (plus £3.40 wear)
* Drove to station: £3.94 fuel saving (plus £3.04 wear)

The default fare is now the real ScotRail day return, £6.10 (Nov 2026), which
gives £5.07 and £3.34. £5.50 turned out to be the Anytime Day Single.

Note: the original brief said the drove-to-station day comes to about £3.97.
Using the formula above, it is £5.671 − £1.735 = £3.936, so £3.94. The tests
check £3.94.

## Real figures

### Ticket cost

**Log a day** has a "Ticket cost today, both ways" box. Leave it blank to use
your usual return fare, or tap **Day return** or **2 singles** (single fare ×
2), or type what you actually paid. Each day stores the fare it used, so the
log shows it.

Season ticket or Flexipass? In Settings, under the usual fare, open **Season
ticket or Flexipass?**, enter the price and how many days you'll travel on it,
and it works out a per-day cost.

### Fuel log (real mpg and petrol price)

Each time you fill up, add the date, odometer reading, litres and what you
paid. Tick **Filled to full** if you brimmed it.

* **Petrol price** comes from your latest fill (paid ÷ litres).
* **Real mpg** uses the full-to-full method: the miles between two full tanks,
  divided by all the fuel you put in since the first of them (top-ups
  included). It averages your last five tanks, so one odd week doesn't swing
  it. You need two full fills before it shows.
* If your odometer is in km (common on Japanese imports), switch the unit
  next to the odometer box. It converts to miles for you.
* While **Use these for new train days** is on, new train days are worked out
  with your real mpg and price. Switch it off to use the Settings figures.
  Old days never change.

If you'd rather type the trip computer figure, put it in Settings. If it shows
km/L, use **Dashboard shows km/L?** to convert.

Fill-ups are included in the JSON backup.

## Run the tests

You need [Node.js](https://nodejs.org) (any recent version).

```bash
node calc.test.js
```

Every line should start with `ok`.

## Run it locally

A service worker only runs from a web server, not from a file you double click.
From inside this folder:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080> in your browser. To try it on your phone,
both devices must be on the same WiFi: find your computer's local address
(for example `192.168.1.20`) and open `http://192.168.1.20:8080` on the phone.
Installing and offline mode need HTTPS though, so for real use, deploy it to
GitHub Pages as below.

## Deploy to GitHub Pages (step by step)

You only do steps 1 to 6 once.

1. Make a free account at <https://github.com> if you don't have one.
2. Click the **+** at the top right, then **New repository**.
3. Name it `commute-savings`, choose **Public**, leave everything else alone and
   click **Create repository**.
4. On the new repository page, click the link **uploading an existing file**.
5. Drag in every file from this folder **and the `icons` folder**. (Keep the
   folder: `icons/icon-192.png` must stay inside `icons`.) Click
   **Commit changes**.
6. Go to **Settings** (top of the repository) → **Pages** (left menu). Under
   **Build and deployment**, set **Source** to **Deploy from a branch**,
   **Branch** to `main` and folder `/ (root)`, then click **Save**.

After a minute or two the page shows "Your site is live at
`https://<your-username>.github.io/commute-savings/`". Open that on your phone.

If you prefer the command line and already have git set up:

```bash
git init
```

```bash
git add . && git commit -m "Commute Savings"
```

```bash
git branch -M main && git remote add origin https://github.com/<your-username>/commute-savings.git && git push -u origin main
```

Then do step 6.

### Updating the app later

1. Change the files and upload them to GitHub again (or commit and push).
2. On the phone, open the app while you have signal. It shows the saved copy
   straight away and quietly downloads the new one.
3. Close it fully and open it again to see the change.

If you add or rename a file, also add it to the `CORE` list in `sw.js` and bump
the version at the top (for example `var VERSION = 'v1.0.1';`) so old copies
are cleared out.

Your saved entries are not touched by an update.

## Install on your phone

### iPhone (Safari)

1. Open the GitHub Pages address in **Safari** (it must be Safari).
2. Tap the **Share** button (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Open it from the new icon. It runs full screen and works with no signal.

### Android (Chrome)

1. Open the GitHub Pages address in **Chrome**.
2. Tap the **⋮** menu at the top right.
3. Tap **Install app** (on some phones it says **Add to Home screen**), then
   **Install**.
4. Open it from the new icon.

Open it once while you have signal so it can save itself (and the fonts) for
offline use.

## Moving your data between devices

Your entries live only in the browser on that phone. To move them:

1. On the old device, scroll to **Your data** and tap **Backup (JSON)**. Save
   or share the file (email it to yourself, AirDrop, Google Drive).
2. On the new device, tap **Restore backup** and pick that file. This replaces
   what is on the new device (there is an Undo for 6 seconds).

**Export CSV** gives a spreadsheet of every entry (date, label, type,
fuel_saving, wear_saving). **Import CSV** adds entries from such a file and
skips any that are already there.

Tip: on iPhone, Safari can clear website data for an app you haven't opened in
a few weeks. Taking a backup now and then is a good habit.

## Using it

* **Log a day**: the date defaults to today. Change it to back-fill an earlier
  day, then tap the button for how you got to the station. Each button shows
  what it will add.
* **Other saving**: tap a chip to fill it in, or type your own, then **Add**.
* **Undo**: every add or delete shows a message with **Undo** for 6 seconds.
* **Settings**: the sliders button at the top right. Only numbers above 0 are
  accepted. Changes only affect days you log afterwards.
