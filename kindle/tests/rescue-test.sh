#!/bin/sh
# Decision-table test for kindle/rescue.sh (the independent rescue guard), in the style of cron-test.sh:
#   dash kindle/tests/rescue-test.sh        (TEST_SH=… picks the shell rescue.sh runs under; default sh)
# A current busybox does not work as TEST_SH: it runs its own timeout applet, which no longer takes "-t <s>".
# Fakes the panel folder, /tmp, the uptime, lipc (PATH stubs that record every call), reboot, wifid and a
# nexus.sh that records "start" and can be left running as a process, then checks what rescue.sh decides.
# It also runs on the Kindle itself (copy rescue.sh and this file to a scratch folder, RESCUE_SH=… points at
# the script): there busybox runs its own applets whatever PATH says, so nothing dangerous is reached through
# PATH. Every device command that changes something (lipc-set-prop, reboot, wifid, killall, the process
# match) is a stub or scoped to the scratch folder, and the test refuses to start when the lipc stub is not
# the one that answers.
HERE=$(cd "$(dirname "$0")" && pwd)
RESCUE=${RESCUE_SH:-$HERE/../rescue.sh}
W=${TMPDIR:-/tmp}/rescue-test.$$; rm -rf $W
D=$W/nexus; T=$W/tmp
mkdir -p $D $T $W/bin || exit 1
/bin/sleep 600 & SLEEPER=$!
trap 'kill $SLEEPER $(cat $W/sleepers 2>/dev/null) 2>/dev/null; rm -rf $W' 0
cat > $W/bin/lipc-get-prop <<STUB
#!/bin/sh
case "\$2" in cmState) cat $W/cmstate 2>/dev/null;; wirelessEnable) cat $W/wen 2>/dev/null;; esac
STUB
printf '#!/bin/sh\necho "set $2 $3" >> %s/calls\n' $W > $W/bin/lipc-set-prop
printf '#!/bin/sh\necho reboot >> %s/calls\n' $W > $W/bin/reboot
printf '#!/bin/sh\necho "wifid $1" >> %s/calls\n' $W > $W/bin/wifid
printf '#!/bin/sh\necho "killall $*" >> %s/calls\n' $W > $W/bin/killall
printf '#!/bin/sh\necho wget >> %s/calls\n' $W > $W/bin/wget
# server only (dash takes these from PATH; the Kindle's busybox uses its own applets, which is what it has anyway)
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\nexit 0\n' > $W/bin/sleep
chmod +x $W/bin/*
export PATH=$W/bin:$PATH RESCUE_DIR=$D RESCUE_TMP=$T RESCUE_UPTIME=$W/uptime RESCUE_MATCH=$D/
export RESCUE_REBOOT=$W/bin/reboot RESCUE_WIFID=$W/bin/wifid RESCUE_KILLALL=$W/bin/killall
lipc-set-prop probe probe 1; [ "$(cat $W/calls 2>/dev/null)" = "set probe 1" ] || { echo "the lipc stub is not first in PATH: refusing to run"; exit 1; }

now() { date +%s; }
panel() { # panel <tag> : a fake nexus.sh ("start" is recorded, "run" stays alive) plus cron.sh and config, marked with <tag>
  printf '#!/bin/sh\n# %s\ncase "$1" in start) echo start >> %s/calls;; run|stream) /bin/sleep 300 & echo $! >> %s/sleepers; wait;; esac\n' "$1" $W $W > $D/nexus.sh
  printf '#!/bin/sh\n# cron %s\n' "$1" > $D/cron.sh
  printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\n# %s\n' "$1" > $D/config
}
snapshot() { mkdir -p $D/good; cp $D/nexus.sh $D/cron.sh $D/config $D/good/; ( cd $D/good && md5sum nexus.sh cron.sh config > md5 ); }
reset() { # a healthy panel: good/ = the running files, Wi-Fi connected, radio on, client alive, up for 10 h
  rm -rf $D $T $W/calls $W/cmstate $W/wen $W/uptime; mkdir -p $D $T
  panel good; snapshot
  echo CONNECTED > $W/cmstate; echo 1 > $W/wen; echo "36000.00 1.00" > $W/uptime
  echo $SLEEPER > $D/nexus.pid; unset RESCUE_DRY RESCUE_TMP_MIN_KB
}
trial() { echo "$(( $(now) + $1 )) $2" > $D/TRIAL; }                  # trial <deadline in s from now> <minutes>
window() { echo "$(( $(now) + $1 ))" > $T/nexus.radio_off; echo "$(( $(now) + $1 )) $2" > $T/nexus.window; }   # window <ends in s> <length>
net() { echo "$(( $(now) - $1 )) $2" > $D/rescue.net; }               # net <not connected for s> <step already taken>
down() { echo "${1-NA}" > $W/cmstate; }
rc=0
run() { ${TEST_SH:-sh} $RESCUE; rc=$?; }
calls() { cat $W/calls 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
fail=0; cases=0
ok() { cases=$(( cases + 1 )); echo "ok   $1"; }
bad() { cases=$(( cases + 1 )); echo "FAIL $1: $2"; fail=1; }
check() { # check <name> <expected calls> [<shell test that must hold> ...]
  name=$1; want=$2; shift 2; got=$(calls)
  [ $rc -eq 0 ] || { bad "$name" "exit code $rc"; return; }
  [ "$got" = "$want" ] || { bad "$name" "expected calls '$want' got '$got'"; return; }
  for cond in "$@"; do eval "$cond" || { bad "$name" "not true: $cond"; return; }; done
  ok "$name"
}
restored='cmp -s $D/nexus.sh $D/good/nexus.sh && cmp -s $D/cron.sh $D/good/cron.sh && cmp -s $D/config $D/good/config'
untouched='grep -q "# new" $D/nexus.sh && grep -q "# new" $D/config'
held='grep -q "^rescue [0-9]*$" $D/NORADIO'
RB="killall dd wget|set wirelessEnable 1|start"; RB=$(echo "$RB" | tr '|' '\n' | tr '\n' ' ' | sed 's/ $//')

# --- normal operation: nothing at all ---
reset; run
check "healthy panel -> nothing, no log, no state" "" '[ ! -f $D/rescue.log ]' '[ ! -f $D/nexus.log ]' '[ ! -f $D/rescue.net ]' '[ ! -d $T/rescue.lock ]' 'grep -q " idle$" $T/rescue.last'

# --- trial with a dead-man switch ---
reset; panel new; trial 300 5; run
check "trial running -> one log line, nothing else" "" "$untouched" '[ -f $D/TRIAL ]' '[ $(grep -c "trial running" $D/rescue.log) -eq 1 ]' '[ ! -f $D/nexus.log ]'

alive() { for p in /proc/[0-9]*; do { tr '\0' ' ' < $p/cmdline; } 2>/dev/null | grep "$1"; done; }   # command lines that contain <text>
reset; panel new; trial -10 5
/bin/sh $D/nexus.sh run & /bin/sh $D/nexus.sh stream & /bin/sh -c "while :; do /bin/sleep 1; done; echo $D/nexus.sh run" & BYSTANDER=$!
/bin/sleep 1; run; /bin/sleep 1
check "trial deadline passed -> rollback: files restored, radio held, panel started" "$RB" "$restored" '[ ! -f $D/TRIAL ]' "$held" \
  'grep -q "deadline passed" $D/ROLLED_BACK' 'grep -q "restore ok" $D/ROLLED_BACK' 'grep -q "rescue: ROLLBACK done" $D/nexus.log' \
  'grep -q "# new" $D/failed/nexus.sh' '[ ! -f $D/nexus.pid ]'
[ -z "$(alive "^/bin/sh $D/nexus.sh ")" ] && ok "… and the running client was killed, in every mode (run, stream)" || bad "… and the running client was killed" "still alive"
kill -0 $BYSTANDER 2>/dev/null && ok "… but not a shell that only names the script in its command text (an SSH session)" || bad "… but not a bystander shell" "it was killed"
kill $BYSTANDER 2>/dev/null

reset; panel new; echo garbage > $D/TRIAL; run
check "TRIAL is garbage -> treated as expired -> rollback" "$RB" "$restored"
reset; panel new; : > $D/TRIAL; run
check "TRIAL is empty -> rollback" "$RB" "$restored"
reset; panel new; echo "$(( $(now) + 300 ))" > $D/TRIAL; run
check "TRIAL without its length -> rollback" "$RB" "$restored"
reset; panel new; echo "0$(( $(now) + 300 )) 08" > $D/TRIAL; run
check "TRIAL with leading zeros (octal trap) -> rollback, no crash" "$RB" "$restored"
reset; panel new; echo "99999999999999999999 5" > $D/TRIAL; run
check "TRIAL with an absurd number -> rollback, no crash" "$RB" "$restored"
reset; panel new; trial 300 9999; run
check "TRIAL longer than 12 h -> rollback" "$RB" "$restored"
reset; panel new; trial 7200 5; run
check "deadline 2 h away in a 5-minute trial (clock went back) -> rollback" "$RB" "$restored" 'grep -q "clock moved" $D/ROLLED_BACK'
reset; panel new; trial 400 5; run
check "deadline 400 s away in a 5-minute trial (inside the 2 min tolerance) -> still running" "" "$untouched"
reset; panel new; trial 300 5; export RESCUE_TMP_MIN_KB=999999999; run
check "/tmp nearly full during a trial -> rollback at once" "$RB" "$restored" 'grep -q "nearly full" $D/ROLLED_BACK'
reset; export RESCUE_TMP_MIN_KB=999999999; run
check "/tmp nearly full without a trial -> nothing" ""

reset; panel new; touch $D/ROLLBACK; run
check "ROLLBACK file -> rollback, file removed" "$RB" "$restored" '[ ! -f $D/ROLLBACK ]' 'grep -q "ROLLBACK file" $D/ROLLED_BACK'
reset; panel new; touch $D/ROLLBACK; trial 300 5; run
check "ROLLBACK file during a running trial -> rollback, trial over" "$RB" "$restored" '[ ! -f $D/TRIAL ]'
reset; panel new; touch $D/ROLLBACK $D/DISABLED; run
check "rollback with DISABLED -> restored but not started" "killall dd wget set wirelessEnable 1" "$restored" 'grep -q "not started" $D/ROLLED_BACK'
reset; panel new; touch $D/ROLLBACK; echo x > $T/nexus.radio_off; echo x > $T/nexus.window; run
check "rollback clears a radio-off window left by the failed script" "$RB" '[ ! -f $T/nexus.radio_off ]' '[ ! -f $T/nexus.window ]'
reset; panel new; touch $D/ROLLBACK; export RESCUE_TMP_MIN_KB=999999999; echo x > $T/nexus.junk; echo 5 > $T/nexus.wd_restart; run
check "rollback with /tmp nearly full drops the client's files there, keeps the watchdog stamps" "$RB" '[ ! -f $T/nexus.junk ]' '[ -f $T/nexus.wd_restart ]'

# --- no usable good/: never destroy the current files, only make sure we can get in ---
reset; panel new; rm -rf $D/good; trial -10 5; run
check "trial expired, good/ missing -> nothing restored, radio held on, TRIAL stays" "set wirelessEnable 1" "$untouched" "$held" '[ -f $D/TRIAL ]' '[ ! -f $D/ROLLED_BACK ]' 'grep -q "nothing restored" $D/nexus.log'
run
check "… next run: hold renewed, no second log line" "set wirelessEnable 1 set wirelessEnable 1" "$untouched" '[ $(grep -c "nothing restored" $D/nexus.log) -eq 1 ]'
reset; panel new; echo "# tampered" >> $D/good/nexus.sh; touch $D/ROLLBACK; run
check "good/ changed since the snapshot (checksum) -> nothing restored" "set wirelessEnable 1" "$untouched" "$held"
reset; panel new; rm $D/good/config; touch $D/ROLLBACK; run
check "good/ lacks a file -> nothing restored" "set wirelessEnable 1" "$untouched"
reset; panel new; : > $D/good/md5; touch $D/ROLLBACK; run
check "good/ has no checksums -> nothing restored" "set wirelessEnable 1" "$untouched"
reset; panel new; echo 'if then (' > $D/good/nexus.sh; ( cd $D/good && md5sum nexus.sh cron.sh config > md5 ); touch $D/ROLLBACK; run
check "good/nexus.sh does not parse -> nothing restored" "set wirelessEnable 1" "$untouched"

# --- radio hold ---
reset; echo "rescue $(( $(now) + 600 ))" > $D/NORADIO; run
check "our hold, not expired -> kept, radio already on -> nothing" "" "$held"
reset; echo "rescue $(( $(now) + 600 ))" > $D/NORADIO; echo 0 > $W/wen; down; window 500 600; run
check "our hold while the radio is off (even in a window) -> switched on" "set wirelessEnable 1" "$held"
reset; echo "rescue $(( $(now) - 5 ))" > $D/NORADIO; run
check "our hold expired -> NORADIO removed, logged" "" '[ ! -f $D/NORADIO ]' 'grep -q "radio hold over" $D/nexus.log'
reset; echo "rescue soon" > $D/NORADIO; run
check "our hold with a garbage expiry -> removed" "" '[ ! -f $D/NORADIO ]'
reset; echo "rescue $(( $(now) + 999999 ))" > $D/NORADIO; run
check "our hold reaching further than 4 h -> removed" "" '[ ! -f $D/NORADIO ]'
reset; : > $D/NORADIO; run
check "NORADIO made by hand (empty) -> never touched" "" '[ -f $D/NORADIO ]' '[ ! -s $D/NORADIO ]'
reset; panel new; : > $D/NORADIO; touch $D/ROLLBACK; run
check "rollback with a hand-made NORADIO -> it stays as it is" "$RB" "$restored" '[ ! -s $D/NORADIO ]'

# --- guards ---
reset; panel new; trial -10 5; echo "50.00 1.00" > $W/uptime; run
check "uptime under 90 s -> nothing yet, even with an expired trial" "" "$untouched" '[ -f $D/TRIAL ]'
reset; panel new; touch $D/ROLLBACK; mkdir $T/rescue.lock; now > $T/rescue.lock/t; run
check "another run holds the lock -> nothing" "" "$untouched" '[ -d $T/rescue.lock ]'
reset; panel new; touch $D/ROLLBACK; mkdir $T/rescue.lock; echo $(( $(now) - 400 )) > $T/rescue.lock/t; run
check "a lock left behind 400 s ago -> taken over" "$RB" "$restored" '[ ! -d $T/rescue.lock ]'
reset; i=0; while [ $i -lt 500 ]; do echo "line $i"; i=$(( i + 1 )); done > $D/rescue.log; run
check "own log over 400 lines -> cut to the last 200" "" '[ $(wc -l < $D/rescue.log) -le 201 ]' 'grep -q "line 499" $D/rescue.log'
reset; panel new; trial -10 5; export RESCUE_DRY=1; run
check "dry run with an expired trial -> nothing changed, intention logged" "" "$untouched" '[ -f $D/TRIAL ]' 'grep -q "dry run, not done: rollback" $D/rescue.log'
reset; touch $D/RESCUE_DEBUG; run
check "RESCUE_DEBUG -> one log line per run" "" 'grep -q "debug: idle" $D/rescue.log'

# --- connection watchdog: escalation ---
reset; down; run
check "Wi-Fi not connected, first sight -> only remembered" "" '[ -f $D/rescue.net ]' '[ ! -f $D/nexus.log ]'
reset; down; net 60 0; run
check "not connected for 60 s -> still waiting (the client reconnects by itself)" "" '[ ! -f $D/nexus.log ]'
reset; down; net 130 0; run
check "not connected for 130 s -> step 1: radio on again" "set wirelessEnable 1" 'grep -q " 1$" $D/rescue.net' 'grep -q "step 1" $D/nexus.log'
reset; down; net 200 1; run
check "200 s, step 1 done -> waiting" ""
reset; down; net 310 1; run
check "310 s -> step 2: power-cycle" "set wirelessEnable 0 set wirelessEnable 1" 'grep -q " 2$" $D/rescue.net' 'grep -q "step 2" $D/nexus.log'
reset; down; net 600 2; run
check "600 s, step 2 done -> waiting" ""
reset; down; net 910 2; run
check "910 s -> step 3: power-cycle once more" "set wirelessEnable 0 set wirelessEnable 1" 'grep -q " 3$" $D/rescue.net'
reset; down; net 910 2; touch $D/WIFID_RESTART; run
check "910 s with WIFID_RESTART -> step 3 restarts wifid first" "wifid stop wifid start set wirelessEnable 0 set wirelessEnable 1"
reset; down; net 2000 3; run
check "2000 s, step 3 done -> waiting (cron.sh's own reboot rule comes first)" ""
reset; down; net 2710 3; run
check "2710 s, up 10 h -> last resort: reboot, stamp written for cron.sh" "reboot" '[ -s $T/nexus.wd_reboot ]' 'grep -q "reboot" $D/nexus.log'
reset; down; net 2710 3; echo "3600.00 1.00" > $W/uptime; run
check "same, but booted 1 h ago -> no reboot" "" '[ $(cat $T/nexus.wd_reboot) -le $(( $(now) - 3590 )) ]'
reset; down; net 2710 3; echo $(( $(now) - 3600 )) > $T/nexus.wd_reboot; run
check "same, but cron.sh rebooted (stamp) 1 h ago -> no reboot" ""
reset; down; net 2710 3; touch $D/NOREBOOT; run
check "same, with NOREBOOT -> no reboot" ""
reset; down; net 2710 3; echo 'WIFI_DEAD_REBOOT=0     # off' >> $D/config; run
check "same, with WIFI_DEAD_REBOOT=0 in config -> no reboot" ""
reset; down; net 2710 3; echo 'WIFI_DEAD_REBOOT=1800' >> $D/config; run
check "same, with WIFI_DEAD_REBOOT=1800 -> reboot" "reboot"
reset; down; net 5000 0; run
check "long outage but no step taken yet -> step 1 first, never straight to a reboot" "set wirelessEnable 1"
reset; down ""; net 130 0; run
check "wifid gives no answer at all -> counts as not connected" "set wirelessEnable 1" 'grep -q "no answer" $D/nexus.log'
reset; down PENDING; net 130 0; run
check "wifid PENDING for 130 s -> step 1" "set wirelessEnable 1"
reset; down; net 310 1; export RESCUE_DRY=1; run
check "dry run -> the step is logged, the radio is not touched" "" 'grep -q "dry run, not done: lipc-set-prop com.lab126.cmd wirelessEnable 0" $D/rescue.log'

# --- connection watchdog: when it must stay quiet ---
reset; net 400 2; run
check "connected again after a step -> state dropped, logged" "" '[ ! -f $D/rescue.net ]' 'grep -q "connected again" $D/nexus.log'
reset; net 60 0; run
check "connected again before any step -> state dropped silently" "" '[ ! -f $D/rescue.net ]' '[ ! -f $D/nexus.log ]'
reset; run
check "connected, server silent or not: the server is never asked" "" '[ ! -f $D/rescue.net ]'
reset; down; echo 0 > $W/wen; window 300 600; net 500 2; run
check "radio off in the client's own window (day, 600 s) -> quiet, old state dropped" "" '[ ! -f $D/rescue.net ]' 'grep -q "battery saver" $T/rescue.last'
reset; down; window 5000 7200; run
check "night window (7200 s) running -> quiet" "" '[ ! -f $D/rescue.net ]'
reset; down; window -60 600; net 500 0; run
check "window ended 60 s ago (client reconnecting) -> quiet" "" '[ ! -f $D/rescue.net ]'
reset; down; window -200 600; net 130 0; run
check "window ended 200 s ago and still not connected -> watchdog acts" "set wirelessEnable 1"
reset; down; window 300 600; rm $T/nexus.radio_off; net 130 0; run
check "window stamp but no radio_off file (the client has switched the radio on) -> acts" "set wirelessEnable 1"
reset; down; window 300 600; /bin/sh -c 'exit 0' & DEAD=$!; wait $DEAD; echo $DEAD > $D/nexus.pid; net 130 0; run
check "window running but the client is dead -> acts" "set wirelessEnable 1"
reset; down; window 300 600; rm $D/nexus.pid; net 130 0; run
check "window running but no pid file -> acts" "set wirelessEnable 1"
reset; down; window 300 999999; net 130 0; run
check "window with an absurd length -> not believed -> acts" "set wirelessEnable 1"
reset; down; window 99999 600; net 130 0; run
check "window ending absurdly far ahead -> not believed -> acts" "set wirelessEnable 1"
reset; down; echo 1 > $T/nexus.radio_off; echo garbage > $T/nexus.window; net 130 0; run
check "garbage window stamp -> acts" "set wirelessEnable 1"
reset; down; echo 1 > $T/nexus.radio_off; net 130 0; run
check "radio_off file without a window stamp -> acts" "set wirelessEnable 1"
reset; down; net 40000 3; run
check "state older than this boot (10 h up, stamp 11 h old) -> a new outage starts" "" 'grep -q " 0$" $D/rescue.net'
reset; down; echo "$(( $(now) + 500 )) 2" > $D/rescue.net; run
check "state from the future (clock moved) -> a new outage starts" "" 'grep -q " 0$" $D/rescue.net'
reset; down; echo "garbage" > $D/rescue.net; run
check "garbage state -> a new outage starts" "" 'grep -q " 0$" $D/rescue.net'
reset; down; net 2710 3; touch $D/NONET; run
check "NONET -> the watchdog does nothing" "" 'grep -q " 3$" $D/rescue.net'
reset; down; net 2710 3; echo "100.00 1.00" > $W/uptime; run
check "first 3 minutes after a boot -> the watchdog waits" ""
reset; down; net 2710 3; touch $D/DISABLED; run
check "DISABLED (panel switched off, the Kindle is a reader) -> the watchdog does nothing" ""
reset; down; net 2710 3; export RESCUE_DRY=1; run
check "dry run at the reboot step -> logged, no reboot, no stamp" "" '[ ! -f $T/nexus.wd_reboot ]' 'grep -q "dry run, not done: reboot" $D/rescue.log'

# --- the reboot stamp shared with cron.sh ---
reset; echo "3600.00 1.00" > $W/uptime; run
check "booted 1 h ago, no stamp -> boot time written as cron.sh's reboot stamp" "" '[ $(cat $T/nexus.wd_reboot) -le $(( $(now) - 3590 )) ]' '[ $(cat $T/nexus.wd_reboot) -ge $(( $(now) - 3700 )) ]'
reset; echo "3600.00 1.00" > $W/uptime; echo 12345 > $T/nexus.wd_reboot; run
check "an existing stamp is left alone" "" '[ "$(cat $T/nexus.wd_reboot)" = 12345 ]'
reset; run
check "up for 10 h -> no stamp written" "" '[ ! -f $T/nexus.wd_reboot ]'

echo "$cases cases"
[ $fail -eq 0 ] && echo "all rescue.sh cases passed" || { echo "rescue.sh cases FAILED"; exit 1; }
