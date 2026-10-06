#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips.
# Usage: nexus.sh start|stop|restart|status|run
export PATH=/usr/sbin:/sbin:/usr/bin:/bin
BB=/mnt/us/usbnet/bin/busybox   # modern busybox from USBNetwork (read -t, hexdump, md5sum...)
DIR=/mnt/us/nexus
. $DIR/config
LOG=$DIR/nexus.log
PID=$DIR/nexus.pid
FIFO=/tmp/nexus.keys
SHOT=/tmp/nexus.png
LAST=/tmp/nexus.last.md5
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }

fetch() { # fetch <path> ; draws if we got a non-empty file
  rm -f $SHOT.tmp
  wget -q -O $SHOT.tmp "$BRIDGE_URL$1" 2>/dev/null
  if [ -s $SHOT.tmp ]; then
    sum=$(md5sum < $SHOT.tmp | cut -c1-32)
    if [ "$sum" != "$(cat $LAST 2>/dev/null)" ]; then
      mv $SHOT.tmp $SHOT && eips -g $SHOT && echo "$sum" > $LAST
    fi
    return 0
  fi
  log "fetch failed: $1"
  eips 0 39 "nexus: bridge unreachable ($BRIDGE_URL) $(date +%H:%M)" 2>/dev/null
  return 1
}

reader() { # reader <device> : one line "type code value" per event
  while :; do
    dd if=$1 bs=16 count=1 2>/dev/null | hexdump -e '8/1 "" 1/2 "%u " 1/2 "%u " 1/4 "%u\n"'
  done
}

keyname() { # keyname <code>
  case $1 in
    103) echo up;; 108) echo down;; 105) echo left;; 106) echo right;; 194) echo select;;
    193|191) echo prev;;      # upper side buttons (page back)
    104|109) echo next;;      # lower side buttons (page forward)
    158) echo back;; 139) echo menu;; 102) echo home;; 29) echo keyboard;;
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
  reader /dev/input/event0 > $FIFO &
  R0=$!
  reader /dev/input/event1 > $FIFO &
  R1=$!
  trap "kill $R0 $R1 2>/dev/null; killall dd 2>/dev/null; exit 0" TERM INT
  fetch /reload || fetch /screen.png
  while :; do
    # wait for a key for POLL_SECONDS, else refresh
    if read -t $POLL_SECONDS type code value < $FIFO; then
      [ "$type" = "1" ] && [ "$value" = "1" ] || continue
      k=$(keyname $code)
      [ -n "$k" ] || continue
      log "key $code -> $k"
      fetch /key/$k
    else
      fetch /screen.png
    fi
  done
}

case "$1" in
  run) run;;
  start)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "already running"; exit 0; fi
    ( $BB sh $0 run >> $LOG 2>&1 < /dev/null & echo $! > $PID )
    sleep 1; echo "started pid $(cat $PID)";;
  stop)
    [ -f $PID ] && kill $(cat $PID) 2>/dev/null; killall dd 2>/dev/null; rm -f $PID
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    [ "$STOP_FRAMEWORK" = "1" ] && /etc/init.d/framework start >/dev/null 2>&1
    echo stopped;;
  restart) $BB sh $0 stop; sleep 2; $BB sh $0 start;;
  status) if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "running pid $(cat $PID)"; else echo "not running"; fi; tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
