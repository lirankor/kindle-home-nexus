# Battery saver plan (RTC suspend tried and rejected; radio duty cycling since 2026-10-16)

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

## Plan (owner's decisions, 2026-10-16 — these replace the original outline)
1. **No RTC suspend at all.** The suspend experiment worked technically but is unusable: **a button press does not
   wake a suspended Kindle 4** (owner's test, below) — only the power slider does, so the panel stopped being a
   panel. All suspend code is gone from the client; the history is in commits `5086e49` / `884ec9f`.
2. **Daytime saving = Wi-Fi radio duty cycling.** The device stays awake and reacts to every button at once; while
   the screensaver shows and nothing is in use it switches the **radio** off between updates and brings it up only
   to fetch: associate → frame + battery → radio off. Day cadence `DAY_WAKE_MIN` = 10 min.
3. **Night window 00:00–06:00 local (Europe/Berlin): one update every two hours** (`NIGHT_WAKE_MIN=120`). The
   screensaver photo does **not** rotate inside the window (same picture all night); readings, clock and battery
   follow the 2-hourly update, so they can be up to two hours stale at night — that is the owner's trade.
4. Everything else from the first stage stays: `ondemand` governor, battery report at most once a minute, ETag
   fetches (empty 200 + `X-Unchanged`), 60 s screensaver poll as the fallback cadence, the schedule computed
   server-side with DST handling, and the screensaver rule (held off only while the amp is ON *and* the panel is
   on the amp view).
5. **Every frame of the low-power path is a full flashing refresh** of a freshly fetched frame, followed by the
   settle time and `sync` before anything else happens, and a reconnect always forces a full redraw.

## Gotchas for the implementer
- The client runs on busybox 1.7.2 `/bin/sh` (no `read -t`, no `od`); `sleep` continues across suspend (the device slept 41 s inside a 20 s `sleep`, nothing broke).
- Keep the cron watchdog (`b246a44`) from restarting the client across a radio-off window: no fetch can succeed while the radio is down, so the stale threshold has to follow the current window length.
- Device clock is UTC; night window must be computed in Europe/Berlin (simplest: let the bridge/app decide and send the sleep length).
- The RTC alarm must be cleared (`echo 0 > wakealarm`) before setting a new one. *(Only relevant to the rejected suspend design.)*


## Status 2026-10-16 — built and rolled out: radio duty cycling, no suspend

### What was removed
All RTC-suspend code: `suspend_for` / `maybe_sleep` / `wait_wifi` / `sched_get` in `kindle/nexus.sh`, the `/sleep` endpoint and
`sleepInfo` / `injectSleep` in `bridge/server.js`, and `window.__kindleSleep` / `useKindleSleep` / `SleepBadge` / the `sleep.badge`
i18n keys / the `.sleep-badge` CSS in the app. The config keys `SLEEP`, `MIN_SLEEP`, `MAX_SLEEP`, `WAKE_HOLD`, `SLEEP_FALLBACK`,
`SLEEP_OVERRIDE*` are gone, and so are the `/tmp/nexus.sleeping` / `/tmp/nexus.last_wake` stamps and the `asleep()` branch in
`cron.sh`. **Why delete rather than hide behind a switch:** suspend is not one flag, it is a second power mode — a second main-loop
branch, a second set of watchdog stamps and a second badge state, all in a 300-line busybox script that has to stay readable. The
owner has ruled it out permanently, and `git show 5086e49 884ec9f` has the whole thing if it is ever wanted back.

### What was kept
`ondemand` governor, battery report at most once a minute, ETag frame fetches (empty 200 + `X-Unchanged`), the 60 s screensaver poll
as the fallback cadence, the bridge-side schedule with DST handling (`bridge/schedule.js`, pure + tested), the night photo hold
(`src/lib/night-window.ts`), the screensaver rule itself, and the full-refresh + settle discipline.

### The model
`/schedule` answers `"<poll s> <doze|awake> <next update epoch> <window s> <night 0|1> <HH:MM local>"`. `doze` = "you may switch your
radio off until the next update": only while the app shows the saver, no `/key` for `KEEP_AWAKE_MS` (5 min) and
`RADIO_DUTY_ENABLED=1`. One cycle on the device:

    radio on -> battery -> /schedule -> fresh frame, eips -f -> EINK_SETTLE 2 s + sync -> wirelessEnable 0 ... window ...

`lipc-set-prop com.lab126.cmd wirelessEnable 0` unloads the `ar6003` module and `wlan0` disappears (so it is a real power-down);
`wirelessEnable 1` gives `cmState=PENDING` at +3 s and `CONNECTED` at **+6 s**, with the bridge reachable in the same second.
The poller process is gone: the main loop blocks on the key FIFO (a press is seen instantly) and arms a one-shot timer for the next
poll, tagged with a generation counter so a superseded timer is ignored.

Schedule (app `.env` → compose → bridge): `DAY_WAKE_MIN=10`, night `00:00–06:00` `NIGHT_WAKE_MIN=120`, `SLEEP_TZ=Europe/Berlin`.
Night updates land on 00:00 / 02:00 / 04:00 / 06:00 and the photo does not rotate between them — so at night the clock and the
readings on the screensaver can be up to two hours old. That is the owner's trade, not a bug.

### Full-refresh rule (the ruined frame of 2026-10-15)
Every frame of the low-power path is a **freshly fetched PNG** (no `?etag=`) drawn with `eips -f`, followed by `EINK_SETTLE` and
`sync` before anything else happens — the frame the owner looks at for the next 10 minutes (or two hours) must be complete.
A reconnect always forces a full redraw (the client drops `/tmp/nexus.last.md5` inside `radio_up`, so the next frame, poll or key,
is a complete PNG drawn with a full refresh), and a draw cut short (`/tmp/nexus.drawing` left behind by a restart or a kill) is
redone in full. Measured: `eips -f -g` returns in **0.08–0.13 s** — it only submits the update, the controller needs about a second
more, which is what the 2 s settle covers; there is no completion flag in sysfs on this device to wait on.

### Watchdog
`cron.sh` cannot use a flat 180 s any more: no fetch can succeed while the radio is off. `nexus.sh` writes
`/tmp/nexus.window` = `"<end epoch> <window s>"` before switching the radio off and `cron.sh` uses
**`max(180, window + 120)`** while `now < end + 120`; otherwise `max(180, POLL_SECONDS + 120)` from the same `config`. A window
length in the stamp is capped at 7800 s so a corrupt file can never switch the watchdog off, and a stamp left behind by a crashed
client stops counting as soon as its window has expired. `dash kindle/tests/cron-test.sh` = 23 cases, all passing, including the
10-minute and 2-hour windows, the just-ended window, the expired one, the cap and the garbage stamp.

### Kill switches
| Where | Switch | Effect |
|---|---|---|
| device `config` | `RADIO_DUTY=0` (legacy `SLEEP=0` still read) | radio always on; needs `nexus.sh restart` |
| device file | `touch /mnt/us/nexus/NORADIO` (legacy `NOSLEEP` still honoured) | radio always on, live, checked before every window |
| device file | `DISABLED` | no client at all |
| server `.env` | `RADIO_DUTY_ENABLED=0` (legacy `SLEEP_ENABLED` still read) + bridge **rebuild** | `/schedule` only ever says `awake` |

Unlike the suspend design, the device is reachable over ssh whenever its radio is up, and a window can always be ended by pressing
a button — no power slider needed.

### Rollout log 2026-10-15/16 (UTC; the device clock runs ~3 s ahead of the server)
- 22:19:36 radio probe on the device: `wirelessEnable 0` → `ar6003` unloaded and `wlan0` gone within 5 s, `cmState=NA`;
  `wirelessEnable 1` → `PENDING` +3 s, `CONNECTED` **+6 s**, bridge `/healthz` OK in the same second.
- 22:32:51–22:33:32 `docker compose up -d --build app` then `up -d --build --force-recreate --no-deps bridge`; `.env` switched to
  `RADIO_DUTY_ENABLED=1 NIGHT_START=00:00 NIGHT_END=06:00 NIGHT_WAKE_MIN=120`. `/healthz` → `schedule.enabled true`,
  `nightStart 0`, `nightEnd 360`, `nightWakeMin 120`, next update `02:00`. The panel was on the screensaver over the Lights tab
  before and after (the bridge had already been recreated 21 min earlier, so there was no tab to restore).
- 22:34:55 client deployed (`nexus.sh`, `cron.sh`, new `config` with the device's own `BRIDGE_TOKEN` kept; `.bak` of all three left
  on the device) and restarted. 20 s polls with `?etag=` answering empty 200, battery once a minute.
- 22:40:06 saver → first `doze`; **22:40:13 `radio off for 120s`**, bridge silent until **22:42:15**, then
  `battery` + `/schedule` + `/screen.png?fresh=1` + `/hint` inside **0.9 s** and `22:42:21 radio off ... (radio was on 3s)`.
  Per cycle: **~5 s associating + ~3 s of work = ~8 s of radio per window.**
- 22:44:23 `touch NORADIO` during a window → `22:44:27 radio stays on: NORADIO file` (live kill switch verified).
- 22:45:31 the test override expired and the device took the **real** schedule: `radio off for 4476s, next update 02:00`.
- **Button test, 22:45:52** (a `select` event line written into the key FIFO exactly as the input reader writes it, 20 s into the
  radio-off window): `key 194 -> select` at once, `/key/select` at the bridge 22:45:54.8Z, `radio on after 5s (key)`, frame +
  `/hint` by 22:45:55.1 — **~5 s from press to a full redraw**, against a 10 s target. A real finger on the button exercises only
  the input reader in front of that, which is unchanged.
- **Watchdog across real windows:** the device was then given two **10-minute** windows (the real day cadence, which is longer
  than the old flat 180 s stale threshold): radio off 22:52:02 → back **23:02:07**, off 23:02:10 → back **23:12:16**, ~0.7 s of
  bridge traffic per cycle. No restart: the bridge log shows no `/reload` (every client start does one) and the client kept the
  same pid. Two things protect it — the widened threshold, and the fact that `cron.sh` cannot reach `/healthz` while the radio is
  down, so it exits before it would ever restart.
- At 23:12:16 the test override was exhausted and the device took the real night schedule again: one update at 02:00 local.
- Two consecutive screensaver window frames captured from the bridge (`01-window1-frame.png`, `02-window2-frame.png`) are
  byte-identical complete frames (night = no photo rotation), and the post-key frame (`03-after-keypress.png`) is the complete
  Lights tab. No sleep badge anywhere — the device is awake, so nothing claims otherwise.

### What this does and does not save
The radio is now up roughly **8 s per 10-minute window by day (1.3 %) and 8 s per 2-hour window at night (0.1 %)**, against
100 % before. But the device **stays awake**, and the awake SoC — not the radio — is the bulk of the draw: the 2026-10-13
measurement was ~63 mA idle with the `performance` governor, ~52 mA with `ondemand`. Published AR6003 idle-associated figures
are in the 10–20 mA range, so the honest expectation is roughly **52 → 35–42 mA, i.e. ~24 h → ~30–36 h on a charge** — a
useful improvement, not the week that suspend would have given. That is the price of a panel whose buttons work, and the owner
chose it with the button-wake result in hand. **There is still no measured drain**: the device was on the charger for the whole
rollout and `battery_current` while charging is charge-taper noise, not consumption. One unplugged day gives the real number
(`/healthz` records the battery on every update, so the curve is already being logged).
