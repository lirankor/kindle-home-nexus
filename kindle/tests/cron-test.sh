#!/bin/sh
# Decision-table test for kindle/cron.sh (the client watchdog), runnable on any box with a POSIX sh:
#   dash kindle/tests/cron-test.sh   (TEST_SH=… picks the shell cron.sh runs under; default sh). Fakes the stamps
# nexus.sh writes, a live pid, the bridge (wget stub) and nexus.sh itself (records start/restart), then checks what
# cron.sh decides in each situation. Not busybox-on-Ubuntu: that build runs timeout/wget as built-in applets and
# ignores the PATH stubs (the Kindle's busybox 1.7.2 does take "timeout -t N" for real).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CRON=$HERE/../cron.sh
W=$(mktemp -d); trap 'rm -rf $W; kill $SLEEPER 2>/dev/null' EXIT
mkdir -p $W/dir $W/tmp $W/bin
sleep 600 & SLEEPER=$!
printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\n' > $W/dir/config
printf '#!/bin/sh\necho "$1" >> %s/calls\n' $W > $W/dir/nexus.sh
# PATH shims: busybox 1.7.2 syntax "timeout -t N cmd" (newer busybox/coreutils differ) and a bridge that is up or down.
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\n[ -f %s/bridge_down ] && exit 1\nexit 0\n' $W > $W/bin/wget
chmod +x $W/bin/* $W/dir/nexus.sh
export PATH=$W/bin:$PATH NEXUS_DIR=$W/dir NEXUS_TMP=$W/tmp NEXUS_GRACE_WAIT=0
now() { date +%s; }
reset() { rm -f $W/calls $W/tmp/* $W/dir/DISABLED $W/bridge_down; echo $SLEEPER > $W/dir/nexus.pid; }
run() { ${TEST_SH:-sh} $CRON; }
calls() { cat $W/calls 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
fail=0
check() { # check <name> <expected calls>
  got=$(calls)
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2' got '$got'"; fail=1; fi
}

reset; echo $(( $(now) - 10 )) > $W/tmp/nexus.last_ok; run
check "fresh stamp -> nothing" ""

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; run
check "stale stamp, bridge up -> restart" "restart"

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; touch $W/bridge_down; run
check "stale stamp, bridge down -> nothing" ""

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; echo $(( $(now) + 3000 )) > $W/tmp/nexus.sleeping; run
check "suspended until later (sleeping stamp) -> nothing" ""

reset; echo $(( $(now) - 4000 )) > $W/tmp/nexus.last_ok; echo $(( $(now) - 60 )) > $W/tmp/nexus.sleeping; run
check "alarm fired 60 s ago, still inside the wake grace -> nothing" ""

reset; echo $(( $(now) - 4000 )) > $W/tmp/nexus.last_ok; echo $(( $(now) - 400 )) > $W/tmp/nexus.sleeping; run
check "sleeping stamp left behind 400 s past the alarm, stale -> restart" "restart"

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; echo $(( $(now) - 30 )) > $W/tmp/nexus.last_wake; run
check "resumed 30 s ago, stale stamp -> nothing (reconnecting)" ""

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_wake; run
check "resumed 400 s ago, stale stamp -> restart" "restart"

reset; echo $(( $(now) - 400 )) > $W/tmp/nexus.last_ok; echo $(( $(now) - 100 )) > $W/tmp/nexus.wd_restart; run
check "stale but a restart 100 s ago (guard) -> nothing" ""

reset; echo $(( $(now) - 4000 )) > $W/tmp/nexus.last_ok; echo garbage > $W/tmp/nexus.sleeping; run
check "garbage sleeping stamp counts as expired -> restart" "restart"

reset; echo 1 > $W/dir/nexus.pid; run
check "pid dead -> start" "start"

reset; echo 1 > $W/dir/nexus.pid; touch $W/dir/DISABLED; run
check "DISABLED -> nothing" ""

[ $fail -eq 0 ] && echo "all cron.sh cases passed" || { echo "cron.sh cases FAILED"; exit 1; }
