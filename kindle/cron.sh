#!/bin/sh
# Runs from /etc/crontab/root every minute: keeps nexus running unless disabled, and restarts it when the
# process is alive but has not completed a fetch for STALE_AFTER s (stuck client) while the bridge answers.
DIR=/mnt/us/nexus
STAMP=/tmp/nexus.last_ok     # written by nexus.sh on every successful fetch
GUARD=/tmp/nexus.wd_restart  # epoch of the last watchdog restart: never more than one per GUARD_SECS
STALE_AFTER=180; GUARD_SECS=180
[ -f $DIR/DISABLED ] && exit 0
up=$(cut -d. -f1 /proc/uptime); [ "$up" -lt 90 ] && exit 0
if [ -f $DIR/nexus.pid ] && kill -0 $(cat $DIR/nexus.pid) 2>/dev/null; then
  now=$(date +%s); st=$(cat $STAMP 2>/dev/null); [ -n "$st" ] || st=$now
  age=$(( now - st )); [ $age -lt $STALE_AFTER ] && exit 0
  [ $(( now - $(cat $GUARD 2>/dev/null || echo 0) )) -lt $GUARD_SECS ] && exit 0
  . $DIR/config
  ( timeout -t 5 wget -q -O - "$BRIDGE_URL/healthz"; r=$?; exit $r ) >/dev/null 2>&1 || exit 0   # bridge down: restarting would not help (-O /dev/null fails on this wget)
  sleep 25; [ "$(cat $STAMP 2>/dev/null)" != "$st" ] && exit 0                          # bridge just came back and the client caught up
  echo "$now" > $GUARD
  echo "$(date '+%H:%M:%S') watchdog: pid alive but no successful fetch for ${age}s and bridge answers -> restart" >> $DIR/nexus.log
  /bin/sh $DIR/nexus.sh restart >/dev/null 2>&1
  exit 0
fi
/bin/sh $DIR/nexus.sh start >/dev/null 2>&1
