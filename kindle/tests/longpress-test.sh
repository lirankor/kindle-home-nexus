#!/bin/sh
# Long press of the 5-way centre (kindle/nexus.sh handle_event / sel_down / sel_up / sel_done), runnable on any
# box with a POSIX sh:  sh kindle/tests/longpress-test.sh
# nexus.sh's functions are loaded from a copy whose paths point into a temp dir. send_key, radio_up and cycle are
# replaced by recorders, the hold timer's sleep is a stub that never returns a line (the test feeds the "hold"
# line itself, exactly as the timer writes it).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf $W' EXIT
mkdir -p $W/dir $W/tmp $W/bin
sed -n '/^case "\$1" in/q;p' $HERE/../nexus.sh \
  | sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
  > $W/lib.sh
printf '#!/bin/sh\nexec /bin/sleep 30\n' > $W/bin/sleep   # the timer never fires by itself during a case
chmod +x $W/bin/*
fail=0
ev() { handle_event "$@"; }
scenario() { # scenario <LONG_PRESS or ""> <name> <expected keys> <event lines…> : events are "sec usec type code value"
  lp=$1; name=$2; want=$3; shift 3
  { printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n'; [ -n "$lp" ] && echo "LONG_PRESS=$lp"; } > $W/dir/config
  rm -f $W/sent
  (
    set +u
    . $W/lib.sh
    send_key() { echo "$1" >> $W/sent; }
    radio_up() { :; }
    cycle() { echo poll >> $W/sent; }
    for line in "$@"; do
      [ "$line" = "HOLD" ] && line="0 0 hold $SELGEN 0"
      [ "$line" = "POLL" ] && line="0 0 poll $GEN 0"
      ev $line
    done
    [ -n "$HOLDT" ] && kill $HOLDT 2>/dev/null
  ) > /dev/null 2>&1
  got=$(tr '\n' ' ' < $W/sent 2>/dev/null | sed 's/ $//')
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: sent '$got', expected '$want'"; fail=1; fi
}
DOWN="100 0 1 194 1"          # centre down at t = 100.000
UPKEY="100 100000 1 103 0"    # any key's release (here: up), proves the keypad reports releases
PRIME="99 0 1 103 1"          # ... after its press

scenario "" "before any release was seen the centre acts on key-down (keypad without releases)" \
  "select select" "$DOWN" "101 0 1 194 1"
scenario "" "first press of a run acts on key-down, its release switches long press on" \
  "select select" "$DOWN" "100 150000 1 194 0" "105 0 1 194 1" "105 120000 1 194 0"
scenario "" "short press: select on release" \
  "up select" "$PRIME" "$UPKEY" "$DOWN" "100 180000 1 194 0"
scenario "" "nothing is sent while the centre is down" \
  "up" "$PRIME" "$UPKEY" "$DOWN"
scenario "" "held: select-long as soon as the timer line arrives, the later release is ignored" \
  "up select-long" "$PRIME" "$UPKEY" "$DOWN" HOLD "102 500000 1 194 0"
scenario "" "release after the threshold but before the timer line (slow reader): select-long by event time" \
  "up select-long" "$PRIME" "$UPKEY" "$DOWN" "101 50000 1 194 0" HOLD
scenario "" "just under one second is still a short press" \
  "up select" "$PRIME" "$UPKEY" "$DOWN" "100 990000 1 194 0"
scenario "" "microseconds roll over: 99.900 -> 100.100 is 200 ms" \
  "up select" "$PRIME" "$UPKEY" "99 900000 1 194 1" "100 100000 1 194 0"
scenario "" "a stale timer line of an earlier press does nothing" \
  "up select select" "$PRIME" "$UPKEY" "$DOWN" "100 100000 1 194 0" "103 0 1 194 1" "0 0 hold 1 0" "103 90000 1 194 0"
scenario "" "another key while the centre is pending: the press is sent first, then the key" \
  "up select down" "$PRIME" "$UPKEY" "$DOWN" "100 300000 1 108 1"
scenario "" "auto-repeat events (value 2) are ignored" \
  "up select-long" "$PRIME" "$UPKEY" "$DOWN" "100 500000 1 194 2" "100 700000 1 194 2" HOLD
scenario "" "a poll during a pending press runs and the press still resolves" \
  "up poll select" "$PRIME" "$UPKEY" "$DOWN" POLL "100 200000 1 194 0"
scenario 2 "LONG_PRESS=2: 1.5 s is short, 2.1 s is long" \
  "up select select-long" "$PRIME" "$UPKEY" "$DOWN" "101 500000 1 194 0" "110 0 1 194 1" "112 100000 1 194 0"
scenario 0 "LONG_PRESS=0: the centre acts on key-down, releases change nothing" \
  "up select select" "$PRIME" "$UPKEY" "$DOWN" "100 200000 1 194 0" "101 0 1 194 1" HOLD
scenario x "a non-numeric LONG_PRESS falls back to 1 s" \
  "up select-long" "$PRIME" "$UPKEY" "$DOWN" "101 0 1 194 0"
scenario "" "other keys still act on key-down, side buttons included" \
  "up next f1" "$PRIME" "$UPKEY" "101 0 1 104 1" "102 0 1 158 1"

[ $fail = 0 ] && echo "all long press checks passed"
exit $fail
