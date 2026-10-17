# Kindle 4 client

Runs on a jailbroken Kindle 4 NT (firmware 4.1.4) with NiLuJe's USBNetwork installed
(provides SSH and a modern busybox at `/mnt/us/usbnet/bin/busybox`).

Install: copy this folder to `/mnt/us/nexus/` on the Kindle, set `BRIDGE_URL` and `BRIDGE_TOKEN` in `config` (the device copy of `config` is the only place the real token lives; updates deploy `nexus.sh`/`cron.sh` only, never `config`: a stale template token broke the panel for 3 min on 2026-10-17),
then add to `/etc/crontab/root` (rootfs must be remounted rw):

    * * * * * /bin/sh /mnt/us/nexus/cron.sh

`nexus.sh start|stop|restart|status` (run with `/mnt/us/usbnet/bin/busybox sh`).
While running it stops the Kindle reader framework, reads the hardware buttons from
`/dev/input/event0` (keypad) and `event1` (5-way), sends each press to the bridge as
`GET /key/<name>` and draws the returned PNG with `eips -g`. Idle refresh every
`POLL_SECONDS` (the idle cadence; the bridge's `/poll` shortens it to 5 s while music plays on the Media tab). Full (flashing) refreshes happen when the bridge's `/hint` says so (app events) and on the tab keys; `FULL_REFRESH_EVERY=N` adds one every N drawn frames, 0 (default) disables that. Create `/mnt/us/nexus/DISABLED` to keep it from autostarting.

Self-healing (added 2026-10-15 after a 7 h freeze): the stock busybox 1.7.2 `wget` has no `-T`, so a bridge
that vanishes mid-request (e.g. `docker compose … --force-recreate bridge`) left the client blocked forever on a
half-open socket while its pid stayed valid. Now every bridge call runs under `timeout -t $FETCH_TIMEOUT`
(default 15 s, settable in `config`), every successful fetch writes `date +%s` to `/tmp/nexus.last_ok`, and
`cron.sh` restarts the client when that stamp is older than 180 s while the pid is alive *and* the bridge
answers `/healthz` (a down bridge is not the client's fault); at most one watchdog restart per 180 s, none in the
first 90 s of uptime, logged as `watchdog: …` in `nexus.log`. The "bridge unreachable" footer is drawn after
`FAIL_HINT_AFTER` (default 3) consecutive failed fetches and wiped by a forced redraw on recovery.
`nexus.sh status` prints the stamp age; `nexus.sh stop` kills every `nexus.sh run` shell found in `/proc` (the reader
loops are grandchildren and used to leak two orphans per restart), waits up to 20 s for a fetch in flight, then `kill -9`.
Stock-wget gotchas baked into the scripts: `-O <existing file>` fails with "File exists" (so never `-O /dev/null`;
use `-O - >/dev/null`), and a `timeout`-killed child makes ash print a bare `Terminated` unless the subshell ends with
another statement (`( …; r=$?; exit $r ) 2>/dev/null`).
Verified 2026-10-15: bridge `--force-recreate` → next frame 3 s later; bridge `docker pause` 220 s → a failed fetch every
~50 s, no restart (healthz unreachable), fresh frame 10 s after unpause; main loop `kill -STOP` → watchdog restart at +282 s.

Battery saver — **radio duty cycling** (2026-10-16, `docs/battery-saver-plan.md`): at start the CPU governor is set to
`CPU_GOVERNOR` (`ondemand`, idles at 160 MHz; `performance` is restored on stop), the battery is reported at most every
`BATTERY_EVERY` s, and every screen fetch sends `?etag=<md5 of the frame on the panel>` so an unchanged frame comes back
as an empty 200 and nothing is drawn. **The device never suspends** — a button press cannot wake a suspended Kindle 4,
only the power slider can (owner's test 2026-10-15), so it stays awake and reacts to every key at once. Instead, while
the app shows the screensaver and no button was pressed for `KEY_HOLD` s, the bridge's `/schedule` answers `doze` with the
seconds until the next scheduled update, and the client **switches the Wi-Fi radio off** for that window:

    radio on -> battery report -> /schedule -> fresh frame, FULL refresh -> EINK_SETTLE + sync -> radio off ... window ...

`lipc-set-prop com.lab126.cmd wirelessEnable 0` is what does it: the `ar6003` module is unloaded and `wlan0` disappears
(verified 2026-10-15), so the radio is really powered down, not just marked down. `wirelessEnable 1` brings it back and
`lipc-get-prop com.lab126.wifid cmState` reads `CONNECTED` **6 s** later (measured; bounded by `WIFI_WAIT`, with one extra
`wirelessEnable 1` kick after 10 s). The schedule is server-side (the device clock is UTC): by day the next point on the
`DAY_WAKE_MIN` grid (:00/:10/…), at night (00:00–06:00 local) every two hours, with no photo change.

**Buttons during a radio-off window**: the main loop blocks on the key FIFO, so a press is handled the moment it happens —
the radio comes back up (~6 s), the key is sent to the bridge and the frame is redrawn in full. There is no poller process
any more: the main loop arms a one-shot timer for the next poll, and a press re-arms it to `POLL_SECONDS` (a superseded
timer's line carries an old generation number and is ignored). **If the radio refuses to re-associate** within `WIFI_WAIT`,
the client leaves it on, logs it and stops duty cycling for `RADIO_FAIL_HOLD` s — the panel is never left offline.
`nexus.sh stop` and `start` both force the radio back on, so a client killed mid-window cannot strand the device.

Every frame of the low-power path (the one the owner looks at for the whole window) is a **freshly fetched frame drawn with a
full flashing refresh**, followed by `EINK_SETTLE` s and `sync` before anything else happens: partial updates ghost on this
panel, and a half-finished one would stay on the screen for up to two hours (the owner's photo 2026-10-15: washed out, torn,
ghosted). A reconnect always forces a full redraw (`/tmp/nexus.last.md5` is dropped so the next frame is a complete PNG), and
a draw that was cut short (`/tmp/nexus.drawing` left behind by a restart) is redone in full. `eips` itself returns in ~0.1 s
but the controller needs about a second more, which is what `EINK_SETTLE=2` covers.

The watchdog knows about the windows: `nexus.sh` writes `/tmp/nexus.window` = `"<end epoch> <window s>"` before switching the
radio off, and `cron.sh` widens its stale threshold to `max(180, window + 120)` while that window runs (otherwise every
10-minute day window — and certainly every 2-hour night one — would look like a stuck client and get restarted). Without the
stamp the threshold is `max(180, POLL_SECONDS + 120)`, and an absurd value in the stamp is capped at 7800 s so a corrupt file
can never switch the watchdog off. Decision table: `dash kindle/tests/cron-test.sh` (23 cases).

**Kill switches:** `RADIO_DUTY=0` in `config` (+ restart), `touch /mnt/us/nexus/NORADIO` (live, checked before every
window; the older `NOSLEEP` name still works), `DISABLED` (no client at all), or `RADIO_DUTY_ENABLED=0` in the server `.env`
+ a bridge rebuild. `DOZE_OVERRIDE=120` (+ `DOZE_OVERRIDE_CYCLES=3`) = three fixed 2-minute windows after a start for a
rollout test. `nexus.sh status` shows the radio state, the current window and the governor.

Button map: 5-way = up/down/left/right/select, upper side buttons = prev tab,
lower side buttons = next tab, Back = escape, Menu = menu, Home = home, keyboard = keyboard.

**Connecting label:** the instant a key is pressed while the radio is off, the client draws `Connecting...` with `eips <col> <row> "text"` in the middle of the screen, over whatever is showing, until the reconnect redraw replaces it. Text is the only overlay this Kindle 4's eips can do: `eips -g` wipes the whole screen white before drawing an image (a PNG with transparency comes out blank, `-x`/`-y` draw nothing), so the earlier full-frame icon was dropped (owner, 2026-10-17). `CONNECTING_COL`/`CONNECTING_ROW` in `config` move the label (12×20 px cells, 50×40 grid). See `docs/battery-saver-plan.md`.
