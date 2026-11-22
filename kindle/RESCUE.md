# Rescue guard for the Kindle panel

`rescue.sh` is a second, independent watchdog on the Kindle. Its job is to keep the panel reachable when a
change to the client goes wrong: it can put the last known-good files back by itself, it keeps the Wi-Fi radio
on when someone needs to get in, and it tries to bring a lost Wi-Fi connection back.

It runs every minute from its **own** line in `/etc/crontab/root`, shares no code with `nexus.sh` or `cron.sh`
and reads `config` only to see one switch, so a broken client, a broken `cron.sh` or a broken `config` cannot
take it down with them. In normal operation it reads a few files and one Wi-Fi state and writes nothing to the
flash. It always exits 0, never runs twice at once, and waits 90 s after a boot.

    * * * * * /bin/sh /mnt/us/nexus/rescue.sh

Server side: `kindle/tools/kindle-rescue.sh` (needs only the SSH host alias `kindle`). Decision table:
`dash kindle/tests/rescue-test.sh` (82 checks; the same file runs on the Kindle's own busybox, see its header).

## The procedure for a risky change

    T=kindle/tools/kindle-rescue.sh
    $T wait                 # the radio may be off: retries until the Kindle answers, then holds the radio on
    $T status               # the client runs, the guard ran in the last minute, good/ is verified
    $T snapshot             # the files running NOW become the known-good set (only when the panel works)
    $T trial start 15       # arm the dead-man switch: 15 minutes
    ... deploy the new nexus.sh / cron.sh and test (never deploy config) ...
    $T screen /tmp/panel.png        # look at what the panel really shows
    $T trial extend 15      # more time: a new deadline, 15 minutes from now
    $T trial confirm        # it works: disarm, the new files stay
    $T snapshot             # and they become the new known-good set
    $T hold off             # only if a hold is still set (status shows it)

Not confirmed in time (the session died, the Kindle fell off the network, the new script switched the radio
off for good): at the first run after the deadline the guard rolls back. `$T rollback` does the same on demand.
A snapshot is refused while a trial runs, and a trial is refused without a verified snapshot or when the guard
has not run in the last 150 s.

## What a rollback does

1. Checks `good/`: the three files are there, match the checksums taken with the snapshot, and both scripts parse.
2. Stops every shell that runs `nexus.sh` (in any mode) or `cron.sh` (TERM, 5 s, then KILL), the key readers
   (`dd`) and requests still in flight (`wget`).
3. Copies the files that were running to `failed/` (for the post-mortem), then `nexus.sh`, `cron.sh` and `config`
   from `good/` back into place and compares them.
4. Removes `TRIAL`, `ROLLBACK`, the client's pid file and any radio-off window the failed script left behind.
5. Holds the radio on for 60 minutes, starts the client (unless `DISABLED` exists).
6. Writes `ROLLED_BACK` (time, reason, result) and a line in both `rescue.log` and `nexus.log`.

If `good/` is missing or damaged nothing is restored and nothing is deleted: the guard only holds the radio on
(renewed every minute, until someone resolves it) so the device can be reached and repaired by hand.

A rollback also happens when `TRIAL` is unreadable, when its deadline is further away than the trial is long
(the clock was set back), and when `/tmp` is nearly full during a trial. A reboot does not end a trial: the
files are on the user partition and the deadline still applies after the boot.

## Files in `/mnt/us/nexus/`

| File | Meaning |
|---|---|
| `good/` | known-good `nexus.sh`, `cron.sh`, `config`, their checksums, a copy of the crontab. `good.prev/` = the snapshot before. `config` holds the bridge token: these folders stay on the device. |
| `TRIAL` | `<deadline epoch> <minutes>`: a trial is running. Written by the tool only. |
| `ROLLBACK` | create it (any content) and the guard rolls back at its next run. |
| `ROLLED_BACK` | the last rollback: time, reason, result. |
| `NORADIO` | the client's own "keep the radio on" switch. With the content `rescue <expiry epoch>` it is the guard's hold and the guard removes it when it expires (never later than 4 h), so a forgotten hold cannot drain the battery. A `NORADIO` made by hand (`touch`) is never removed by the guard. |
| `failed/` | what was running when the last rollback happened. |
| `rescue.log` | the guard's log, cut to the last 200 lines when it passes 400. |
| `rescue.net` | `<not connected since> <step>` while a Wi-Fi outage lasts. |
| `NONET`, `NOREBOOT`, `WIFID_RESTART`, `RESCUE_DEBUG` | switches: no connection watchdog / it never reboots / step 3 also restarts wifid / one log line per run. |

`/tmp/rescue.last` holds the time and the decision of the last run (how the tool sees that the guard is alive).

## Connection watchdog

The same script, every minute, also when `nexus.sh` is broken or not running. It only asks wifid for its state
(`cmState`). It never asks the server anything: Wi-Fi connected and the server silent is the server's problem
(and `cron.sh`'s business), and the radio is left alone.

It stays quiet while the battery saver has the radio off: `/tmp/nexus.radio_off` exists, `/tmp/nexus.window`
names a window that is still running (plus 120 s to reconnect, at most 7800 s long, the limits `cron.sh` uses)
and the client process is alive. A stamp left behind by a crashed client fails one of those tests and stops
counting. It is also quiet with `DISABLED` (the Kindle is a reader again) and in the first 3 minutes after a boot.

Otherwise, counted from the first minute wifid was seen not `CONNECTED`:

| After | Step | Why this long |
|---|---|---|
| 120 s | 1: `wirelessEnable 1` again | a normal reconnect takes 6 s and the client's own retry (wait, power-cycle, wait) ends after about 65 s; this is past both, and it covers a client that died with the radio off |
| 300 s | 2: power-cycle the radio (`wirelessEnable 0`, 5 s, `1`: the stock path, it unloads and reloads the driver) | step 1 had 3 minutes |
| 900 s | 3: power-cycle once more | long enough for a router that was restarting to be back |
| 2700 s | 4: reboot | `cron.sh`'s own rule fires after about 2000 s when the client is alive, so it goes first and the guard is the backstop when `cron.sh` cannot act |

Every step writes one line to `rescue.log` and `nexus.log`; `net: connected again` closes the episode.

The reboot is rate-limited together with `cron.sh`: both use the stamp `/tmp/nexus.wd_reboot`, and neither
reboots within 6 h of the other. Because `/tmp` is emptied by a reboot, the guard writes the boot time into that
stamp when it is missing, so the limit also holds across the reboot itself: **no watchdog reboot in the first 6 h
after any boot**. `NOREBOOT`, or `WIFI_DEAD_REBOOT=0` in `config`, switches the guard's reboot off.

Not used, on purpose: reloading the driver by hand (`/etc/init.d/wifi`, `modprobe -r ar6003`). The power-cycle
already does that the stock way, and the init script reboots the device on its own, without any limit, when the
module load hangs. Restarting wifid (`/etc/init.d/wifid stop|start`, through pmond) is prepared as part of step 3
but **off**: it has never been tried on this device. `touch /mnt/us/nexus/WIFID_RESTART` enables it; do that only
after one supervised test.

Dry run, changes nothing and logs what it would do: `RESCUE_DRY=1 RESCUE_VERBOSE=1 sh /mnt/us/nexus/rescue.sh`.

## What it cannot do

- It needs cron, `/bin/sh`, the user partition and the stock `lipc` tools. If crond dies or the Kindle hangs
  or the battery is empty, nothing runs.
- It restores three files. Damage elsewhere (the crontab, the firewall, USBNetwork, the SSH keys, the root file
  system) is not undone. `good/crontab.root` and `good/crontab.before-rescue` are copies for a repair by hand.
- A rollback gives back the last *snapshot*. A snapshot taken of a bad state is a bad known-good set, and a
  snapshot older than the last change to `config` brings the old token back: **take a new snapshot after every
  change you want to keep, `config` included.** `status` says when the running files differ from `good/`.
- It restores the Kindle side only. If the bridge changed together with the client, the restored client must
  still be served by the new bridge, or the bridge has to be rolled back as well. SSH access does not depend on
  the bridge: the radio is held on for an hour after a rollback either way.
- A new client that fails only after the trial was confirmed is not caught; `rollback` still works as long as
  the Kindle can be reached, and `good.prev/` is one generation older.
- It cannot fix the network outside the Kindle (router, access point, server).

By hand, at the device: hold the power button for 20 to 30 s to reboot (the client and the guard start
again from cron; a running trial still expires). With the USB cable in a computer the Kindle is a network device
(USBNetwork), not a drive: SSH over the cable (address: see the USBNetwork documentation; not tried yet on this device) works without Wi-Fi, and
`touch /mnt/us/nexus/ROLLBACK` there has the same effect as the tool's `rollback`.

## Install on a fresh device

    kindle/tools/kindle-rescue.sh install        # copies rescue.sh, checks it on the device
    kindle/tools/kindle-rescue.sh snapshot
    kindle/tools/kindle-rescue.sh cron-install   # adds the line above, verifies the crontab line by line

`cron-install` saves the crontab to `good/crontab.before-rescue`, remounts `/` read-write only for the edit,
tells crond with `/etc/crontab/cron.update` (busybox 1.7.2 crond reads the named table again within a minute and
removes that file; it also rescans by itself once an hour) and remounts read-only. To remove the guard: delete
its crontab line the same way.
