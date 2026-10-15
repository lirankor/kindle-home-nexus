#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips; sleeps (RTC suspend) on the screensaver.
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
KEYSTAMP=/tmp/nexus.last_key   # epoch of the last hardware button event (the readers write it): no suspend within KEY_HOLD
SLEEPING=/tmp/nexus.sleeping   # exists while suspended, holds the planned wake epoch: cron.sh skips its stale check
LASTWAKE=/tmp/nexus.last_wake  # epoch of the last resume: cron.sh gives us WAKE_GRACE to reconnect
BATSTAMP=/tmp/nexus.last_bat   # epoch of the last battery report (once a minute)
RTC=/sys/class/rtc/rtc1        # pmic_rtc: the only RTC with a wakealarm. Its clock is NOT the system clock: alarm = its since_epoch + secs
GOV=/sys/devices/system/cpu/cpu0/cpufreq
URL="$BRIDGE_URL/$BRIDGE_TOKEN"
T=${FETCH_TIMEOUT:-15}
SLEEP=${SLEEP:-1}; MIN_SLEEP=${MIN_SLEEP:-30}; MAX_SLEEP=${MAX_SLEEP:-7200}; KEY_HOLD=${KEY_HOLD:-300}; WAKE_HOLD=${WAKE_HOLD:-300}
WIFI_WAIT=${WIFI_WAIT:-20}; SLEEP_FALLBACK=${SLEEP_FALLBACK:-600}; BATTERY_EVERY=${BATTERY_EVERY:-60}
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }
get() { # get <outfile|-> <path> : wget with a hard timeout. busybox 1.7.2 wget has no -T, and a bridge that
  # vanishes mid-request (container recreate) leaves a half-open socket that would otherwise block forever.
  ( timeout -t $T wget -q -O "$1" "$URL$2"; r=$?; exit $r ) 2>/dev/null   # r=$? keeps ash from exec-ing wget (else "Terminated" leaks to the log)
}
ok() { date +%s > $STAMP; }
nexus_pids() { # every shell running "nexus.sh run": main loop, its reader/poller subshells AND their while-loop grandchildren
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
etag() { cat $LAST 2>/dev/null; }

reader() { # reader <device> <n> : one line "sec usec type code value" per input event
  # The device is opened ONCE (stdin of the loop) so events queue in the kernel between reads.
  # Re-opening per event loses the key event that follows the keypad's scan-code event.
  while :; do
    dd bs=16 count=1 of=/tmp/nexus.ev$2 2>/dev/null
    hexdump -v -e '1/4 "%u " 1/4 "%u " 1/2 "%u " 1/2 "%u " 1/4 "%u\n"' /tmp/nexus.ev$2
    date +%s > $KEYSTAMP   # the main loop checks this before suspending: a button within KEY_HOLD keeps us awake
  done < $1
}

report_battery() { # tell the bridge our battery level and charging state (shown by the app), at most once a minute
  now=$(date +%s)
  [ $(( now - $(cat $BATSTAMP 2>/dev/null || echo 0) )) -ge $BATTERY_EVERY ] || return 0
  lvl=$(cat /sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity 2>/dev/null | tr -dc 0-9)
  chg=$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null | tr -dc 0-9)
  [ -n "$lvl" ] && get - "/battery?level=$lvl&charging=${chg:-0}" >/dev/null && echo $now > $BATSTAMP   # never -O /dev/null: this wget refuses existing files
}

poller() { # one "poll" line per cadence the bridge asks for (/schedule: 5 s while music plays on the Media tab, 60 s on the
  # screensaver, else POLL_SECONDS) carrying the bridge's sleep/awake verdict, so the main loop only asks again when it may sleep
  s=$POLL_SECONDS
  while :; do
    sleep $s
    set -- $(get - "/schedule?default=$POLL_SECONDS")
    s=$1; case "$s" in ''|*[!0-9]*) s=$POLL_SECONDS;; esac
    [ "$s" -ge 1 ] && [ "$s" -le 600 ] || s=$POLL_SECONDS
    echo "0 0 poll ${2:-awake} 0"
  done
}

# ---- sleep cycle (docs/battery-saver-plan.md) ----
# On the screensaver the bridge's /schedule says "sleep" with the seconds until the next scheduled wake (day: every
# 10 min, night: hourly, computed server-side in local time). We draw the frame with the "sleeping · next HH:MM" badge,
# set the RTC alarm and suspend; the write to /sys/power/state blocks until resume. After the resume: Wi-Fi back
# (bounded), ask /schedule again, draw, suspend again — about 10 s awake per cycle. Anything unexpected (a key, an early
# resume = power slider, a bridge that cannot be reached right after a wake) is handled without ever busy-looping.
AWAKE_UNTIL=0   # epoch: after an early resume (slider) or a failed suspend we stay awake until then
WOKE=$(date +%s)
BLOCKED=
sleep_blocked() { # prints why we must stay awake, nothing when sleeping is fine
  [ "$SLEEP" = "1" ] || { echo "SLEEP=0"; return; }
  [ -f $DIR/NOSLEEP ] && { echo "NOSLEEP file"; return; }
  now=$(date +%s)
  k=$(cat $KEYSTAMP 2>/dev/null || echo 0)
  [ $(( now - k )) -lt $KEY_HOLD ] && { echo "key $(( now - k ))s ago"; return; }
  [ $now -lt $AWAKE_UNTIL ] && { echo "hold $(( AWAKE_UNTIL - now ))s"; return; }
}
sched_get() { # /schedule with a few bounded retries (right after a resume the first request can fail before DHCP is done)
  i=0
  while [ $i -lt 3 ]; do
    r=$(get - "/schedule?default=$POLL_SECONDS")
    [ -n "$r" ] && { echo "$r"; return 0; }
    i=$(( i + 1 )); sleep 2
  done
  return 1
}
wait_wifi() { # after a resume the ar6003 is powered off and wifid re-associates on its own (~5 s); bounded wait
  i=0
  while [ $i -lt $WIFI_WAIT ]; do
    [ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" = "CONNECTED" ] && break
    sleep 1; i=$(( i + 1 ))
  done
  log "wifi $(lipc-get-prop com.lab126.wifid cmState 2>/dev/null) after ${i}s"
}
suspend_for() { # suspend_for <secs> <label> : RTC alarm + suspend; returns 1 when we must stay awake instead
  rtcnow=$(cat $RTC/since_epoch 2>/dev/null)
  case "$rtcnow" in ''|*[!0-9]*) AWAKE_UNTIL=$(( $(date +%s) + WAKE_HOLD )); log "no rtc clock, staying awake ${WAKE_HOLD}s"; return 1;; esac
  alarm=$(( rtcnow + $1 ))
  echo 0 > $RTC/wakealarm 2>/dev/null   # must be cleared before a new value is accepted
  echo $alarm > $RTC/wakealarm 2>/dev/null
  [ "$(cat $RTC/wakealarm 2>/dev/null)" = "$alarm" ] || { AWAKE_UNTIL=$(( $(date +%s) + WAKE_HOLD )); log "wakealarm not set ($alarm), staying awake ${WAKE_HOLD}s"; return 1; }
  t0=$(date +%s)
  echo $(( t0 + $1 )) > $SLEEPING; ok
  log "sleeping ${1}s until $2 (awake $(( t0 - WOKE ))s)"
  sync
  echo mem > /sys/power/state 2>>$LOG   # blocks until resume
  rc=$?
  t1=$(date +%s); slept=$(( t1 - t0 ))
  echo 0 > $RTC/wakealarm 2>/dev/null
  rm -f $SLEEPING; echo $t1 > $LASTWAKE; ok; WOKE=$t1
  if [ $rc -ne 0 ]; then
    AWAKE_UNTIL=$(( t1 + WAKE_HOLD )); log "suspend failed (rc=$rc), staying awake ${WAKE_HOLD}s"; return 1
  fi
  if [ $slept -lt $(( $1 - 5 )) ]; then
    AWAKE_UNTIL=$(( t1 + WAKE_HOLD )); log "resumed early after ${slept}s (planned $1): power slider? staying awake ${WAKE_HOLD}s"
  else
    log "resumed after ${slept}s (planned $1)"
  fi
  return 0
}
maybe_sleep() { # called from the main loop after a poll the bridge flagged "sleep"
  cycle=0   # >0 once we have been suspended at least once in this call
  while :; do
    r=$(sleep_blocked)
    if [ -n "$r" ]; then
      [ "$r" != "$BLOCKED" ] && log "awake: $r"; BLOCKED=$r
      if [ $cycle -gt 0 ]; then get - "/schedule?woke=1" >/dev/null; fetch "/screen.png?fresh=1&etag=$(etag)"; fi   # bridge: hold awake, drop the badge
      return
    fi
    BLOCKED=
    sched=$(sched_get)
    if [ -z "$sched" ]; then
      [ $cycle -eq 0 ] && return   # not sleeping yet and the bridge is away: the normal poll loop shows the footer
      log "bridge unreachable after the wake: sleeping ${SLEEP_FALLBACK}s"
      suspend_for $SLEEP_FALLBACK "fallback" || return
      wait_wifi; cycle=$(( cycle + 1 )); continue
    fi
    set -- $sched   # "<poll s> <sleep|awake> <wake epoch> <sleep s> <night> <HH:MM>"
    if [ "$2" != "sleep" ]; then
      [ $cycle -gt 0 ] && fetch "/screen.png?fresh=1&etag=$(etag)"
      return
    fi
    secs=$4; wake=$3; label=$6
    [ -n "$SLEEP_OVERRIDE" ] && { secs=$SLEEP_OVERRIDE; wake=$(( $(date +%s) + secs )); label="test+${secs}s"; }   # rollout test: short cycles without touching the bridge
    case "$secs" in ''|*[!0-9]*) log "bad schedule: $sched"; return;; esac
    [ "$secs" -ge $MIN_SLEEP ] && [ "$secs" -le $MAX_SLEEP ] || { log "schedule out of range: $sched"; return; }
    report_battery
    fetch "/sleep?secs=$secs&wake=$wake&night=$5&etag=$(etag)"   # the frame with the badge; on failure right after a wake we still sleep
    [ -n "$(sleep_blocked)" ] && continue   # a button arrived while we talked to the bridge
    suspend_for $secs "$label" || return
    wait_wifi
    cycle=$(( cycle + 1 ))
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
  log "starting, bridge=$BRIDGE_URL sleep=$SLEEP"
  if [ "$STOP_FRAMEWORK" = "1" ]; then
    log "stopping framework"; /etc/init.d/framework stop >> $LOG 2>&1
  fi
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
  set_governor "${CPU_GOVERNOR-ondemand}"
  eips -c
  rm -f $FIFO $LAST $SLEEPING; mkfifo $FIFO
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
    if [ "$type" = "poll" ]; then
      report_battery
      fetch "/screen.png?fresh=1&etag=$(etag)"
      [ "$code" = "sleep" ] && maybe_sleep
      continue
    fi
    [ "$type" = "1" ] && [ "$value" = "1" ] || continue
    k=$(keyname $code)
    [ -n "$k" ] || continue
    log "key $code -> $k"
    case $k in prev|next) fetch "/key/$k?etag=$(etag)" full;; *) fetch "/key/$k?etag=$(etag)";; esac
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
    echo 0 > $RTC/wakealarm 2>/dev/null
    rm -f $PID $KIDS $STAMP $SLEEPING $LASTWAKE $KEYSTAMP $BATSTAMP
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    [ -f $GOV/scaling_governor ] && echo performance > $GOV/scaling_governor 2>/dev/null   # the stock setting
    [ "$STOP_FRAMEWORK" = "1" ] && /etc/init.d/framework start >/dev/null 2>&1
    echo stopped;;
  restart) /bin/sh $0 stop; sleep 2; /bin/sh $0 start;;
  status)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "running pid $(cat $PID)"; else echo "not running"; fi
    [ -f $STAMP ] && echo "last successful fetch $(( $(date +%s) - $(cat $STAMP) ))s ago"
    [ -f $SLEEPING ] && echo "sleeping stamp present (planned wake $(cat $SLEEPING))"
    [ -f $LASTWAKE ] && echo "last wake $(( $(date +%s) - $(cat $LASTWAKE) ))s ago"
    echo "sleep=$SLEEP$([ -f $DIR/NOSLEEP ] && echo ' (NOSLEEP file)') governor=$(cat $GOV/scaling_governor 2>/dev/null)"
    tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
