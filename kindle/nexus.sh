#!/bin/sh
# Kindle Home Nexus client: buttons -> bridge /key/<name>, PNG -> eips. Saves power by switching the
# Wi-Fi RADIO off between updates while the screensaver shows (the device itself never suspends: a key
# press cannot wake a suspended Kindle 4, only the power slider can — see docs/battery-saver-plan.md).
# Runs on the Kindle 4's own busybox 1.7.2 /bin/sh (no read -t, no od, no wget -T, wget -O refuses existing files,
# wget accepts only HTTP 200/206, hexdump -e only from files, md5sum but no sha1sum).
# STREAM=1 in the config switches to two channels (see "two channels" below): presses go out on their own short
# request, pictures come down on one held-open request. STREAM=0 (the default) is the flow described above.
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
FULLTAG=/tmp/nexus.full.md5    # md5 of the frame on the panel when its draw was a finished FULL refresh, else absent
CONN=/tmp/nexus.conn.png       # the frame on the panel with the connecting badge (bridge /screen.png?connecting=1), fetched before the radio goes off
CONNTAG=/tmp/nexus.conn.etag   # ETag of the frame $CONN was composited on: it is drawn only while that frame is on the panel
GOV=/sys/devices/system/cpu/cpu0/cpufreq
URL="$BRIDGE_URL/$BRIDGE_TOKEN"
T=${FETCH_TIMEOUT:-15}
# RADIO_DUTY=0 (or the legacy SLEEP=0) keeps the radio up around the clock.
RADIO_DUTY=${RADIO_DUTY:-${SLEEP:-1}}
MIN_DOZE=${MIN_DOZE:-60}; MAX_DOZE=${MAX_DOZE:-7800}; KEY_HOLD=${KEY_HOLD:-300}
WIFI_WAIT=${WIFI_WAIT:-30}; RADIO_FAIL_HOLD=${RADIO_FAIL_HOLD:-900}
BATTERY_EVERY=${BATTERY_EVERY:-60}; EINK_SETTLE=${EINK_SETTLE:-2}
# LONG_PRESS: whole seconds the 5-way centre must be held to count as a long press (bridge key
# "select-long" = the focused control's extra options). 0 = off: the centre acts on key-down as before.
LONG_PRESS=${LONG_PRESS:-1}
case "$LONG_PRESS" in ''|*[!0-9]*) LONG_PRESS=1;; esac
# Two channels (STREAM=1): a press may take PRESS_LIMIT_MS at most and is never sent twice; the picture request is
# held open by the bridge for STREAM_WAIT seconds and cut off by us 5 s later (a dead connection never answers).
STREAM=${STREAM:-0}
PRESS_LIMIT_MS=${PRESS_LIMIT_MS:-300}; STREAM_WAIT=${STREAM_WAIT:-25}
case "$PRESS_LIMIT_MS" in ''|*[!0-9]*) PRESS_LIMIT_MS=300;; esac
case "$STREAM_WAIT" in ''|*[!0-9]*) STREAM_WAIT=25;; esac
[ "$STREAM_WAIT" -ge 1 ] && [ "$STREAM_WAIT" -le 55 ] || STREAM_WAIT=25   # the bridge holds a request for 60 s at most
PRESSOUT=/tmp/nexus.press      # the bridge's "ok" to the last press
BEAT=/tmp/nexus.beat           # epoch until which the main loop vouches for itself (its next round + 120 s); see ok in stream_loop
log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }
get() { # get <outfile|-> <path> : wget with a hard timeout. busybox 1.7.2 wget has no -T, and a bridge that
  # vanishes mid-request (container recreate) leaves a half-open socket that would otherwise block forever.
  ( timeout -t $T wget -q -O "$1" "$URL$2"; r=$?; exit $r ) 2>/dev/null   # r=$? keeps ash from exec-ing wget (else "Terminated" leaks to the log)
}
ok() { date +%s > $STAMP; }
nexus_wgets() { # every wget (and its timeout) of this client that is still talking to the bridge: stop must not leave one behind
  # Only a process that IS a wget or timeout (first word, or the script a shell runs), never a shell that merely quotes one.
  for p in /proc/[0-9]*; do
    c=$( { tr '\0' ' ' < $p/cmdline; } 2>/dev/null )
    case "$c" in *" $URL/"*) ;; *) continue;; esac
    a=${c%% *}; b=${c#* }; b=${b%% *}
    case "${a##*/} ${b##*/}" in wget\ *|timeout\ *|*\ wget|*\ timeout) echo ${p#/proc/};; esac
  done
}
nexus_pids() { # every shell running "nexus.sh run": main loop, its reader subshells AND their while-loop grandchildren
  for p in /proc/[0-9]*; do case "$( { tr '\0' ' ' < $p/cmdline; } 2>/dev/null )" in *"nexus.sh run ") echo ${p#/proc/};; esac; done   # anchored: never match some other shell quoting it
}
set_governor() { # set_governor <name> : only when the kernel offers it (ondemand idles at 160 MHz, ~11 mA less than performance)
  [ -n "$1" ] && [ -f $GOV/scaling_available_governors ] || return 0
  case " $(cat $GOV/scaling_available_governors) " in *" $1 "*) echo $1 > $GOV/scaling_governor 2>/dev/null && log "cpu governor $1";; *) log "cpu governor $1 not available";; esac
}

COUNT=/tmp/nexus.count
FAILS=0
draw() { # draw <md5> [full] : $SHOT.tmp onto the panel. Full (flashing) when asked, when the bridge hints it, or every FULL_REFRESH_EVERY frames
  n=$(( $(cat $COUNT 2>/dev/null || echo 0) + 1 ))
  hint=$(get - /hint)
  every=${FULL_REFRESH_EVERY:-0}
  if [ "$2" = "full" ] || [ "$hint" = "full" ] || { [ "$every" -gt 0 ] && [ $n -ge "$every" ]; }; then flag="-f"; n=0; else flag=""; fi
  echo $n > $COUNT
  touch $DRAWING
  mv $SHOT.tmp $SHOT && eips $flag -g $SHOT && echo "$1" > $LAST; r=$?
  if [ $r = 0 ] && [ -n "$flag" ]; then echo "$1" > $FULLTAG; else rm -f $FULLTAG; fi
  rm -f $DRAWING
  return $r
}
fetch() { # fetch <path> [full] ; draws if we got a non-empty file that differs from the last frame; an empty 200 = unchanged (ETag matched)
  rm -f $SHOT.tmp
  if get $SHOT.tmp "$1"; then
    ok
    [ $FAILS -gt 0 ] && { FAILS=0; rm -f $LAST; }   # recovered: next fetch without ?etag= -> full frame, redraw wipes the "bridge unreachable" line
    [ -s $SHOT.tmp ] || { rm -f $SHOT.tmp; return 0; }
    sum=$(md5sum $SHOT.tmp | cut -c1-32)
    [ "$sum" != "$(cat $LAST 2>/dev/null)" ] && draw "$sum" "$2"
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
# The radio only goes off while the screensaver shows, so right before it does we download the frame on the panel
# with a Wi-Fi badge composited in the middle (fetch_badge, bridge /screen.png?connecting=1&of=<etag>, once per frame
# ETag). On a key, show_connecting draws it with a PARTIAL update (`eips -g` without -f): the picture equals the
# panel except the badge square, so to the eye only the badge appears, no flash. This Kindle 4's eips (firmware
# 4.1.4) cannot overlay an image any other way (`-g` always redraws the whole screen, alpha comes out blank, -x/-y draw
# nothing). Without a badge file for the frame on the panel (download failed, frame changed) it falls back to the
# text label `Connecting...` with `eips <col> <row> "text"`, which touches only the text's own cells (12x20 px each,
# 50x40 grid); CONNECTING_COL/CONNECTING_ROW (kindle/config) move it. The full redraw after the reconnect replaces both.
fetch_badge() { # the badge variant of the frame on the panel into $CONN; 1 = none (the text label will be used)
  e=$(etag)
  [ -n "$e" ] || return 1
  [ -s $CONN ] && [ "$(cat $CONNTAG 2>/dev/null)" = "$e" ] && return 0   # same frame as last time: nothing to fetch
  rm -f $CONN $CONNTAG $CONN.tmp
  if get $CONN.tmp "/screen.png?connecting=1&of=$e" && [ -s $CONN.tmp ]; then
    mv $CONN.tmp $CONN && echo "$e" > $CONNTAG && return 0
  fi
  rm -f $CONN.tmp
  log "no connecting badge for this frame, the text label will be used"
  return 1
}
show_connecting() { # show_connecting <etag of the frame on the panel>
  if [ -n "$1" ] && [ -s $CONN ] && [ "$(cat $CONNTAG 2>/dev/null)" = "$1" ]; then
    touch $DRAWING
    eips -g $CONN 2>/dev/null; r=$?   # partial: no -f
    rm -f $DRAWING
    [ $r = 0 ] && return 0
  fi
  eips ${CONNECTING_COL:-18} ${CONNECTING_ROW:-20} "Connecting..." 2>/dev/null
}
radio_up() { # radio_up <why> : bring the radio back and wait (bounded) for the association; always returns 0
  [ -f $RADIOOFF ] || return 0
  rm -f $RADIOOFF
  shown=$(etag)   # the frame on the panel, before $LAST goes
  rm -f $LAST; RECONNECTED=1   # force a full redraw after every reconnect: never leave a ghosted frame
  t0=$(date +%s)
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  [ "$1" = "key" ] && show_connecting "$shown"   # someone is waiting: show it while the radio associates
  i=0
  while [ $i -lt $WIFI_WAIT ]; do
    [ "$(radio_state)" = "CONNECTED" ] && break
    sleep 1; i=$(( i + 1 ))
    [ $i -eq 10 ] && lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null   # one more kick halfway
  done
  if [ "$(radio_state)" != "CONNECTED" ]; then
    # 2026-11-09: after a window the radio came back as cmState "NA" and stayed so for 15 h (ar6003 reloaded, wifid
    # never associated); only a reboot cleared it. One power cycle of the radio is the cheap first attempt.
    log "radio still $(radio_state) after ${i}s ($1): power-cycling the radio once"
    lipc-set-prop com.lab126.cmd wirelessEnable 0 2>/dev/null
    sleep 3
    lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
    j=0
    while [ $j -lt $WIFI_WAIT ]; do
      [ "$(radio_state)" = "CONNECTED" ] && break
      sleep 1; j=$(( j + 1 ))
    done
    i=$(( i + 3 + j ))
  fi
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
  [ "$STREAM" = "1" ] && echo $(( $(date +%s) + $1 + 120 )) > $BEAT
  ( sleep "$1"; echo "0 0 poll $GEN 0" > $FIFO ) &
  TIMER=$!
}

show() { # show [full] : the update while awake. STREAM=1: the picture loop does it, only make sure it runs
  if [ "$STREAM" = "1" ]; then stream_start $1; else fetch "/screen.png?fresh=1&etag=$(etag)" $1; fi
}
cycle() { # one scheduled update: radio up if needed, battery + frame, then decide the next window
  woke=; [ -f $RADIOOFF ] && woke=1   # the timed wake at the end of a radio-off window (a key would have ended the window before)
  radio_up poll
  FF=; [ "$RECONNECTED" = "1" ] && { FF=full; RECONNECTED=; DROP_BEFORE=$(date +%s); }   # first frame after a reconnect: full refresh; STREAM=1: presses made while it connected are dropped
  report_battery
  sched=$(get - "/schedule?default=$POLL_SECONDS")
  set -- $sched   # "<poll s> <doze|awake> <next update epoch> <window s> <night 0|1> <HH:MM local>"
  s=$1; verdict=$2; secs=$4; label=$6
  case "$s" in ''|*[!0-9]*) s=$POLL_SECONDS;; esac
  [ "$s" -ge 1 ] && [ "$s" -le 600 ] || s=$POLL_SECONDS
  [ "$STREAM" = "1" ] && [ "$s" -lt "${POLL_SECONDS:-20}" ] && s=${POLL_SECONDS:-20}   # pictures come by themselves: no need to ask faster
  if [ -n "$DOZE_OVERRIDE" ] && [ "$verdict" = "doze" ] && [ $OVERRIDE_LEFT -gt 0 ]; then   # rollout test: a few short windows, then the real schedule
    OVERRIDE_LEFT=$(( OVERRIDE_LEFT - 1 )); secs=$DOZE_OVERRIDE; label="test+${secs}s ($OVERRIDE_LEFT left)"
  fi
  if [ "$verdict" != "doze" ]; then
    [ -n "$sched" ] || log "no schedule from the bridge, polling every ${s}s"
    show $FF
    arm $s
    return
  fi
  r=$(duty_blocked)
  if [ -n "$r" ]; then
    [ "$r" != "$BLOCKED" ] && log "radio stays on: $r"; BLOCKED=$r
    show $FF
    arm $s
    return
  fi
  BLOCKED=
  case "$secs" in ''|*[!0-9]*) log "bad schedule: $sched"; show $FF; arm $s; return;; esac
  if [ "$secs" -lt $MIN_DOZE ] || [ "$secs" -gt $MAX_DOZE ]; then
    log "window out of range: $sched"
    show $FF; arm $s; return
  fi
  # Every frame of the low-power path is a FULL flashing refresh of a freshly fetched frame: partial
  # updates ghost on this panel and a half-finished one would stay on the screen for the whole window
  # (the owner's photo 2026-10-15: washed out, torn, ghosted). Then settle + sync before anything else.
  stream_stop   # STREAM=1: from here on only this loop draws (the last frame, later the connecting badge)
  # STREAM=1: the picture loop may have put this very frame on the panel already, complete and with a full refresh
  # (the screensaver photo arrives by itself). Then a second flash of the same picture adds nothing: only ask whether
  # it is still the current one. Anything else (a partial draw, a draw cut short, a failed fetch, a reconnect) keeps
  # the rule: fetch again and draw in full.
  # THE SCREENSAVER PHOTO changes only when somebody asks the bridge for the next one, so the panel and the server
  # never show different photos while the radio is off. This is where the panel asks: a timed wake that goes straight
  # into the next window (next=1). One request, one full draw, no picture loop in between. Not at the first window
  # after the screensaver started: that photo is new.
  have=$(etag)
  if [ "$STREAM" = "1" ] && [ ! -f $DRAWING ] && [ $FAILS = 0 ] && [ -n "$have" ] && [ "$(cat $FULLTAG 2>/dev/null)" = "$have" ]; then
    fetch "/screen.png?fresh=1&etag=$have" full
  else
    [ -f $DRAWING ] && { log "previous draw was cut short, redrawing in full"; rm -f $DRAWING; }
    rm -f $LAST
    nx=; [ -n "$woke" ] && nx="&next=1"
    fetch "/screen.png?fresh=1$nx" full
  fi
  sleep $EINK_SETTLE
  sync
  if [ -n "$(duty_blocked)" ]; then stream_resume; arm $s; return; fi   # a button arrived while we drew
  fetch_badge   # what a key shows while the radio is off (one download per frame ETag)
  if [ -n "$(duty_blocked)" ]; then stream_resume; arm $s; return; fi
  if radio_down $secs "$label"; then arm $secs; else stream_resume; arm $s; fi
}

# ---- two channels (STREAM=1) ----
# Presses and pictures do not wait for each other.
# PRESSES: each one is its own very short request (bridge /press/<name>, answer "ok" = received). It may take
# PRESS_LIMIT_MS; after that the wget is killed and the press is DROPPED, never sent again: a key must not act late.
# The main loop sends one at a time, so they arrive in the order they were pressed. A press that had to wait 2 s or
# more for its turn (the loop was busy) is dropped too.
# RADIO OFF: a press then only brings the radio back (with the connecting badge) and is dropped, like every press made
# until the connection is up. Once it is, the bridge gets ONE /wake, which leaves the screensaver and can do nothing else.
# The one exception (owner 2026-11-23) is F1 / F4: those two judge the photo on the panel and never leave the
# screensaver. Such a press is SENT once the connection is up, once, with ?saver=1 (the bridge then presses it only
# while its page shows the screensaver with the photo it last sent here), and no /wake follows. The picture loop then
# brings the result, the next photo, as its first full draw.
# PICTURES: the picture loop (a child of the main loop) keeps one request open (bridge /stream.png?have=<the frame on
# the panel>). The bridge answers the moment it has a newer frame; the loop draws it and asks again. No newer frame
# within STREAM_WAIT seconds is an empty answer and still a success. The request is cut off 5 s after that at the
# latest (a dead or half-open connection never answers; this wget has no timeout of its own). After a failure the
# loop waits 1, 2, 4, 8, 10, 10 … s between tries and then starts again with a full redraw.
# ONE DRAWER: the picture loop draws only while the radio is up; the main loop stops it (and waits until it is gone)
# before it draws the last frame of a radio-off window, and so before any connecting badge.
SPID=          # the picture loop
PW=            # the wget of the press in flight
DROP_BEFORE=0  # epoch: presses made up to then are dropped (they were made while the radio connected)
tiny() { # tiny <path> [limit ms] : one short request whose answer is "ok". 0 = the bridge has it. Cut off at the limit, never retried.
  rm -f $PRESSOUT
  wget -q -O $PRESSOUT "$URL$1" 2>/dev/null &
  PW=$!
  ( usleep ${2:-$PRESS_LIMIT_MS}000; kill $PW 2>/dev/null ) &
  pk=$!
  wait $PW 2>/dev/null; r=$?
  kill $pk 2>/dev/null; wait $pk 2>/dev/null
  PW=
  [ $r = 0 ] && [ -s $PRESSOUT ]
}
stream_loop() { # stream_loop [full] : the picture channel; runs until it is told to stop (TERM)
  W=
  # No signal handler here, on purpose. The Kindle's shell (busybox 1.7.2) does not run a trap that a background
  # function sets: TERM only ended the request in flight and the loop lived on, so the main loop waited for it for
  # ever (seen on the device 2026-11-23, the cron watchdog had to restart the client). Without a handler TERM ends
  # this shell at once; stream_stop lets a draw finish first and cleans up the request.
  sfull=$1; sfails=0
  [ -f $DRAWING ] && { rm -f $DRAWING $LAST; sfull=full; }   # a draw that was cut short is redone in full
  while :; do
    rm -f $SHOT.tmp
    have=$(etag)
    # Nothing on the panel we could name: the bridge answers at once with a fresh frame, the usual timeout is enough.
    if [ -n "$have" ]; then lim=$(( STREAM_WAIT + 5 )); else lim=$T; fi
    timeout -t $lim wget -q -O $SHOT.tmp "$URL/stream.png?have=$have&wait=${STREAM_WAIT}000" 2>/dev/null &
    W=$!
    wait $W 2>/dev/null; r=$?
    if [ $r = 0 ] && [ -s $SHOT.tmp ]; then
      sum=$(md5sum $SHOT.tmp | cut -c1-32)
      [ "$sum" = "$have" ] || draw "$sum" $sfull; r=$?
    fi
    rm -f $SHOT.tmp
    if [ $r = 0 ]; then
      # A hold that ended without a newer frame is a success too. The stamp says "the client works", so it is written
      # only while the main loop keeps its own rounds as well (cron.sh restarts the client when the stamp goes stale).
      beat=$(cat $BEAT 2>/dev/null)
      [ "${beat:-0}" -gt "$(date +%s)" ] 2>/dev/null && ok
      [ $sfails -gt 0 ] && log "pictures are back after $sfails failed tries"
      sfails=0; sfull=
      continue
    fi
    sfails=$(( sfails + 1 ))
    [ $sfails = 1 ] && log "picture request failed, trying again with a pause in between"   # once, not per try
    [ $sfails = ${FAIL_HINT_AFTER:-3} ] && eips 0 39 "bridge unreachable $(date +%H:%M)" 2>/dev/null
    rm -f $LAST; sfull=full   # when it is back: everything again, with a full redraw
    case $sfails in 1) b=1;; 2) b=2;; 3) b=4;; 4) b=8;; *) b=10;; esac
    sleep $b &
    W=$!
    wait $W 2>/dev/null
  done
}
stream_alive() { [ -n "$SPID" ] && kill -0 $SPID 2>/dev/null; }
stream_start() { # stream_start [full] : start the picture loop unless it runs
  stream_alive && return 0
  stream_loop $1 &
  SPID=$!
  echo "$R0 $R1 $SPID" > $KIDS
}
stream_stop() { # stop the picture loop and wait until it is gone: after this nothing else draws
  [ -n "$SPID" ] || return 0
  i=0; while [ -f $DRAWING ] && [ $i -lt 50 ]; do usleep 100000; i=$(( i + 1 )); done   # a draw in progress is finished first
  kill $SPID 2>/dev/null
  usleep 100000
  kill -9 $SPID 2>/dev/null   # never wait for a loop that did not go
  wait $SPID 2>/dev/null
  SPID=
  pids=$(nexus_wgets); [ -n "$pids" ] && kill $pids 2>/dev/null   # the request the loop held open
  i=0; while [ -n "$(pidof eips 2>/dev/null)" ] && [ $i -lt 30 ]; do usleep 100000; i=$(( i + 1 )); done   # a draw it had just begun
}
stream_resume() { [ "$STREAM" = "1" ] && stream_start full; }   # after the main loop drew: back to the picture loop
stream_gate() { # stream_gate <event sec> <key name> : 0 = send this press; 1 = it is dropped (too old, or used up to wake the radio)
  now=$(date +%s); age=$(( now - $1 ))
  if [ $1 -le $DROP_BEFORE ]; then log "key $2 dropped: pressed while the radio connected"; return 1; fi
  # 86400: event times that are not wall-clock times cannot be compared; then this rule is off
  if [ $age -ge 2 ] && [ $age -lt 86400 ]; then log "key $2 dropped: pressed ${age}s ago"; return 1; fi
  [ -f $RADIOOFF ] || return 0
  case $2 in f1|f4) log "radio is off: key $2 is a photo key, it is sent once the radio is up";; *) log "radio is off: key $2 only wakes the panel";; esac
  radio_up key
  RECONNECTED=
  DROP_BEFORE=$(date +%s)
  if [ "$(radio_state)" = "CONNECTED" ]; then
    case $2 in
      # F1 / F4 judge the photo on the panel and never leave the screensaver: sent once, late as it is, and no /wake.
      # Not when the last picture of the window did not arrive: the panel may then show a photo the server left behind.
      f1|f4)
        if [ $FAILS = 0 ] && [ ! -f $DRAWING ]; then tiny "/press/$2?saver=1" 1000 || log "key $2 not delivered, dropped"
        else log "key $2 dropped: the last picture did not arrive, the screensaver stays"; fi;;
      *) tiny /wake 1000 || log "wake message not delivered";;   # harmless when late: it can only leave the screensaver
    esac
  fi
  arm ${POLL_SECONDS:-20}
  stream_start full
  return 1
}
stream_key() { # stream_key <name> : hand the press over; the picture follows on its own channel
  tiny "/press/$1" || log "key $1 not delivered, dropped"
}

# ---- keys ----
send_key() { # send_key <name> : radio up if needed, press the key at the bridge, draw the answer
  if [ "$STREAM" = "1" ]; then stream_key $1; return; fi
  radio_up key   # a press while the radio is down: back up (~6 s) and the frame is redrawn in full
  if [ "$RECONNECTED" = "1" ]; then
    RECONNECTED=; fetch "/key/$1" full
  else
    case $1 in prev|next) fetch "/key/$1?etag=$(etag)" full;; *) fetch "/key/$1?etag=$(etag)";; esac
  fi
  arm ${POLL_SECONDS:-20}   # the panel is in use: back to the short cadence (and re-ask /schedule)
}

# Long press of the 5-way centre. With LONG_PRESS > 0 the centre acts on RELEASE: "select" for a short
# press, "select-long" when it was held for LONG_PRESS seconds, sent as soon as the time is up (a
# one-shot timer line, like the poll timer), not only when the thumb lifts. The length of a press is
# taken from the kernel's event times, so a slow reader does not stretch it.
# Self-checking: it only switches on once this run has seen a key RELEASE event (value 0) from the
# hardware. A keypad that reports presses only keeps the old act-on-key-down behaviour.
RELEASES=      # 1 = this run has seen a release event
SEL=           # 1 = centre is down and not yet acted on
SEL_S=0; SEL_U=0   # kernel time of that key-down
SELGEN=0; HOLDT=
sel_down() { # sel_down <sec> <usec>
  SEL=1; SEL_S=$1; SEL_U=$2
  SELGEN=$(( SELGEN + 1 ))
  ( sleep $LONG_PRESS; echo "0 0 hold $SELGEN 0" > $FIFO ) &
  HOLDT=$!
  [ "$STREAM" = "1" ] || radio_up key   # start the radio (and the "Connecting..." badge) while the thumb is still down
}
sel_done() { # sel_done <key name> <note> : the pending press is decided
  SEL=
  [ -n "$HOLDT" ] && kill $HOLDT 2>/dev/null; HOLDT=
  if [ "$STREAM" = "1" ]; then   # decided LONG_PRESS s after the key went down at the latest; later than that it is too old
    age=$(( $(date +%s) - SEL_S ))
    if [ $age -ge $(( LONG_PRESS + 2 )) ] && [ $age -lt 86400 ]; then log "key 194 dropped: pressed ${age}s ago"; return 0; fi
  fi
  log "key 194 -> $1 ($2)"
  send_key $1
}
sel_up() { # sel_up <sec> <usec> : the centre was released
  ms=$(( ($1 - SEL_S) * 1000 + ($2 - SEL_U) / 1000 ))
  if [ $ms -ge $(( LONG_PRESS * 1000 )) ]; then sel_done select-long "held ${ms}ms"; else sel_done select "${ms}ms"; fi
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

handle_event() { # handle_event <sec> <usec> <type> <code> <value> : one line from the FIFO (an input event or a timer line)
  sec=$1; usec=$2; type=$3; code=$4; value=$5
  if [ "$type" = "poll" ]; then
    [ "$code" = "$GEN" ] || return 0   # a timer we superseded (a key press cut its window short)
    cycle
    return 0
  fi
  if [ "$type" = "hold" ]; then   # the centre has been down for LONG_PRESS seconds
    [ "$SEL" = "1" ] && [ "$code" = "$SELGEN" ] && sel_done select-long "still held after ${LONG_PRESS}s"
    return 0
  fi
  [ "$type" = "1" ] || return 0
  if [ "$value" = "0" ]; then   # a key release
    [ -n "$RELEASES" ] || { RELEASES=1; [ $LONG_PRESS -gt 0 ] && log "key releases seen: long press on (${LONG_PRESS}s)"; }
    [ "$code" = "194" ] && [ "$SEL" = "1" ] && sel_up $sec $usec
    return 0
  fi
  [ "$value" = "1" ] || return 0   # 2 = auto-repeat
  k=$(keyname $code)
  [ -n "$k" ] || return 0
  if [ "$STREAM" = "1" ]; then stream_gate $sec $k || return 0; fi   # dropped: too old, or it only woke the radio
  [ "$SEL" = "1" ] && sel_done select "no release before the next key"   # never lose a press
  if [ "$k" = "select" ] && [ $LONG_PRESS -gt 0 ] && [ -n "$RELEASES" ]; then
    sel_down $sec $usec
    return 0
  fi
  log "key $code -> $k"
  send_key $k
}

run() {
  log "starting, bridge=$BRIDGE_URL radio_duty=$RADIO_DUTY stream=$STREAM"
  if [ "$STOP_FRAMEWORK" = "1" ]; then
    log "stopping framework"; /etc/init.d/framework stop >> $LOG 2>&1
  fi
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
  set_governor "${CPU_GOVERNOR-ondemand}"
  radio_force_on
  eips -c
  rm -f $FIFO $LAST $RADIOOFF $WINDOW $DRAWING $CONN $CONNTAG; mkfifo $FIFO
  ok   # the watchdog's stale clock starts now, not at an unknown time in the past
  reader /dev/input/event0 0 > $FIFO &
  R0=$!
  reader /dev/input/event1 1 > $FIFO &
  R1=$!
  echo "$R0 $R1" > $KIDS
  trap 'kill $R0 $R1 $TIMER $HOLDT $SPID $PW 2>/dev/null; killall dd 2>/dev/null; exit 0' TERM INT
  fetch /reload full || fetch /screen.png full
  arm ${POLL_SECONDS:-20}
  [ "$STREAM" = "1" ] && stream_start
  while read sec usec type code value; do handle_event "$sec" "$usec" "$type" "$code" "$value"; done < $FIFO
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
    pids=$(nexus_wgets); [ -n "$pids" ] && kill $pids 2>/dev/null   # a request still in flight (the held-open picture request)
    rm -f $RADIOOFF
    radio_force_on   # never leave the device offline behind us
    rm -f $PID $KIDS $STAMP $WINDOW $KEYSTAMP $BATSTAMP $DRAWING $FULLTAG $BEAT $PRESSOUT
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
    echo "stream=$STREAM"
    echo "radio_duty=$RADIO_DUTY$([ -f $DIR/NORADIO ] && echo ' (NORADIO file)')$([ -f $DIR/NOSLEEP ] && echo ' (NOSLEEP file)') wifi=$(radio_state) governor=$(cat $GOV/scaling_governor 2>/dev/null)"
    tail -5 $LOG 2>/dev/null;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1;;
esac
