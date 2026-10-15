#!/bin/sh
# Runs from /etc/crontab/root every minute: keeps nexus running unless disabled, and restarts it when the
# process is alive but has not completed a fetch for the stale threshold (stuck client) while the bridge answers.
# Radio-duty aware: while nexus.sh has the Wi-Fi radio switched off (battery saver) no fetch can succeed for the
# length of that window, so the threshold is widened to "window + WAKE_GRACE" for as long as the window lasts
# (/tmp/nexus.window = "<end epoch> <window s>", written by nexus.sh before it switches the radio off). Without
# that file the threshold comes from the config's POLL_SECONDS, and it is never below STALE_MIN.
# NEXUS_DIR / NEXUS_TMP / NEXUS_GRACE_WAIT exist for the test harness (kindle/tests/cron-test.sh).
DIR=${NEXUS_DIR:-/mnt/us/nexus}
TMP=${NEXUS_TMP:-/tmp}
STAMP=$TMP/nexus.last_ok     # written by nexus.sh on every successful fetch
WINDOW=$TMP/nexus.window     # "<end epoch> <window s>" of the current radio-off window
GUARD=$TMP/nexus.wd_restart  # epoch of the last watchdog restart: never more than one per GUARD_SECS
STALE_MIN=180; GUARD_SECS=180; WAKE_GRACE=120; MAX_WINDOW=7800   # MAX_WINDOW = the longest window nexus.sh will ever open (MAX_DOZE)
[ -f $DIR/DISABLED ] && exit 0
up=$(cut -d. -f1 /proc/uptime); [ "$up" -lt 90 ] && exit 0
. $DIR/config 2>/dev/null
stale_after() { # how long without a successful fetch is still normal: max(STALE_MIN, interval + WAKE_GRACE)
  now=$(date +%s)
  iv=$POLL_SECONDS; case "$iv" in ''|*[!0-9]*) iv=20;; esac
  set -- $(cat $WINDOW 2>/dev/null) "" ""   # "<end epoch> <window s>"; the padding keeps $1/$2 defined
  end=$1; win=$2
  case "$end" in ''|*[!0-9]*) end=;; esac
  case "$win" in ''|*[!0-9]*) win=;; esac
  # The window counts only while it is actually running (plus the grace it needs to fetch again);
  # a stamp left behind by a crashed client must not keep the threshold wide for ever.
  [ -n "$end" ] && [ -n "$win" ] && [ $now -lt $(( end + WAKE_GRACE )) ] && iv=$win
  [ $iv -gt $MAX_WINDOW ] && iv=$MAX_WINDOW   # a corrupt stamp must never switch the watchdog off
  th=$(( iv + WAKE_GRACE ))
  [ $th -lt $STALE_MIN ] && th=$STALE_MIN
  echo $th
}
if [ -f $DIR/nexus.pid ] && kill -0 $(cat $DIR/nexus.pid) 2>/dev/null; then
  now=$(date +%s)
  st=$(cat $STAMP 2>/dev/null); [ -n "$st" ] || st=$now
  age=$(( now - st )); th=$(stale_after)
  [ $age -lt $th ] && exit 0
  [ $(( now - $(cat $GUARD 2>/dev/null || echo 0) )) -lt $GUARD_SECS ] && exit 0
  ( timeout -t 5 wget -q -O - "$BRIDGE_URL/healthz"; r=$?; exit $r ) >/dev/null 2>&1 || exit 0   # bridge down: restarting would not help (-O /dev/null fails on this wget)
  sleep ${NEXUS_GRACE_WAIT:-25}; [ "$(cat $STAMP 2>/dev/null)" != "$st" ] && exit 0            # bridge just came back and the client caught up
  [ $(( $(date +%s) - st )) -lt $(stale_after) ] && exit 0                                     # it opened a new radio-off window meanwhile
  echo "$now" > $GUARD
  echo "$(date '+%H:%M:%S') watchdog: pid alive but no successful fetch for ${age}s (threshold ${th}s) and bridge answers -> restart" >> $DIR/nexus.log
  /bin/sh $DIR/nexus.sh restart >/dev/null 2>&1
  exit 0
fi
/bin/sh $DIR/nexus.sh start >/dev/null 2>&1
