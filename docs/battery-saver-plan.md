# Battery saver plan (agreed in outline 2026-10-15, not built yet)

## Why
The Kindle lasted about 24 h on a charge. Stock firmware gets weeks because the device is suspended except while the reader is used; our client (`kindle/nexus.sh`) keeps it awake around the clock.

## Measured on the device (2026-10-13)
| Item | Value |
|---|---|
| Awake drain, idle on the Lights tab | ~63 mA (`battery_current` before the charger went in) |
| Battery | 662 mAh (`battery_mAH`), so ~10 h of pure awake time |
| CPU governor | `performance`, 800 MHz always (`/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`) |
| Governor `ondemand` | ~11 mA less (sits at 160 MHz idle) |
| Poll traffic | 3 requests every 20 s (`/battery`, `/poll`, `/screen.png?fresh=1` ≈ 100 KB) |
| Suspend test | `echo mem > /sys/power/state` with `/sys/class/rtc/rtc1/wakealarm` (+40 s): 0.5 s to suspend, 1.6 s to resume, Wi-Fi re-associated and the client polling again ~5 s after resume. `ar6003: powering off in suspend`. |
| Wake sources | `pmic_rtc.1` and `mxc_rtc.0` wakeup enabled; keypad/fiveway expose no wakeup switch → a button press probably does NOT wake from suspend (Kindle 4 behaviour: only the power slider does). Untested with a person at the device. |

Battery sysfs: `/sys/devices/system/yoshi_battery/yoshi_battery0/{battery_capacity,battery_current,battery_mAH,battery_voltage}`. Charging flag: `lipc-get-prop com.lab126.powerd isCharging`. Wi-Fi state: `lipc-get-prop com.lab126.wifid cmState`. No `iwconfig`/`wmiconfig`/`rtcwake` on the device.

## Plan
1. **Awake tweaks** (client): `ondemand` governor at start, battery report once a minute, screen fetch with an ETag/If-None-Match so an unchanged frame is a 304 with no PNG (bridge already computes `etag`), 60 s poll on the screensaver. Expected ~63 → ~45 mA.
2. **Sleep in the screensaver**: when the app enters the screensaver (bridge can expose it, e.g. `<html data-eink-sleep="600">` → `/poll` answer or a new `/sleep` hint), the client draws the frame, sets the RTC alarm and suspends. Each wake: reconnect (~5 s), fetch a fresh frame, draw, suspend again (~10 s awake per cycle).
3. **Wake schedule**: daytime every 10 min (new photo + readings). Night (about 23:00–07:00): **no photo rotation** (user's request) — the same photo stays up; at most one wake per hour for the clock/battery badge, or none.
4. **Stay awake when in use**: any key within the last 5 min, or a Jellyfin queue playing on the Media tab (already 5 s polling), keeps today's behaviour.
5. **Waking the panel**: a flick of the power slider → panel live in ~5 s. Optional one-off test with the user at the device: suspend 90 s, press the 5-way centre after 20 s, check whether `resumed … after Ns` in the log is early.

Expected result: from ~24 h to well over a week.

## Gotchas for the implementer
- The client runs on busybox 1.7.2 `/bin/sh` (no `read -t`, no `od`); `sleep` continues across suspend (the device slept 41 s inside a 20 s `sleep`, nothing broke).
- Keep the cron watchdog (`b246a44`) from restarting the client while it is deliberately asleep: stamp `last_ok` before suspending or make the watchdog check the stamp's age against the planned sleep.
- Device clock is UTC; night window must be computed in Europe/Berlin (simplest: let the bridge/app decide and send the sleep length).
- The RTC alarm must be cleared (`echo 0 > wakealarm`) before setting a new one.

## Status 2026-10-15 — built (bridge + app + client), rolled out in stages

### What is implemented
**Bridge** (`bridge/server.js`, pure schedule in `bridge/schedule.js`, tests `bridge/schedule.test.js` = `cd bridge && npm test`):
- `GET /schedule?default=N` → one line `"<poll s> <sleep|awake> <wake epoch s> <sleep s> <night 0|1> <HH:MM local>"`.
  `sleep` only while the app shows the screensaver (`<html data-eink-saver="1">`), no `/key` for `KEEP_AWAKE_MS` (5 min) and
  `SLEEP_ENABLED` is on. Day: next point on the `DAY_WAKE_MIN` grid (:00 :10 :20 …), night (`NIGHT_START`–`NIGHT_END` local
  time in `SLEEP_TZ`, DST via Intl): next point on the `NIGHT_WAKE_MIN` grid (on the hour). A point closer than 60 s is skipped.
  The poll seconds replace `/poll` for the new client: 5 while music plays on the Media tab, 60 on the screensaver, else the device default.
  `?woke=1` = the device resumed before its alarm (power slider): counts as a key, holds it awake 5 min.
- `GET /sleep?secs=&wake=&night=&etag=` → the device commits to sleeping: the bridge injects `window.__kindleSleep` (+ `kindle-sleep`
  event, `label` = local HH:MM of the wake), re-shoots and returns that frame ("sleeping · next HH:MM" badge, `SleepBadge`); cleared on the
  next `/key` or an `awake` schedule.
- ETag: the frame hash is now **md5** (the Kindle has `md5sum`, no `sha1sum`); `/screen.png?…&etag=<md5>` and `/key/<k>?etag=` answer an
  **empty 200** (`X-Unchanged: 1`) when the frame is unchanged — busybox 1.7.2 wget rejects every status but 200/206, so no 304/204.
- `/healthz` gained `saver`, `sleep`, `lastKeyAt`, `schedule{…, next}`.
- Config = the app's `.env` (`.env.example`): `SLEEP_ENABLED=1 DAY_WAKE_MIN=10 NIGHT_START=23:00 NIGHT_END=07:00 NIGHT_WAKE_MIN=60 SLEEP_TZ=Europe/Berlin`,
  passed to the bridge by `docker-compose.yml`. **Server-side kill switch: `SLEEP_ENABLED=0` + bridge recreate** → `/schedule` answers `awake`.

**App**: `src/lib/night-window.ts` (same night rule, tested incl. DST edges) — `getScreensaver` returns the **same photo** inside the night
window (`lastPhoto` cache); F1/F4 on the saver pass `force` and still get a new one. The photo rotation period = `DAY_WAKE_MIN`
(`SnapshotResult.photoMinutes`), the full-refresh hint follows the photo id (same photo = no flash at the hourly night wake). The saver sets
`<html data-eink-saver="1">`; the badge is `SleepBadge` next to the battery badge (i18n `sleep.badge`).

**Client** (`kindle/nexus.sh`, `kindle/cron.sh`, `kindle/config`):
- Awake tweaks: `CPU_GOVERNOR=ondemand` at start (kernel offers conservative/ondemand/userspace/powersave/performance; restored to
  `performance` on stop), battery report at most every `BATTERY_EVERY=60` s, every screen fetch carries `?etag=<md5 of the drawn frame>`
  and an empty answer draws nothing, the poller takes its cadence + the sleep verdict from `/schedule` (60 s on the saver).
- Sleep cycle (`maybe_sleep` in the main loop, so keys are never raced): on a poll flagged `sleep` → re-ask `/schedule` → `GET /sleep`
  (badge frame) → RTC alarm = `rtc1/since_epoch + secs` (**`/sys/class/rtc/rtc1` = pmic_rtc is the only RTC with `wakealarm`, and its
  clock is NOT the system clock** — `rtc0` has no alarm) → `echo mem > /sys/power/state` (blocks until resume) → clear the alarm, stamp,
  wait for `wifid cmState=CONNECTED` (≤ `WIFI_WAIT=20` s) → `/schedule` again (3 bounded tries) → … Bridge unreachable after a wake →
  nothing drawn, log, sleep `SLEEP_FALLBACK=600` s and retry. Alarm not accepted / suspend write fails / resumed ≥5 s early (slider) →
  stay awake `WAKE_HOLD=300` s (tell the bridge `woke=1`). A button within `KEY_HOLD=300` s (the readers stamp `/tmp/nexus.last_key`)
  blocks the suspend; the FIFO keeps queued keys for after the cycle.
- Watchdog: `nexus.sh` writes `/tmp/nexus.sleeping` (planned wake epoch) before suspending and `/tmp/nexus.last_wake` after; `cron.sh`
  skips its stale check while the alarm has not fired (+120 s grace) and for 120 s after a resume; a sleeping stamp left behind >120 s past
  its alarm counts as stale again. Decision table: `dash kindle/tests/cron-test.sh` (12 cases, all pass).
- **Kill switches:** `SLEEP=0` in `/mnt/us/nexus/config` (+ `nexus.sh restart`), or `touch /mnt/us/nexus/NOSLEEP` (checked before every
  suspend, no restart needed), `DISABLED` stops the client entirely, `SLEEP_ENABLED=0` on the server. To reach a sleeping device: flick the
  power slider (it then stays awake 5 min), then `ssh kindle`.
- `SLEEP_OVERRIDE=120` + `SLEEP_OVERRIDE_CYCLES=3` in the config = three fixed 2-min cycles after a start, then the bridge schedule
  (rollout test; label `test+120s (n left)`).

### Rollout log
- 18:35–18:41Z bridge/app deployed (bridge Dockerfile now copies `schedule.js`; the first recreate crash-looped without it); panel reset to
  Lights by the recreate and restored to the amp view with `/key/prev` + `/key/f3` (amp on, queue paused).
- **Stage 1 (awake tweaks) live 18:41:51Z**, old config kept (new keys appended, `SLEEP=0`): `cpu governor ondemand` logged, bridge sees
  `/schedule?default=20` + `/battery` + `/screen.png?fresh=1&etag=…` per poll, `/hint` only after a drawn frame; curl check of
  `?etag=<current>` → `200`, `Content-Length: 0`, `X-Unchanged: 1`.
- 18:50Z amp off, **saver at 18:53:39Z**; first `/sleep` 18:53:40Z but the device stayed awake: `wakealarm not set` — the pmic_rtc
  `wakealarm` **reads back empty always** (even a past value is accepted with rc 0; verified by hand 19:02Z), so the read-back guard
  was a false negative (safe failure: awake, retry after `WAKE_HOLD`). Hand test 19:04:36Z: alarm +45 → `echo mem` returned 19:05:20Z
  (44 s), Wi-Fi CONNECTED on return. Guard changed to "our arithmetic + the write's rc"; client restarted 19:07:10Z with
  `SLEEP=1 SLEEP_OVERRIDE=120 SLEEP_OVERRIDE_CYCLES=3`.
- **Stage 2 (three 120 s cycles)** — device log (UTC, device clock ≈2 s behind the server) / bridge log:
  `19:12:18 sleeping 120s (awake 308s)` → `19:14:18 resumed after 120s (planned 120)`, `wifi CONNECTED after 0s`, bridge
  `/schedule` 19:14:22.99Z, `/battery`, `/sleep` 19:14:23.78Z → `19:14:22 sleeping 120s (awake 4s)` → `19:16:23 resumed after 121s`
  → bridge hits 19:16:28.1–28.9Z → `sleeping (awake 4s)` → `19:18:27 resumed after 120s` → bridge 19:18:32.9–33.6Z. Each wake
  produced a bridge hit ≤5 s after the resume and a fresh frame (`/sleep` 200, 560–630 ms, new etag each time).
- **Stage 3 (real schedule)** — the 4th cycle took the grid: `19:18:31 sleeping 88s until 21:20` → `19:20:00 resumed after 89s
  (planned 88)` → `19:20:04 sleeping 594s until 21:30 (awake 4s)` → `19:29:58 resumed after 594s (planned 594)`; healthz `sleep`
  = `{label: "21:30", sleepSec: 594, night: false}`. At 19:29:43Z `/schedule?woke=1` was sent from the server to hold it awake
  for the ssh read-out (log above) — it then polled normally at 60 s and goes back to sleep at the next poll after the hold.
  Test override lines removed from the device config (SLEEP=1 stays); `cron.sh` never fired during the cycles.
- **Measured awake time per cycle: 4 s** (resume → next suspend, device log), of which ~1 s is bridge traffic
  (`/schedule` + `/battery` + `/sleep` ≈ 0.6–0.8 s incl. the re-shot); planned → actual sleep length exact to ±1 s.
  CPU `time_in_state` after the governor change: 160 MHz accruing (177 s of 160 MHz in the first ~50 min awake vs 0 before).
  Battery stayed on the charger (96–100 %, `charging=1`) during the whole test, so no drain figure yet — the owner's next unplugged
  day gives it (healthz `battery` once a minute while awake, once per wake while sleeping).

### Owner's button-wake test (not run — needs a person at the device, ~90 s)
Question: does a button press wake the Kindle 4 from suspend (the keypad/fiveway expose no wakeup switch, so probably not)?
1. Agent: wait for the saver + a sleep cycle (healthz `sleep` not null), note `nextWake` (local HH:MM on the badge).
2. Owner: at least 20 s after the badge appeared, press the 5-way centre once; wait; do not touch the slider.
3. Agent watches the bridge log for `/schedule`, `/sleep` or `/key/select` arriving **before** `nextWake`; then (after the next
   wake or a slider flick) reads the device log: `resumed early after Ns (planned M): power slider? staying awake 300s` = the button
   woke it (the client then holds 5 min and processes the queued key); `resumed after Ms (planned M)` = it did not, and the press
   was queued in the FIFO and applied at the scheduled wake (the saver wakes to the UI then).
4. Either way the panel is back within ~5 s of a slider flick (early resume → `/schedule?woke=1`, awake 5 min, badge dropped).
