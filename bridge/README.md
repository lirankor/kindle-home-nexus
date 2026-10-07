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
| `PAGE_RELOAD_MS` | `0` | Reload the page every N ms (0 = never) |
| `PUPPETEER_EXECUTABLE_PATH` | unset | Use a system Chrome instead of the bundled one |

## Endpoints (all GET)

- `/screen.png` latest frame. Headers `ETag` (sha1) and `Cache-Control: no-store`.
  Long-poll with `?since=<etag>&wait=<ms>` (max 60000): returns 304 if nothing changed in time.
- `/key/<name>` press a key, settle, return a fresh frame. Names: `up down left right select enter ok back escape prev pageup next pagedown home menu keyboard`. Unknown name gives 400.
- `/reload` reload the page, return a frame.
- `/healthz` JSON `{ok, etag, lastShotAt, appUrl}`.

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
- `GET /hint` returns `full` or `partial`: the app sets `<html data-eink-refresh="full">` for frames that
  need a flashing full e-ink refresh (tab change, modal open/close, screensaver picture). The Kindle client
  reads it after each fetched frame.

## Photo region (screensaver)

While the screensaver shows a photo, the app sets `<html data-eink-photo="x,y,w,h">` (CSS pixels).
The bridge then processes only that region for the e-ink panel: auto-levels, a mild contrast and
brightness lift, unsharp mask, and Floyd-Steinberg dithering down to the panel's 16 grey levels.
Tuning env: `PHOTO_CONTRAST` (default 1.12), `PHOTO_BRIGHTNESS` (default 12, added grey levels),
`PHOTO_SHARPEN` (sigma, default 1.0).
