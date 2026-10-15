#!/bin/sh
# Runs from /etc/crontab/root every minute: keeps nexus running unless disabled, and restarts it when the
# process is alive but has not completed a fetch for STALE_AFTER s (stuck client) while the bridge answers.
# Sleep-aware: while nexus.sh is suspended on an RTC alarm (/tmp/nexus.sleeping holds the planned wake) or has just
# resumed (/tmp/nexus.last_wake within WAKE_GRACE s) the stale check is skipped — a sleeping panel is not a stuck one.
# NEXUS_DIR / NEXUS_TMP / NEXUS_GRACE_WAIT exist for the test harness (kindle/tests/cron-test.sh).
DIR=${NEXUS_DIR:-/mnt/us/nexus}
TMP=${NEXUS_TMP:-/tmp}
STAMP=$TMP/nexus.last_ok     # written by nexus.sh on every successful fetch
SLEEPING=$TMP/nexus.sleeping # planned wake epoch while suspended
LASTWAKE=$TMP/nexus.last_wake # epoch of the last resume
GUARD=$TMP/nexus.wd_restart  # epoch of the last watchdog restart: never more than one per GUARD_SECS
STALE_AFTER=180; GUARD_SECS=180; WAKE_GRACE=120
[ -f $DIR/DISABLED ] && exit 0
up=$(cut -d. -f1 /proc/uptime); [ "$up" -lt 90 ] && exit 0
asleep() { # 0 while nexus.sh is suspended (or about to be) or resumed less than WAKE_GRACE s ago
  now=$(date +%s)
  if [ -f $SLEEPING ]; then   # the alarm has not fired yet, or fired within the grace (a stamp left behind past that is stale)
    w=$(cat $SLEEPING 2>/dev/null); case "$w" in ''|*[!0-9]*) w=0;; esac
    [ $now -lt $(( w + WAKE_GRACE )) ] && return 0
  fi
  lw=$(cat $LASTWAKE 2>/dev/null); case "$lw" in ''|*[!0-9]*) lw=0;; esac
  [ $(( now - lw )) -lt $WAKE_GRACE ]   # just resumed: Wi-Fi and the first fetch are in progress
}
if [ -f $DIR/nexus.pid ] && kill -0 $(cat $DIR/nexus.pid) 2>/dev/null; then
  asleep && exit 0
  now=$(date +%s)
  st=$(cat $STAMP 2>/dev/null); [ -n "$st" ] || st=$now
  age=$(( now - st )); [ $age -lt $STALE_AFTER ] && exit 0
  [ $(( now - $(cat $GUARD 2>/dev/null || echo 0) )) -lt $GUARD_SECS ] && exit 0
  . $DIR/config
  ( timeout -t 5 wget -q -O - "$BRIDGE_URL/healthz"; r=$?; exit $r ) >/dev/null 2>&1 || exit 0   # bridge down: restarting would not help (-O /dev/null fails on this wget)
  sleep ${NEXUS_GRACE_WAIT:-25}; [ "$(cat $STAMP 2>/dev/null)" != "$st" ] && exit 0            # bridge just came back and the client caught up
  asleep && exit 0                                                                             # it went to sleep meanwhile
  echo "$now" > $GUARD
  echo "$(date '+%H:%M:%S') watchdog: pid alive but no successful fetch for ${age}s and bridge answers -> restart" >> $DIR/nexus.log
  /bin/sh $DIR/nexus.sh restart >/dev/null 2>&1
  exit 0
fi
/bin/sh $DIR/nexus.sh start >/dev/null 2>&1
