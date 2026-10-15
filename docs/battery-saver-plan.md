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
