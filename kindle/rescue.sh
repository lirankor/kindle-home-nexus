#!/bin/sh
# Rescue guard for the Kindle panel. Runs every minute from its OWN line in /etc/crontab/root, shares no code
# with nexus.sh or cron.sh, and has to keep working when those two are broken. In normal operation it reads a
# few files and one lipc value and changes nothing. Stock busybox 1.7.2 /bin/sh. Procedure: kindle/RESCUE.md.
#
# 1. Trial with a dead-man switch. good/ holds the last known-good nexus.sh, cron.sh and config. TRIAL holds
#    "<deadline epoch> <minutes>". While the deadline is ahead: one log line per run, nothing else. Deadline
#    passed, TRIAL unreadable, the clock moved, /tmp nearly full during the trial, or a file ROLLBACK exists:
#    roll back = kill the panel scripts, restore the three files from good/, hold the radio on, start the panel.
# 2. Radio hold. NORADIO is the panel's own "keep the radio on" switch. Ours contains "rescue <expiry epoch>"
#    and is removed here when it expires, so a forgotten hold cannot drain the battery. A NORADIO made by hand
#    (any other content) is never touched.
# 3. Connection watchdog. Wi-Fi not CONNECTED outside a radio-off window of a live client: switch the radio on
#    again, then power-cycle it, then again, last resort reboot (never within 6 h of a boot or of cron.sh's
#    reboot). It never asks the server anything: connected Wi-Fi with a silent server is not the radio's fault.
#
# Switch files in $DIR: NONET = no connection watchdog, NOREBOOT = it never reboots, WIFID_RESTART = step 3 also
# restarts wifid (not tested on the device yet), RESCUE_DEBUG = one log line per run.
# RESCUE_* variables: test harness (kindle/tests/rescue-test.sh) and dry runs (RESCUE_DRY=1 changes nothing).
PATH=$PATH:/usr/sbin:/sbin:/usr/bin:/bin; export PATH
DIR=${RESCUE_DIR:-/mnt/us/nexus}
TMP=${RESCUE_TMP:-/tmp}
GOOD=$DIR/good; LOG=$DIR/rescue.log; NET=$DIR/rescue.net; LOCK=$TMP/rescue.lock
REBOOT_STAMP=$TMP/nexus.wd_reboot   # cron.sh's "last watchdog reboot" stamp, shared so the two never reboot in a row
DRY=$RESCUE_DRY
HOLD_SECS=3600; HOLD_MAX=14400      # radio hold after a rollback; no hold of ours may ever reach further than HOLD_MAX
TRIAL_MAX_MIN=720; TMP_MIN_KB=${RESCUE_TMP_MIN_KB:-1024}
NET_ON=120; NET_CYCLE=300; NET_CYCLE2=900; NET_REBOOT=2700; REBOOT_GUARD=21600
MAX_WINDOW=7800; WAKE_GRACE=120     # the same limits cron.sh applies to the client's radio-off window stamp
[ -n "$RESCUE_VERBOSE" ] || exec >/dev/null 2>&1

num() { # num <text> [default] : the text when it is a plain number arithmetic can take, else the default
  case "$1" in ''|*[!0-9]*|0?*|???????????*) echo ${2:-0};; *) echo $1;; esac
}
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> $LOG; }
note() { log "$*"; echo "$(date '+%H:%M:%S') rescue: $*" >> $DIR/nexus.log; }   # also into the panel's own log
lget() { ( timeout -t 10 lipc-get-prop "$@"; r=$?; exit $r ) 2>/dev/null; }     # a stuck lipc must not hang us
lset() {
  [ -n "$DRY" ] && { log "dry run, not done: lipc-set-prop $*"; return 0; }
  ( timeout -t 10 lipc-set-prop "$@"; r=$?; exit $r ) 2>/dev/null
}
radio_on() { lset com.lab126.cmd wirelessEnable 1; }
radio_cycle() { lset com.lab126.cmd wirelessEnable 0; sleep 5; radio_on; }
tmp_free() { # free KB in $TMP
  set -- $(df -k $TMP 2>/dev/null | tail -n 1)
  while [ $# -gt 3 ]; do shift; done
  num "$1" 999999
}

now=$(date +%s); up=$(num "$(cut -d. -f1 ${RESCUE_UPTIME:-/proc/uptime} 2>/dev/null)" 99999)
[ $up -lt 90 ] && exit 0   # still booting

# ---- one run at a time; a lock left behind by a killed run is taken over after 5 minutes ----
if ! mkdir $LOCK 2>/dev/null; then
  t=$(cat $LOCK/t 2>/dev/null); [ -n "$t" ] || { sleep 2; t=$(cat $LOCK/t 2>/dev/null); }
  age=$(( now - $(num "$t") ))
  [ $age -ge 0 ] && [ $age -lt 300 ] && exit 0
fi
echo $now > $LOCK/t
trap 'rm -rf $LOCK' 0

n=$(wc -l < $LOG 2>/dev/null); [ ${n:-0} -gt 400 ] && tail -n 200 $LOG > $LOG.tmp && mv $LOG.tmp $LOG   # cap our log

# A reboot empties /tmp and with it cron.sh's reboot stamp. Put the boot time there: no watchdog reboot, cron.sh's
# or ours, within REBOOT_GUARD of any boot.
[ $up -lt $REBOOT_GUARD ] && [ ! -f $REBOOT_STAMP ] && [ -z "$DRY" ] && echo $(( now - up )) > $REBOOT_STAMP

# ---- radio hold ----
SAY=idle; HELD=; MANUAL=
if [ -f $DIR/NORADIO ]; then
  set -- $(cat $DIR/NORADIO 2>/dev/null) x x
  if [ "$1" != rescue ]; then MANUAL=1; SAY="NORADIO set by hand"
  else
    left=$(( $(num "$2") - now ))
    if [ $left -le 0 ] || [ $left -gt $HOLD_MAX ]; then
      rm -f $DIR/NORADIO; note "radio hold over: NORADIO removed, battery saver back to normal"
    else
      HELD=1; SAY="radio hold ${left}s left"
      [ "$(lget com.lab126.cmd wirelessEnable)" = 0 ] && { note "radio hold: the radio was off, switching it on"; radio_on; }
    fi
  fi
fi
hold() { # radio on now, and the panel script may not switch it off for HOLD_SECS
  [ -n "$MANUAL" ] || echo "rescue $(( now + HOLD_SECS ))" > $DIR/NORADIO
  radio_on
}

# ---- trial / rollback ----
good_ok() { # the snapshot is complete, unchanged since it was taken, and both scripts parse
  [ -s $GOOD/nexus.sh ] && [ -s $GOOD/cron.sh ] && [ -s $GOOD/config ] && [ -s $GOOD/md5 ] || return 1
  [ "$(cd $GOOD && md5sum nexus.sh cron.sh config 2>/dev/null)" = "$(cat $GOOD/md5)" ] || return 1
  sh -n $GOOD/nexus.sh && sh -n $GOOD/cron.sh
}
panel_pids() { # every shell that runs the panel client (whatever its argument) or its watchdog
  for p in /proc/[0-9]*; do
    set -f; set -- $( { tr '\0' ' ' < $p/cmdline; } 2>/dev/null ) x x x; set +f
    [ "$2" = sh ] && shift   # started as "<path>/busybox sh nexus.sh ..."
    case "$1" in sh|*/sh) ;; *) continue;; esac
    case "$2" in ${RESCUE_MATCH:-nexus.sh}|${RESCUE_MATCH:-*/}nexus.sh|${RESCUE_MATCH:-*/nexus/}cron.sh) echo ${p#/proc/};; esac
  done
}
rollback() { # rollback <why>
  why=$1
  [ -n "$DRY" ] && { log "dry run, not done: rollback ($why)"; return; }
  if ! good_ok; then   # nothing trustworthy to restore: leave the current files alone, only make sure we can get in
    [ -n "$HELD" ] || note "$why, but good/ is missing or damaged: nothing restored, radio held on"
    hold; SAY="no usable good/, radio held on"; return
  fi
  note "ROLLBACK ($why): stopping the panel scripts"
  pids=$(panel_pids); [ -n "$pids" ] && kill $pids
  i=0; while [ -n "$(panel_pids)" ] && [ $i -lt 5 ]; do sleep 1; i=$(( i + 1 )); done
  pids=$(panel_pids); [ -n "$pids" ] && kill -9 $pids
  ${RESCUE_KILLALL:-killall} dd wget   # the client's key readers and requests still in flight
  mkdir -p $DIR/failed; cp $DIR/nexus.sh $DIR/cron.sh $DIR/config $DIR/failed/   # what was running, for the post-mortem
  res=ok
  for f in nexus.sh cron.sh config; do cp $GOOD/$f $DIR/$f; cmp -s $GOOD/$f $DIR/$f || res="FAILED for $f"; done
  rm -f $DIR/TRIAL $DIR/ROLLBACK $DIR/nexus.pid $TMP/nexus.radio_off $TMP/nexus.window
  if [ $(tmp_free) -lt $TMP_MIN_KB ]; then   # the failed script may have filled /tmp: drop its files, keep the watchdog stamps
    for f in $TMP/nexus.*; do case $f in *.wd_reboot|*.wd_restart) ;; *) rm -rf $f;; esac; done
  fi
  hold
  if [ -f $DIR/DISABLED ]; then started="not started (DISABLED)"
  else /bin/sh $DIR/nexus.sh start; started="started"; fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $why; restore $res; panel script $started" > $DIR/ROLLED_BACK
  note "ROLLBACK done: restore $res, panel script $started, radio held on for $(( HOLD_SECS / 60 )) min"
  SAY="rolled back ($why)"
}
why=
if [ -f $DIR/ROLLBACK ]; then why="ROLLBACK file"
elif [ -f $DIR/TRIAL ]; then
  set -- $(cat $DIR/TRIAL 2>/dev/null) x x
  dl=$(num "$1"); mins=$(num "$2"); left=$(( dl - now ))
  if [ $mins -lt 1 ] || [ $mins -gt $TRIAL_MAX_MIN ] || [ $dl -eq 0 ]; then why="TRIAL file unreadable"
  elif [ $left -le 0 ]; then why="trial deadline passed, nobody confirmed"
  elif [ $left -gt $(( mins * 60 + 120 )) ]; then why="trial deadline further away than the trial is long, the clock moved"
  elif [ $(tmp_free) -lt $TMP_MIN_KB ]; then why="/tmp nearly full during the trial"
  else SAY="trial running, ${left}s left"; log "$SAY"; fi
fi
[ -n "$why" ] && rollback "$why"

# ---- connection watchdog ----
in_window() { # the client's own radio-off window: both stamps there, still running, sane length, client alive
  [ -f $TMP/nexus.radio_off ] || return 1
  set -- $(cat $TMP/nexus.window 2>/dev/null) x x
  end=$(num "$1"); win=$(num "$2")
  [ $end -gt 0 ] && [ $win -gt 0 ] && [ $win -le $MAX_WINDOW ] || return 1
  [ $now -lt $(( end + WAKE_GRACE )) ] && [ $(( end - now )) -le $MAX_WINDOW ] || return 1   # a stale stamp stops counting
  kill -0 "$(cat $DIR/nexus.pid 2>/dev/null)" 2>/dev/null
}
reboot_ok() { # switched off by the owner? booted, or rebooted by cron.sh, less than REBOOT_GUARD ago?
  [ -f $DIR/NOREBOOT ] && return 1
  grep '^WIFI_DEAD_REBOOT=0' $DIR/config 2>/dev/null | grep -v '=0[0-9]' | grep -q . && return 1   # cron.sh's switch counts here too
  [ $up -ge $REBOOT_GUARD ] && [ $(( now - $(num "$(cat $REBOOT_STAMP 2>/dev/null)") )) -ge $REBOOT_GUARD ]
}
net_watch() {
  [ -f $DIR/NONET ] && return
  [ -f $DIR/DISABLED ] && return   # the panel is switched off: the Kindle is a reader again and its Wi-Fi is the owner's business
  [ $up -lt 180 ] && return
  st=$(lget com.lab126.wifid cmState)
  set -- $(cat $NET 2>/dev/null) x x   # "<not connected since> <last step taken>"
  since=$(num "$1"); step=$(num "$2")
  if [ "$st" = CONNECTED ]; then
    [ $step -ge 1 ] && note "net: connected again"
    rm -f $NET; return
  fi
  if [ -z "$HELD" ] && in_window; then rm -f $NET; SAY="$SAY, radio off by the battery saver"; return; fi
  [ $since -gt 0 ] && [ $since -le $now ] && [ $since -ge $(( now - up )) ] || { since=$now; step=0; }   # a new outage (or a stamp from before the boot)
  age=$(( now - since )); msg="net: Wi-Fi '${st:-no answer}' for ${age}s"
  if [ $step -lt 1 ] && [ $age -ge $NET_ON ]; then
    step=1; note "$msg -> step 1, switching the radio on again"; radio_on
  elif [ $step -lt 2 ] && [ $age -ge $NET_CYCLE ]; then
    step=2; note "$msg -> step 2, power-cycling the radio"; radio_cycle
  elif [ $step -lt 3 ] && [ $age -ge $NET_CYCLE2 ]; then
    step=3
    if [ -f $DIR/WIFID_RESTART ] && [ -z "$DRY" ]; then
      note "$msg -> step 3, restarting wifid and power-cycling the radio"
      ( timeout -t 60 ${RESCUE_WIFID:-/etc/init.d/wifid} stop; sleep 3; timeout -t 60 ${RESCUE_WIFID:-/etc/init.d/wifid} start; exit 0 )
    else note "$msg -> step 3, power-cycling the radio once more"; fi
    radio_cycle
  elif [ $step -ge 3 ] && [ $age -ge $NET_REBOOT ] && reboot_ok; then
    step=4; note "$msg, every step tried -> reboot"
    if [ -n "$DRY" ]; then log "dry run, not done: reboot"
    else echo "$since $step" > $NET; echo $now > $REBOOT_STAMP; sync; ${RESCUE_REBOOT:-/sbin/reboot}; fi
  fi
  echo "$since $step" > $NET
  SAY="$SAY, Wi-Fi '${st:-no answer}' for ${age}s (step $step)"
}
net_watch

echo "$now $SAY" > $TMP/rescue.last   # heartbeat: the server tool reads it to see that this guard is alive
[ -f $DIR/RESCUE_DEBUG ] && log "debug: $SAY"
exit 0
