#!/bin/sh
# Decision-table test for kindle/cron.sh (the client watchdog), runnable on any box with a POSIX sh:
#   dash kindle/tests/cron-test.sh   (TEST_SH=… picks the shell cron.sh runs under; default sh). Fakes the stamps
# nexus.sh writes, a live pid, the bridge (wget stub) and nexus.sh itself (records start/restart), then checks what
# cron.sh decides in each situation. Not busybox-on-Ubuntu: that build runs timeout/wget as built-in applets and
# ignores the PATH stubs (the Kindle's busybox 1.7.2 does take "timeout -t N" for real).
#
# The interesting part since the radio duty cycle (2026-10-16): no fetch can succeed while the Wi-Fi radio is off,
# so /tmp/nexus.window ("<end epoch> <window s>") widens the stale threshold to window + 120 s while that window
# runs — otherwise the watchdog would restart the client on every 10-minute day window and every 2-hour night one.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CRON=$HERE/../cron.sh
W=$(mktemp -d); trap 'rm -rf $W; kill $SLEEPER 2>/dev/null' EXIT
mkdir -p $W/dir $W/tmp $W/bin
sleep 600 & SLEEPER=$!
printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n' > $W/dir/config
printf '#!/bin/sh\necho "$1" >> %s/calls\n' $W > $W/dir/nexus.sh
# PATH shims: busybox 1.7.2 syntax "timeout -t N cmd" (newer busybox/coreutils differ) and a bridge that is up or down.
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\n[ -f %s/bridge_down ] && exit 1\nexit 0\n' $W > $W/bin/wget
chmod +x $W/bin/* $W/dir/nexus.sh
export PATH=$W/bin:$PATH NEXUS_DIR=$W/dir NEXUS_TMP=$W/tmp NEXUS_GRACE_WAIT=0
now() { date +%s; }
reset() { rm -f $W/calls $W/tmp/* $W/dir/DISABLED $W/bridge_down; echo $SLEEPER > $W/dir/nexus.pid
  printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n' > $W/dir/config; }
stamp() { echo $(( $(now) - $1 )) > $W/tmp/nexus.last_ok; }          # stamp <age in s>
window() { echo "$(( $(now) + $1 )) $2" > $W/tmp/nexus.window; }     # window <ends in s (negative = ended)> <length>
run() { ${TEST_SH:-sh} $CRON; }
calls() { cat $W/calls 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
fail=0
check() { # check <name> <expected calls>
  got=$(calls)
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2' got '$got'"; fail=1; fi
}

# --- the always-on path: threshold = max(180, POLL_SECONDS + 120) ---
reset; stamp 10; run
check "fresh stamp -> nothing" ""

reset; stamp 400; run
check "stale stamp (400s > 180s), bridge up -> restart" "restart"

reset; stamp 400; touch $W/bridge_down; run
check "stale stamp, bridge down -> nothing" ""

reset; stamp 170; run
check "age 170s is under the 180s floor -> nothing" ""

reset; printf 'BRIDGE_URL="http://bridge.test"\nPOLL_SECONDS=300\n' > $W/dir/config; stamp 400; run
check "POLL_SECONDS=300 (no window) -> threshold 420s, age 400 -> nothing" ""

reset; printf 'BRIDGE_URL="http://bridge.test"\nPOLL_SECONDS=300\n' > $W/dir/config; stamp 500; run
check "POLL_SECONDS=300, age 500 > 420 -> restart" "restart"

# --- radio-off windows: the whole point of the change ---
reset; stamp 400; window 200 600; run
check "day window (600s) still running, age 400 -> nothing" ""

reset; stamp 700; window 10 600; run
check "day window (600s) nearly over, age 700 (< 720) -> nothing" ""

reset; stamp 900; window 10 600; run
check "day window (600s), age 900 > 720 -> restart" "restart"

reset; stamp 4000; window 3200 7200; run
check "night window (7200s) running, age 4000 -> nothing" ""

reset; stamp 7300; window -60 7200; run
check "night window ended 60s ago, age 7300 (< 7320) -> nothing (reconnecting)" ""

reset; stamp 7700; window -400 7200; run
check "night window ended 400s ago and still no fetch -> restart" "restart"

reset; stamp 7700; window -400 7200; touch $W/bridge_down; run
check "same, but the bridge is down -> nothing" ""

reset; stamp 9000; window 3200 999999; run
check "absurd window length is capped at 7800 (threshold 7920), age 9000 -> restart" "restart"

reset; stamp 7000; window 3200 999999; run
check "… and the cap still covers a legitimate long window, age 7000 -> nothing" ""

reset; stamp 400; echo garbage > $W/tmp/nexus.window; run
check "garbage window stamp -> fall back to the config threshold -> restart" "restart"

reset; stamp 400; echo "" > $W/tmp/nexus.window; run
check "empty window stamp -> config threshold -> restart" "restart"

reset; stamp 400; echo "$(( $(now) + 3000 ))" > $W/tmp/nexus.window; run
check "half-written window stamp (end but no length) -> config threshold -> restart" "restart"

reset; stamp 400; echo "notanumber 600" > $W/tmp/nexus.window; run
check "non-numeric end epoch -> config threshold -> restart" "restart"

# --- guards that predate the radio duty cycle ---
reset; stamp 400; echo $(( $(now) - 100 )) > $W/tmp/nexus.wd_restart; run
check "stale but a restart 100s ago (guard) -> nothing" ""

# a pid that really is gone (pid 1 is not: kill -0 1 succeeds for root)
sh -c 'exit 0' & DEAD=$!; wait $DEAD
reset; echo $DEAD > $W/dir/nexus.pid; run
check "pid dead -> start" "start"

reset; echo 1 > $W/dir/nexus.pid; touch $W/dir/DISABLED; run
check "DISABLED -> nothing" ""

reset; stamp 400; window 200 600; touch $W/dir/DISABLED; run
check "DISABLED wins over everything -> nothing" ""

[ $fail -eq 0 ] && echo "all cron.sh cases passed" || { echo "cron.sh cases FAILED"; exit 1; }
