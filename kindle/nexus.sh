#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips.
# Runs on the Kindle 4's own busybox 1.7.2 /bin/sh (no read -t, no od; hexdump -e only from files).
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
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }

COUNT=/tmp/nexus.count
fetch() { # fetch <path> [full] ; draws if we got a non-empty file that differs from the last frame
  rm -f $SHOT.tmp
  wget -q -O $SHOT.tmp "$BRIDGE_URL/$BRIDGE_TOKEN$1" 2>/dev/null
  if [ -s $SHOT.tmp ]; then
    sum=$(md5sum $SHOT.tmp | cut -c1-32)
    if [ "$sum" != "$(cat $LAST 2>/dev/null)" ]; then
      n=$(( $(cat $COUNT 2>/dev/null || echo 0) + 1 ))
      hint=$(wget -q -O - "$BRIDGE_URL/$BRIDGE_TOKEN/hint" 2>/dev/null)
      if [ "$2" = "full" ] || [ "$hint" = "full" ] || [ $n -ge ${FULL_REFRESH_EVERY:-10} ]; then flag="-f"; n=0; else flag=""; fi
      echo $n > $COUNT
      mv $SHOT.tmp $SHOT && eips $flag -g $SHOT && echo "$sum" > $LAST
    fi
    return 0
  fi
  log "fetch failed: $1"
  eips 0 39 "bridge unreachable $(date +%H:%M)" 2>/dev/null
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

poller() { while :; do sleep $POLL_SECONDS; echo "0 0 poll 0 0"; done; }

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
    if [ "$type" = "poll" ]; then fetch /screen.png; continue; fi
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
    [ -f $PID ] && kill $(cat $PID) 2>/dev/null
    [ -f $KIDS ] && kill $(cat $KIDS) 2>/dev/null
    killall dd 2>/dev/null; rm -f $PID $KIDS
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    [ "$STOP_FRAMEWORK" = "1" ] && /etc/init.d/framework start >/dev/null 2>&1
    echo stopped;;
  restart) /bin/sh $0 stop; sleep 2; /bin/sh $0 start;;
  status) if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "running pid $(cat $PID)"; else echo "not running"; fi; tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
