#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips. Saves power by switching the
# Wi-Fi RADIO off between updates while the screensaver shows (the device itself never suspends: a key
# press cannot wake a suspended Kindle 4, only the power slider can — see docs/battery-saver-plan.md).
# Runs on the Kindle 4's own busybox 1.7.2 /bin/sh (no read -t, no od, no wget -T, wget -O refuses existing files,
# wget accepts only HTTP 200/206, hexdump -e only from files, md5sum but no sha1sum).
# Usage: nexus.sh start|stop|restart|status|run
export PATH=/usr/sbin:/sbin:/usr/bin:/bin
DIR=/mnt/us/nexus
. $DIR/config
LOG=$DIR/nexus.log
PID=$DIR/nexus.pid
KIDS=$DIR/children.pid
FIFO=/tmp/nexus.keys
SHOT=/tmp/nexus.png
LAST=/tmp/nexus.last.md5   # md5 of the frame on the panel = the bridge's ETag; sent back as ?etag= so an unchanged frame is an empty 200
STAMP=/tmp/nexus.last_ok   # epoch of the last successful fetch; cron.sh restarts us when it goes stale
KEYSTAMP=/tmp/nexus.last_key   # epoch of the last hardware button event (the readers write it): no radio-off within KEY_HOLD
RADIOOFF=/tmp/nexus.radio_off  # exists while the Wi-Fi radio is switched off, holds the epoch of the next update
WINDOW=/tmp/nexus.window   # "<end epoch> <window s>" of the current radio-off window: cron.sh widens its stale threshold with it
BATSTAMP=/tmp/nexus.last_bat   # epoch of the last battery report (once a minute)
DRAWING=/tmp/nexus.drawing     # exists while eips runs: a draw cut short (restart, kill) is redone in full next cycle
CONN=$DIR/connecting.png       # 600x800 frame (icon centred) drawn the instant a key wakes the radio (deployed with nexus.sh)
GOV=/sys/devices/system/cpu/cpu0/cpufreq
URL="$BRIDGE_URL/$BRIDGE_TOKEN"
T=${FETCH_TIMEOUT:-15}
# RADIO_DUTY=0 (or the legacy SLEEP=0) keeps the radio up around the clock.
RADIO_DUTY=${RADIO_DUTY:-${SLEEP:-1}}
MIN_DOZE=${MIN_DOZE:-60}; MAX_DOZE=${MAX_DOZE:-7800}; KEY_HOLD=${KEY_HOLD:-300}
WIFI_WAIT=${WIFI_WAIT:-30}; RADIO_FAIL_HOLD=${RADIO_FAIL_HOLD:-900}
BATTERY_EVERY=${BATTERY_EVERY:-60}; EINK_SETTLE=${EINK_SETTLE:-2}
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }
get() { # get <outfile|-> <path> : wget with a hard timeout. busybox 1.7.2 wget has no -T, and a bridge that
  # vanishes mid-request (container recreate) leaves a half-open socket that would otherwise block forever.
  ( timeout -t $T wget -q -O "$1" "$URL$2"; r=$?; exit $r ) 2>/dev/null   # r=$? keeps ash from exec-ing wget (else "Terminated" leaks to the log)
}
ok() { date +%s > $STAMP; }
nexus_pids() { # every shell running "nexus.sh run": main loop, its reader subshells AND their while-loop grandchildren
  for p in /proc/[0-9]*; do case "$( { tr '\0' ' ' < $p/cmdline; } 2>/dev/null )" in *"nexus.sh run ") echo ${p#/proc/};; esac; done   # anchored: never match some other shell quoting it
}
set_governor() { # set_governor <name> : only when the kernel offers it (ondemand idles at 160 MHz, ~11 mA less than performance)
  [ -n "$1" ] && [ -f $GOV/scaling_available_governors ] || return 0
  case " $(cat $GOV/scaling_available_governors) " in *" $1 "*) echo $1 > $GOV/scaling_governor 2>/dev/null && log "cpu governor $1";; *) log "cpu governor $1 not available";; esac
}

COUNT=/tmp/nexus.count
FAILS=0
fetch() { # fetch <path> [full] ; draws if we got a non-empty file that differs from the last frame; an empty 200 = unchanged (ETag matched)
  rm -f $SHOT.tmp
  if get $SHOT.tmp "$1"; then
    ok
    [ $FAILS -gt 0 ] && { FAILS=0; rm -f $LAST; }   # recovered: next fetch without ?etag= -> full frame, redraw wipes the "bridge unreachable" line
    [ -s $SHOT.tmp ] || { rm -f $SHOT.tmp; return 0; }
    sum=$(md5sum $SHOT.tmp | cut -c1-32)
    if [ "$sum" != "$(cat $LAST 2>/dev/null)" ]; then
      n=$(( $(cat $COUNT 2>/dev/null || echo 0) + 1 ))
      hint=$(get - /hint)
      every=${FULL_REFRESH_EVERY:-0}
      if [ "$2" = "full" ] || [ "$hint" = "full" ] || { [ "$every" -gt 0 ] && [ $n -ge "$every" ]; }; then flag="-f"; n=0; else flag=""; fi
      echo $n > $COUNT
      touch $DRAWING
      mv $SHOT.tmp $SHOT && eips $flag -g $SHOT && echo "$sum" > $LAST
      rm -f $DRAWING
    fi
    return 0
  fi
  rm -f $SHOT.tmp
  FAILS=$(( FAILS + 1 ))
  log "fetch failed ($FAILS): $1"
  [ $FAILS -ge ${FAIL_HINT_AFTER:-3} ] && eips 0 39 "bridge unreachable $(date +%H:%M)" 2>/dev/null
  return 1
}
etag() { cat $LAST 2>/dev/null; }

reader() { # reader <device> <n> : one line "sec usec type code value" per input event
  # The device is opened ONCE (stdin of the loop) so events queue in the kernel between reads.
  # Re-opening per event loses the key event that follows the keypad's scan-code event.
  while :; do
    dd bs=16 count=1 of=/tmp/nexus.ev$2 2>/dev/null
    hexdump -v -e '1/4 "%u " 1/4 "%u " 1/2 "%u " 1/2 "%u " 1/4 "%u\n"' /tmp/nexus.ev$2
    date +%s > $KEYSTAMP   # the main loop checks this before switching the radio off
  done < $1
}

report_battery() { # tell the bridge our battery level and charging state (shown by the app), at most once a minute
  now=$(date +%s)
  [ $(( now - $(cat $BATSTAMP 2>/dev/null || echo 0) )) -ge $BATTERY_EVERY ] || return 0
  lvl=$(cat /sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity 2>/dev/null | tr -dc 0-9)
  chg=$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null | tr -dc 0-9)
  [ -n "$lvl" ] && get - "/battery?level=$lvl&charging=${chg:-0}" >/dev/null && echo $now > $BATSTAMP   # never -O /dev/null: this wget refuses existing files
}

# ---- radio duty cycle (docs/battery-saver-plan.md) ----
# The device stays awake and reacts to every button at once. While the app shows the screensaver and no
# button was pressed for 5 min, the bridge's /schedule answers "doze" with the seconds until the next
# scheduled update (day: every DAY_WAKE_MIN on the :00/:10/… grid, night 00:00-06:00 local: every two
# hours). We then draw a complete frame and switch the Wi-Fi radio off until that time. A button press
# returns from the main loop's blocking read at once, brings the radio up (~6 s measured) and redraws.
DUTY_UNTIL=0      # epoch: no duty cycling until then (set when the radio refused to come back)
RECONNECTED=      # 1 right after the radio came back: the next frame is drawn with a full refresh
RADIO_UP_AT=$(date +%s)   # when the radio last came up: gives the "radio on Ns" figure in the log
OVERRIDE_LEFT=${DOZE_OVERRIDE_CYCLES:-3}   # how many DOZE_OVERRIDE test windows before the bridge schedule takes over
BLOCKED=
duty_blocked() { # prints why the radio must stay up, nothing when switching it off is fine
  [ "$RADIO_DUTY" = "1" ] || { echo "RADIO_DUTY=0"; return; }
  [ -f $DIR/NORADIO ] && { echo "NORADIO file"; return; }
  [ -f $DIR/NOSLEEP ] && { echo "NOSLEEP file"; return; }   # the older name for the same kill switch
  now=$(date +%s)
  k=$(cat $KEYSTAMP 2>/dev/null || echo 0)
  [ $(( now - k )) -lt $KEY_HOLD ] && { echo "key $(( now - k ))s ago"; return; }
  [ $now -lt $DUTY_UNTIL ] && { echo "radio hold $(( DUTY_UNTIL - now ))s"; return; }
}
radio_state() { lipc-get-prop com.lab126.wifid cmState 2>/dev/null; }
radio_down() { # radio_down <secs> <label> : switch the radio off until the next update; 1 = it stayed on
  now=$(date +%s)
  echo "$(( now + $1 )) $1" > $WINDOW   # cron.sh: no successful fetch is expected before that + its grace
  if lipc-set-prop com.lab126.cmd wirelessEnable 0 2>/dev/null; then
    echo $(( now + $1 )) > $RADIOOFF
    log "radio off for ${1}s, next update $2 (radio was on $(( now - RADIO_UP_AT ))s)"
    return 0
  fi
  rm -f $WINDOW
  log "could not switch the radio off, leaving it on"
  return 1
}
# The bridge cannot reach us while the radio is off, so a key press would show nothing for the ~6 s the radio needs.
# We draw a picture from our own storage the instant the key comes in: a full 600x800 frame with the icon in the
# middle, because this Kindle 4's eips (firmware 4.1.4) ignores -x/-y for -g (with them it draws nothing and still
# exits 0). The full redraw after the reconnect replaces it. No network, so it works whatever the bridge or the screen.
show_connecting() {
  if [ -s $CONN ] && eips -g $CONN >/dev/null 2>&1; then return 0; fi
  eips 1 38 "Connecting..." 2>/dev/null   # icon missing or this eips cannot place an image: a text line
}
radio_up() { # radio_up <why> : bring the radio back and wait (bounded) for the association; always returns 0
  [ -f $RADIOOFF ] || return 0
  rm -f $RADIOOFF
  rm -f $LAST; RECONNECTED=1   # force a full redraw after every reconnect: never leave a ghosted frame
  t0=$(date +%s)
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  [ "$1" = "key" ] && show_connecting   # someone is waiting: show it while the radio associates
  i=0
  while [ $i -lt $WIFI_WAIT ]; do
    [ "$(radio_state)" = "CONNECTED" ] && break
    sleep 1; i=$(( i + 1 ))
    [ $i -eq 10 ] && lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null   # one more kick halfway
  done
  RADIO_UP_AT=$(date +%s)
  if [ "$(radio_state)" = "CONNECTED" ]; then
    log "radio on after ${i}s ($1)"
    return 0
  fi
  # Never leave the panel offline: keep the radio up and stop duty cycling for a while.
  [ "$1" = "key" ] && eips 1 38 "No Wi-Fi yet, still trying ($(date +%H:%M))" 2>/dev/null
  DUTY_UNTIL=$(( RADIO_UP_AT + RADIO_FAIL_HOLD ))
  log "radio still $(radio_state) after ${i}s ($1): leaving it on, no duty cycling for ${RADIO_FAIL_HOLD}s"
  return 0
}
radio_force_on() { # at start and stop: an instance that died mid-window must not leave the radio off
  [ "$(lipc-get-prop com.lab126.cmd wirelessEnable 2>/dev/null)" = "0" ] || return 0
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  i=0
  while [ $i -lt $WIFI_WAIT ] && [ "$(radio_state)" != "CONNECTED" ]; do sleep 1; i=$(( i + 1 )); done
  log "radio was off, switched on again after ${i}s ($(radio_state))"
}

# ---- poll timer ----
# There is no poller process any more: the main loop blocks on the FIFO (so a button is handled the
# instant it is pressed) and arms a one-shot timer for the next poll. GEN makes a superseded timer's
# line (one armed for the end of a radio-off window, cut short by a key press) harmless.
GEN=0
TIMER=
arm() { # arm <secs> : one "poll" line in <secs>, replacing whatever was armed
  GEN=$(( GEN + 1 ))
  [ -n "$TIMER" ] && kill $TIMER 2>/dev/null
  ( sleep "$1"; echo "0 0 poll $GEN 0" > $FIFO ) &
  TIMER=$!
}

cycle() { # one scheduled update: radio up if needed, battery + frame, then decide the next window
  radio_up poll
  FF=; [ "$RECONNECTED" = "1" ] && { FF=full; RECONNECTED=; }   # first frame after a reconnect: full refresh
  report_battery
  sched=$(get - "/schedule?default=$POLL_SECONDS")
  set -- $sched   # "<poll s> <doze|awake> <next update epoch> <window s> <night 0|1> <HH:MM local>"
  s=$1; verdict=$2; secs=$4; label=$6
  case "$s" in ''|*[!0-9]*) s=$POLL_SECONDS;; esac
  [ "$s" -ge 1 ] && [ "$s" -le 600 ] || s=$POLL_SECONDS
  if [ -n "$DOZE_OVERRIDE" ] && [ "$verdict" = "doze" ] && [ $OVERRIDE_LEFT -gt 0 ]; then   # rollout test: a few short windows, then the real schedule
    OVERRIDE_LEFT=$(( OVERRIDE_LEFT - 1 )); secs=$DOZE_OVERRIDE; label="test+${secs}s ($OVERRIDE_LEFT left)"
  fi
  if [ "$verdict" != "doze" ]; then
    [ -n "$sched" ] || log "no schedule from the bridge, polling every ${s}s"
    fetch "/screen.png?fresh=1&etag=$(etag)" $FF
    arm $s
    return
  fi
  r=$(duty_blocked)
  if [ -n "$r" ]; then
    [ "$r" != "$BLOCKED" ] && log "radio stays on: $r"; BLOCKED=$r
    fetch "/screen.png?fresh=1&etag=$(etag)" $FF
    arm $s
    return
  fi
  BLOCKED=
  case "$secs" in ''|*[!0-9]*) log "bad schedule: $sched"; fetch "/screen.png?fresh=1&etag=$(etag)" $FF; arm $s; return;; esac
  if [ "$secs" -lt $MIN_DOZE ] || [ "$secs" -gt $MAX_DOZE ]; then
    log "window out of range: $sched"
    fetch "/screen.png?fresh=1&etag=$(etag)" $FF; arm $s; return
  fi
  # Every frame of the low-power path is a FULL flashing refresh of a freshly fetched frame: partial
  # updates ghost on this panel and a half-finished one would stay on the screen for the whole window
  # (the owner's photo 2026-10-15: washed out, torn, ghosted). Then settle + sync before anything else.
  [ -f $DRAWING ] && { log "previous draw was cut short, redrawing in full"; rm -f $DRAWING; }
  rm -f $LAST
  fetch "/screen.png?fresh=1" full
  sleep $EINK_SETTLE
  sync
  if [ -n "$(duty_blocked)" ]; then arm $s; return; fi   # a button arrived while we drew
  if radio_down $secs "$label"; then arm $secs; else arm $s; fi
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
  log "starting, bridge=$BRIDGE_URL radio_duty=$RADIO_DUTY"
  if [ "$STOP_FRAMEWORK" = "1" ]; then
    log "stopping framework"; /etc/init.d/framework stop >> $LOG 2>&1
  fi
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
  set_governor "${CPU_GOVERNOR-ondemand}"
  radio_force_on
  eips -c
  rm -f $FIFO $LAST $RADIOOFF $WINDOW $DRAWING; mkfifo $FIFO
  ok   # the watchdog's stale clock starts now, not at an unknown time in the past
  reader /dev/input/event0 0 > $FIFO &
  R0=$!
  reader /dev/input/event1 1 > $FIFO &
  R1=$!
  echo "$R0 $R1" > $KIDS
  trap 'kill $R0 $R1 $TIMER 2>/dev/null; killall dd 2>/dev/null; exit 0' TERM INT
  fetch /reload full || fetch /screen.png full
  arm ${POLL_SECONDS:-20}
  while read sec usec type code value; do
    if [ "$type" = "poll" ]; then
      [ "$code" = "$GEN" ] || continue   # a timer we superseded (a key press cut its window short)
      cycle
      continue
    fi
    [ "$type" = "1" ] && [ "$value" = "1" ] || continue
    k=$(keyname $code)
    [ -n "$k" ] || continue
    log "key $code -> $k"
    radio_up key   # a press while the radio is down: back up (~6 s) and the frame is redrawn in full
    if [ "$RECONNECTED" = "1" ]; then
      RECONNECTED=; fetch "/key/$k" full
    else
      case $k in prev|next) fetch "/key/$k?etag=$(etag)" full;; *) fetch "/key/$k?etag=$(etag)";; esac
    fi
    arm ${POLL_SECONDS:-20}   # the panel is in use: back to the short cadence (and re-ask /schedule)
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
    rm -f $RADIOOFF
    radio_force_on   # never leave the device offline behind us
    rm -f $PID $KIDS $STAMP $WINDOW $KEYSTAMP $BATSTAMP $DRAWING
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    [ -f $GOV/scaling_governor ] && echo performance > $GOV/scaling_governor 2>/dev/null   # the stock setting
    [ "$STOP_FRAMEWORK" = "1" ] && /etc/init.d/framework start >/dev/null 2>&1
    echo stopped;;
  restart) /bin/sh $0 stop; sleep 2; /bin/sh $0 start;;
  status)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "running pid $(cat $PID)"; else echo "not running"; fi
    [ -f $STAMP ] && echo "last successful fetch $(( $(date +%s) - $(cat $STAMP) ))s ago"
    [ -f $RADIOOFF ] && echo "radio off, next update in $(( $(cat $RADIOOFF) - $(date +%s) ))s"
    [ -f $WINDOW ] && echo "current window: $(cat $WINDOW) (end epoch, seconds)"
    echo "radio_duty=$RADIO_DUTY$([ -f $DIR/NORADIO ] && echo ' (NORADIO file)')$([ -f $DIR/NOSLEEP ] && echo ' (NOSLEEP file)') wifi=$(radio_state) governor=$(cat $GOV/scaling_governor 2>/dev/null)"
    tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
