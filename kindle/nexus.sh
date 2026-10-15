#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips.
# Runs on the Kindle 4's own busybox 1.7.2 /bin/sh (no read -t, no od, no wget -T, wget -O refuses existing files; hexdump -e only from files).
# Usage: nexus.sh start|stop|restart|status|run
export PATH=/usr/sbin:/sbin:/usr/bin:/bin
DIR=/mnt/us/nexus
. $DIR/config
LOG=$DIR/nexus.log
PID=$DIR/nexus.pid
KIDS=$DIR/children.pid
FIFO=/tmp/nexus.keys
SHOT=/tmp/nexus.png
LAST=/tmp/nexus.last.md5
STAMP=/tmp/nexus.last_ok   # epoch of the last successful fetch; cron.sh restarts us when it goes stale
URL="$BRIDGE_URL/$BRIDGE_TOKEN"
T=${FETCH_TIMEOUT:-15}
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }
get() { # get <outfile|-> <path> : wget with a hard timeout. busybox 1.7.2 wget has no -T, and a bridge that
  # vanishes mid-request (container recreate) leaves a half-open socket that would otherwise block forever.
  ( timeout -t $T wget -q -O "$1" "$URL$2"; r=$?; exit $r ) 2>/dev/null   # r=$? keeps ash from exec-ing wget (else "Terminated" leaks to the log)
}
ok() { date +%s > $STAMP; }
nexus_pids() { # every shell running "nexus.sh run": main loop, its reader/poller subshells AND their while-loop grandchildren
  for p in /proc/[0-9]*; do case "$( { tr '\0' ' ' < $p/cmdline; } 2>/dev/null )" in *"nexus.sh run ") echo ${p#/proc/};; esac; done   # anchored: never match some other shell quoting it
}

COUNT=/tmp/nexus.count
FAILS=0
fetch() { # fetch <path> [full] ; draws if we got a non-empty file that differs from the last frame
  rm -f $SHOT.tmp
  if get $SHOT.tmp "$1" && [ -s $SHOT.tmp ]; then
    ok
    [ $FAILS -gt 0 ] && { FAILS=0; rm -f $LAST; }   # recovered: force a redraw to wipe the "bridge unreachable" line
    sum=$(md5sum $SHOT.tmp | cut -c1-32)
    if [ "$sum" != "$(cat $LAST 2>/dev/null)" ]; then
      n=$(( $(cat $COUNT 2>/dev/null || echo 0) + 1 ))
      hint=$(get - /hint)
      every=${FULL_REFRESH_EVERY:-0}
      if [ "$2" = "full" ] || [ "$hint" = "full" ] || { [ "$every" -gt 0 ] && [ $n -ge "$every" ]; }; then flag="-f"; n=0; else flag=""; fi
      echo $n > $COUNT
      mv $SHOT.tmp $SHOT && eips $flag -g $SHOT && echo "$sum" > $LAST
    fi
    return 0
  fi
  rm -f $SHOT.tmp
  FAILS=$(( FAILS + 1 ))
  log "fetch failed ($FAILS): $1"
  [ $FAILS -ge ${FAIL_HINT_AFTER:-3} ] && eips 0 39 "bridge unreachable $(date +%H:%M)" 2>/dev/null
  return 1
}

reader() { # reader <device> <n> : one line "sec usec type code value" per input event
  # The device is opened ONCE (stdin of the loop) so events queue in the kernel between reads.
  # Re-opening per event loses the key event that follows the keypad's scan-code event.
  while :; do
    dd bs=16 count=1 of=/tmp/nexus.ev$2 2>/dev/null
    hexdump -v -e '1/4 "%u " 1/4 "%u " 1/2 "%u " 1/2 "%u " 1/4 "%u\n"' /tmp/nexus.ev$2
  done < $1
}

report_battery() { # tell the bridge our battery level and charging state (shown by the app)
  lvl=$(cat /sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity 2>/dev/null | tr -dc 0-9)
  chg=$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null | tr -dc 0-9)
  [ -n "$lvl" ] && get - "/battery?level=$lvl&charging=${chg:-0}" >/dev/null   # never -O /dev/null: this wget refuses existing files
}

poller() { # sleep what the bridge says (5 s while music plays on the Media tab), else POLL_SECONDS
  while :; do
    report_battery >/dev/null 2>&1
    s=$(get - "/poll?default=$POLL_SECONDS" | tr -dc 0-9)
    [ -n "$s" ] && [ "$s" -ge 1 ] && [ "$s" -le 600 ] || s=$POLL_SECONDS
    sleep $s; echo "0 0 poll 0 0"
  done
}

keyname() { # keyname <code>
  case $1 in
    103) echo up;; 108) echo down;; 105) echo left;; 106) echo right;; 194) echo select;;
    193|191) [ "$FLIP_SIDE_BUTTONS" = "1" ] && echo next || echo prev;;   # upper side buttons
    104|109) [ "$FLIP_SIDE_BUTTONS" = "1" ] && echo prev || echo next;;   # lower side buttons
    158) echo f1;; 29) echo f2;; 139) echo f3;; 102) echo f4;;   # bottom row = soft keys F1..F4
    *) echo "";;
  esac
}

run() {
  log "starting, bridge=$BRIDGE_URL"
  if [ "$STOP_FRAMEWORK" = "1" ]; then
    log "stopping framework"; /etc/init.d/framework stop >> $LOG 2>&1
  fi
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
  eips -c
  rm -f $FIFO $LAST; mkfifo $FIFO
  ok   # the watchdog's stale clock starts now, not at an unknown time in the past
  reader /dev/input/event0 0 > $FIFO &
  R0=$!
  reader /dev/input/event1 1 > $FIFO &
  R1=$!
  poller > $FIFO &
  P=$!
  echo "$R0 $R1 $P" > $KIDS
  trap "kill $R0 $R1 $P 2>/dev/null; killall dd 2>/dev/null; exit 0" TERM INT
  fetch /reload full || fetch /screen.png full
  while read sec usec type code value; do
    if [ "$type" = "poll" ]; then fetch "/screen.png?fresh=1"; continue; fi
    [ "$type" = "1" ] && [ "$value" = "1" ] || continue
    k=$(keyname $code)
    [ -n "$k" ] || continue
    log "key $code -> $k"
    case $k in prev|next) fetch /key/$k full;; *) fetch /key/$k;; esac
  done < $FIFO
  log "fifo closed, exiting"
}

case "$1" in
  run) run;;
  start)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "already running"; exit 0; fi
    ( /bin/sh $0 run >> $LOG 2>&1 < /dev/null & echo $! > $PID )
    sleep 1; echo "started pid $(cat $PID)";;
  stop)
    pids=$(nexus_pids)   # killing only pid+children leaked the two reader loops (grandchildren) on every restart
    [ -n "$pids" ] && kill $pids 2>/dev/null
    killall dd 2>/dev/null
    # the main loop only handles TERM once a fetch in flight returns (<= FETCH_TIMEOUT); wait, then force
    i=0; while [ -n "$(nexus_pids)" ] && [ $i -lt 20 ]; do sleep 1; i=$(( i + 1 )); done
    pids=$(nexus_pids); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    killall dd 2>/dev/null
    rm -f $PID $KIDS $STAMP
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    [ "$STOP_FRAMEWORK" = "1" ] && /etc/init.d/framework start >/dev/null 2>&1
    echo stopped;;
  restart) /bin/sh $0 stop; sleep 2; /bin/sh $0 start;;
  status)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "running pid $(cat $PID)"; else echo "not running"; fi
    [ -f $STAMP ] && echo "last successful fetch $(( $(date +%s) - $(cat $STAMP) ))s ago"
    tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
