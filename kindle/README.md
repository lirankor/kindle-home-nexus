# Kindle 4 client

Runs on a jailbroken Kindle 4 NT (firmware 4.1.4) with NiLuJe's USBNetwork installed
(provides SSH and a modern busybox at `/mnt/us/usbnet/bin/busybox`).

Install: copy this folder to `/mnt/us/nexus/` on the Kindle, set `BRIDGE_URL` in `config`,
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

Button map: 5-way = up/down/left/right/select, upper side buttons = prev tab,
lower side buttons = next tab, Back = escape, Menu = menu, Home = home, keyboard = keyboard.
