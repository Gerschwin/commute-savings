# Commute Savings

A small phone app that tracks the money you save each day by taking the train
from Airdrie to Glasgow instead of driving the Vellfire, plus any other small
savings. It is plain HTML, CSS and JavaScript with no build step, installs to
your home screen and works fully offline. Data stays on your phone, unless you
turn on Google Drive sync.

## What's in the folder

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `styles.css` | Look and feel, light and dark mode |
| `app.js` | Buttons, storage (IndexedDB, falls back to localStorage), chart, import and export |
| `calc.js` | The pure money and date calculations |
| `calc.test.js` | Tests for `calc.js`, run with Node |
| `sync.js` | Google Drive sync: the merge, Google sign in and Drive calls |
| `sync.test.js` | Tests for the merge, run with Node |
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
Totals, the chart, the target and the log show the fuel saving. With "Show
van wear in brackets beside totals" on (the default from v1.20.0), each total
also shows the van wear for the same days, small and in brackets, on top of
it: £14.10 (£16.04) means £14.10 fuel saved plus £16.04 of van wear.

**Miles walked** (walks and runs, phone steps included) and **miles not
driven** show under the month total at the top and under each running total.
Under the target bar: the days left in the month (or pay month, today
included) and an **All time** line with money saved (wear in brackets),
miles not driven and miles walked.
Miles not driven is the whole drive for a train day or a lift (a trip's own
miles), less the station run on a drove-to-station day.

**Van wear** is 20p a mile: about 9p depreciation plus 11p servicing, tyres,
brakes and age related wear, for a £10k 2012 Vellfire doing 10,000 to 12,000
miles a year. 18p to 24p is a fair range (roughly £2,000 to £2,650 a year at
11,000 miles). It was a 10p guess before v1.19.0; a phone still on 10p moves
to 20p once, wear is switched on, and days worked out at 10p are updated
by themselves (with Undo). Changing mpg, petrol price or van
wear in Settings offers to update the past days worked out with the old
figure, with Undo.

With the brief's original figures (22 mpg, £1.59 a litre, £5.50 fare):

* Walked or cycled: £5.67 fuel saving (plus £6.80 wear)
* Drove to station: £3.94 fuel saving (plus £6.08 wear)

Real ScotRail fares (Nov 2026): the Anytime Day Return is £5.45 with the
**BB1 discount code**, which gives £5.72 and £3.99. Without the code the
return is £6.10, which gives £5.07 and £3.34. The
Anytime Day Single is £5.50 (£4.95 with BB1), so a return is always the one
to buy.

Note: the original brief said the drove-to-station day comes to about £3.97.
Using the formula above, it is £5.671 − £1.735 = £3.936, so £3.94. The tests
check £3.94.

## Real figures

### Ticket cost

**Log a day** has a "Ticket cost today, both ways" box. Leave it blank to use
your usual return fare, or tap **BB1 return**, **Full** or **2 singles**
(single fare × 2), or type what you actually paid. Each day stores the fare it
used (and the code, if one applied), so the log shows it.

### Trips (Milngavie and anywhere else)

Above the ticket box in **Log a day**, the **Journey** dropdown lists **Work**
(the usual commute), every **saved trip** and **One-off trip**, each with its
driving miles and miles walked (for example "Milngavie · 46.2 mi drive · 6.2 mi
walk"). Under it, the walking legs are spelled out. It goes back to Work after each
day you log.

* **Saved trips** live in Settings under **Saved trips**: a name, the miles
  driving it there and back, the return fare, and optionally the code return
  and the singles. **Add a trip** adds one, **Remove** deletes it (days already
  logged keep their figures).
* **Work day** on a trip means it's a commute with a detour, like Milngavie
  (home to work 17 miles, work to Milngavie 8.6, then home 20.6, 46.2 in all;
  return £6.80 with BB1 or £7.60, singles £6.55 or £7.30). It counts as a
  train day.
* **Extra walk from the far station, each way**: the walking at the other
  end. A work day also walks your usual Queen Street to work leg. Milngavie
  is a work day with 0.7 miles, so a walked Milngavie day is home to Airdrie
  1.6, Queen Street to work 0.8 and Milngavie 0.7, each way: 6.2 miles. The
  home to station leg is always included (cycled on a cycled day).
* A trip that isn't a work day (Edinburgh, the airport, a Saturday in town)
  doesn't count as a train day and has no No commute button. Its savings are shown separately under Running totals
  ("Includes £X from trips this pay month") and are part of every total.
* **One-off**: type where (optional) and the miles driving, then what the
  ticket cost in the ticket box. The buttons show the saving once both are in.
* The log shows "Via Milngavie (46.2 mi)" for work trips and
  "Trip: Edinburgh (80 mi)" for others.

With the Settings figures (22 mpg, £1.59 a litre): Milngavie by train saves
£8.38 (plus £9.24 wear); Edinburgh, 80 miles with a £16.50 ticket, saves
£9.78.

Settings from v1.14 (the old single "Second route") become a saved trip by
themselves.

### Discount code (BB1)

In Settings, under **Discount code**: switch it on, enter the code, the return
price with it, and the last day it works if you know it. While it's active,
train days use the discounted fare. After the end date (or if you switch it
off) they go back to the full return fare by themselves. The date checked is
the day you're logging, so back-filling a day when the code was live still
gets the discounted fare.

Season ticket or Flexipass? In Settings, under the usual fare, open **Season
ticket or Flexipass?**, enter the price and how many days you'll travel on it,
and it works out a per-day cost.

### Fuel log (real mpg and petrol price)

Each time you fill up, add the date, odometer reading, and any two of
**litres**, **price a litre** (pence, from the pump) and **paid**: the third fills
in as you type (in orange). Tick **Filled to full** if you brimmed it.

* **Petrol price** is kept for each fill-up. Every day uses the price of the
  fill-up in the tank that day (the last one on or before it), so a back-filled
  day gets the price of the time, not today's.
* After you add a fill-up, if any past days were worked out at a different
  price, the **Recalculate past days** box opens straight away with the effect
  shown, for you to **Update** (with Undo) or cancel. One fill-up is enough for
  this; days keep their own mpg until you have two full tanks.
* **Real mpg** uses the full-to-full method: the miles between two full tanks,
  divided by all the fuel you put in since the first of them (top-ups
  included). It averages your last five tanks, so one odd week doesn't swing
  it. You need two full fills before it shows.
* If your odometer is in km (common on Japanese imports), switch the unit
  next to the odometer box. It converts to miles for you.
* While **Use these for new train days** is on, new train days are worked out
  with your real mpg and price. Switch it off to use the Settings figures.
  Old days never change.

### Recalculate past days

Days you logged before the fuel log had real figures were worked out with the
Settings guesses. Once a fill-up is logged, a **Recalculate past days with real
figures** button shows in the Fuel log card (only when something would
change). Tap it to see the effect first, for example "this month: £79.20
becomes £71.65", then **Update** to apply it, with a 6 second Undo.

Each train day gets the mpg of the tank you were on that day (filled on or
before it, measured at the next full fill), or your average if no tank covers
it, and the petrol price from the fill-up on or before that day. The fare
you paid is kept. Exercise isn't touched. Nothing changes
unless you press the button.

### Changing mpg or petrol price in Settings

If you change the mpg or petrol price in Settings, a box appears at the top
offering to use the new figure for the past days that were worked out with
the old one, with the effect shown first ("this month: £15.43 becomes
£22.87"). **Update** applies it (with Undo), **Leave them** keeps the old
figures. Days worked out from the fuel log, and the fares you paid, are
never touched.

If you'd rather type the trip computer figure, put it in Settings. If it shows
km/L, use **Dashboard shows km/L?** to convert.

Fill-ups and exercise are included in the JSON backup.

## Pay month

The monthly total, target, chart, train day count and exercise all run over
a **pay month**: from payday to the day before the next payday. Set it in
Settings under **Month runs from**:

* **Payday (a date)**: 28th by default. With **Weekend payday moves to the
  Friday before** on, a Saturday or Sunday 28th becomes the Friday.
* **Last Friday of the month**
* **The 1st**: ordinary calendar months.

Bank holidays aren't allowed for. If payday moves for one, the day falls in
the month before. The week and year totals stay as calendar week and year.

## Exercise

Your commute exercise is logged automatically when you log a train day. In
Settings under **Journeys**, enter the walk or cycle **home to station** and,
under **Work**, the walk **station to work**, each way (1.6 and 0.8 miles,
Airdrie and Queen Street). Then:

* **Train, walked**: both legs walked there and back (4.8 miles)
* **Train, cycled**: home leg cycled (3.2 miles), work leg walked (1.6 miles)
* **Train, drove to station**: work leg walked (1.6 miles)

Set Station to work to 0 if you don't walk that bit. Days already logged keep
the distances they were logged with. You can add other walks, runs and rides
in the **Exercise** card, by miles or by steps.

The card shows this month's miles walked and cycled, steps, calories, a
monthly active miles goal, a streak of active days (weekends never break it),
and a changing line of encouragement.

Add your **weight** (st & lb, kg or lb) and **height** (e.g. 5'10 or 178) in
Settings for calories and steps. They stay on your phone.

**Phone steps**: type the day's total from your phone in the Exercise card.
Only the steps above what the app already has for that day (commute plus any
walks you added) are counted, as easy walking at 2.5 mph, so nothing is
counted twice. Saving again for the same day replaces the figure. Steps
never change the money figures.

Each logged day shows its miles, steps and calories, and the Calories box
shows what the month's calories add up to as fat burned off (about 3,500 kcal a pound, in your Settings weight unit). If you add your weight
and height later, earlier days fill in too.

How it's estimated:

* **Steps**: step length is about 41.5% of your height walking, 65% running.
* **Calories**: MET values by speed from the Compendium of Physical
  Activities. It counts *active* calories, (MET − 1) × weight in kg × hours,
  meaning what you burned on top of sitting still, like a fitness watch does.
  If you don't give minutes, it uses your usual pace from Settings.
* These are estimates, good for spotting trends rather than counting every
  calorie.

## Run the tests

You need [Node.js](https://nodejs.org) (any recent version).

```bash
node calc.test.js
```

```bash
node sync.test.js
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
2. On the phone, open the app while you have signal. It checks for a new
   version each time you open it or come back to it, and reloads itself
   a moment later when one arrives.
3. The version number is at the very bottom of the app, so you can check.

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

It runs full screen with no address bar, but only if it's **installed**, not
added as a shortcut. If you see an address bar, remove the icon and install it
again as below. When you open it in Chrome, an **Install the app** box may
appear at the top: tap **Install app**.

1. Open the GitHub Pages address in **Chrome**.
2. Tap the **⋮** menu at the top right.
3. Tap **Install app** (on some phones it says **Add to Home screen**), then
   **Install**.
4. Open it from the new icon.

Open it once while you have signal so it can save itself (and the fonts) for
offline use.

## Sync with Google Drive

Keeps your phone and computer the same. Under **Your data**, tap **Turn on
sync** and sign in with Google. Your data (days, fill-ups, exercise and
settings) is saved as one file in a hidden app folder in your own Google
Drive. Only this app can see that folder, and it doesn't show in your Drive
file list.

* After that, the round arrows button at the top syncs. Changes also sync by
  themselves a few seconds after you make them, and when you open the app.
* Google's sign in lasts an hour. After that a small dot shows on the sync
  button: tap it and it signs you straight back in (usually no questions).
* Each day, fill-up and exercise record is matched by its own ID, so a day
  logged on the phone and another logged on the computer both survive.
  Deleting a day deletes it everywhere. If the same thing was changed on both,
  the device syncing wins.
* Settings: whichever device changed them last.
* The first time a second device syncs, if both have data, it asks whether to
  **Use Drive's copy** (best for a computer with old figures) or **Combine
  both**.
* **Stop syncing** signs this device out. Your data stays on the device and on
  Drive.
* With no signal it just waits and syncs later.

### Setting it up (once)

Google needs an app ID for the sign in. It's free and takes about 10 minutes.

1. Go to <https://console.cloud.google.com> and sign in with the Google
   account you want the data kept in.
2. At the top, open the project list, **New project**, name it
   `Commute Savings`, **Create**, then make sure it's selected.
3. Search the top bar for **Google Drive API**, open it and tap **Enable**.
4. Search for **Google Auth Platform** and open it, then **Get started**:
   app name `Commute Savings`, your email for support, **Next**, Audience
   **External**, **Next**, your email again, agree, **Create**.
5. **Audience** (left menu), under **Test users** tap **Add users** and add
   your own Gmail address. Save.
6. **Data Access**, **Add or remove scopes**, tick
   `.../auth/drive.appdata` (search for "appdata"), **Update**, then **Save**.
7. **Clients**, **Create client**: type **Web application**, name
   `Commute Savings`. Under **Authorised JavaScript origins** add
   `https://gerschwin.github.io` (exactly that, no slash at the end). Leave
   redirect URIs empty. **Create**.
8. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) and put
   it in `app.js` at `var GOOGLE_CLIENT_ID = '';`, then deploy. It isn't a
   secret, so it's fine in the code. The sync box only shows once it's set.

When you first sign in, Google says the app isn't verified (it's your own,
in testing). Tap **Continue**.

## Moving your data between devices

With sync on you don't need this. Without it:

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
* **Got a lift**: saves the whole drive (fuel, with wear in brackets), no
  fare. Doesn't count as a train day.
* **No commute**: for holidays, sick days or working from home. Saves
  nothing, but like a weekend it never breaks your exercise streak.
* **Undo**: every add or delete shows a message with **Undo** for 6 seconds.
* **Dark mode**: the round button next to Settings switches between Match
  phone (half circle), Dark (moon) and Light (sun). It's remembered on that
  phone.
* **Settings**: the sliders button at the top right. Only numbers above 0 are
  accepted. Changes affect days you log afterwards, and a new mpg or petrol
  price can also be applied to past days if you choose.
