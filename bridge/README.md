# Kindle bridge

Keeps the app open in headless Chromium, injects key presses sent over plain HTTP GET,
and serves 8-bit grayscale PNG screenshots (WIDTH x HEIGHT) for a Kindle to draw with `eips`.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `APP_URL` | `http://app:3000/` | Page to load |
| `PORT` | `8790` | Listen port |
| `WIDTH` / `HEIGHT` | `600` / `800` | Viewport and PNG size |
| `REFRESH_MS` | `30000` | Periodic re-screenshot interval |
| `KEY_SETTLE_MS` | `200` | Wait after a key press before the screenshot |
| `BUSY_WAIT_MS` | `6000` | After that, keep waiting (up to this long) while the page sets `<html data-eink-busy>`, e.g. the screensaver fetching the next photo after F1 |
| `PAGE_RELOAD_MS` | `0` | Reload the page every N ms (0 = never) |
| `PUPPETEER_EXECUTABLE_PATH` | unset | Use a system Chrome instead of the bundled one |
| `SLEEP_ENABLED` | `1` | `0` = `/schedule` never says `sleep` (server-side kill switch for the Kindle's sleep cycle) |
| `DAY_WAKE_MIN` / `NIGHT_START` / `NIGHT_END` / `NIGHT_WAKE_MIN` / `SLEEP_TZ` | `10` / `23:00` / `07:00` / `60` / `Europe/Berlin` | Wake schedule (`schedule.js`; the same keys live in the app's `.env`) |
| `SAVER_POLL_S` | `60` | Poll cadence `/poll` and `/schedule` answer while the screensaver shows |
| `KEEP_AWAKE_MS` | `300000` | A `/key` (or `/schedule?woke=1`) holds the device awake this long |

## Endpoints (all GET)

- `/screen.png` latest frame. Headers `ETag` (md5 of the PNG) and `Cache-Control: no-store`.
  `?etag=<md5>` (the Kindle sends the hash of the frame it drew): an unchanged frame is an **empty 200** with
  `X-Unchanged: 1` (busybox 1.7.2 wget accepts only 200/206, so no 304). Long-poll with `?since=<etag>&wait=<ms>`
  (max 60000): returns 304 if nothing changed in time. `?fresh=1` takes a new screenshot first instead of serving
  the last frame (the Kindle's polls).
- `GET /poll?default=<s>`: seconds the Kindle should sleep before its next poll: the app's `<html data-eink-poll>` (5 while a Jellyfin queue plays on the Media tab), `SAVER_POLL_S` while the screensaver shows, else `default`.
- `GET /schedule?default=<s>[&woke=1]`: one line `"<poll s> <sleep|awake> <wake epoch s> <sleep s> <night 0|1> <HH:MM local>"` —
  the Kindle's battery saver. `sleep` only while the app shows the screensaver (`<html data-eink-saver="1">`), no key for
  `KEEP_AWAKE_MS` and `SLEEP_ENABLED`; the wake is the next point on the day grid (`DAY_WAKE_MIN`) or, in the night window
  (`NIGHT_START`–`NIGHT_END` in `SLEEP_TZ`), the night grid (`NIGHT_WAKE_MIN`, on the hour). `woke=1` = the device resumed early
  (power slider) and is held awake like after a key.
- `GET /sleep?secs=&wake=&night=&etag=`: the Kindle is about to suspend — the bridge sets `window.__kindleSleep`
  (`{nextWake, label, sleepSec, night}` + `kindle-sleep` event; the app shows "sleeping · next HH:MM") and returns the
  re-shot frame (empty 200 when it equals `etag`). Cleared by the next `/key` or an `awake` schedule.
- `/key/<name>[?etag=]` press a key, settle, return a fresh frame. Names: `up down left right select enter ok back escape prev pageup next pagedown home menu keyboard`. Unknown name gives 400.
- `/reload` reload the page, return a frame.
- `/healthz` JSON `{ok, etag, fullGen, servedFullGen, battery, lastShotAt, appUrl, saver, sleep, lastKeyAt, schedule{…, next}}`.
- Tests: `npm test` (`node --test`, `schedule.test.js`: grid, night window, DST edges, 2-day sweep).

## Run locally

```sh
npm install
APP_URL=http://localhost:3000/ node server.js
curl -o screen.png localhost:8790/screen.png
```

## Kindle side (busybox wget)

```sh
wget -q -O /tmp/s.png http://HOST:8790/key/next && eips -g /tmp/s.png
```

## Soft keys and refresh hints

- The Kindle's bottom button row (Back, Keyboard, Menu, Home) is sent as keyboard keys `F1`..`F4`,
  matching the app's four footer buttons left to right. `GET /key/back|keyboard|menu|home` or `/key/f1..f4`.
- `GET /hint` returns `full` or `partial`: frames that
  need a flashing full e-ink refresh: the app counts such events in `<html data-eink-full>` (tab, screen, list page or music tab change, modal open/close, song / station / cover change, screensaver picture) and `/hint` answers `full` once per new value, `partial` otherwise. Cursor moves and the progress bar never count. The Kindle client
  reads it after each fetched frame.

## Photo region (screensaver)

While the screensaver shows a photo, the app sets `<html data-eink-photo="x,y,w,h">` (CSS pixels).
The bridge then processes only that region for the e-ink panel: auto-levels, a mild contrast and
brightness lift, unsharp mask, and Floyd-Steinberg dithering down to the panel's 16 grey levels.
Tuning env: `PHOTO_CONTRAST` (default 1.12), `PHOTO_BRIGHTNESS` (default 12, added grey levels),
`PHOTO_SHARPEN` (sigma, default 1.0).
