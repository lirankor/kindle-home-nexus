#!/bin/sh
# The two-channel flow of kindle/nexus.sh (STREAM=1): presses on their own short request, pictures on one held-open
# request. Runnable on a Linux box with a POSIX sh, GNU sleep/timeout/date and procps:  sh kindle/tests/stream-test.sh
# Part 1 loads nexus.sh's functions from a copy whose paths point into a temp dir; eips, lipc-*, wget, timeout,
# sleep and usleep are PATH stubs that record what the client did. Part 2 runs the whole script (start, keys through
# a FIFO in place of /dev/input/event0, stop, restart) and looks for leftover processes.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d)
RS=$(command -v sleep); RT=$(command -v timeout || true)
cleanup() { pkill -f "$W/" 2>/dev/null; rm -rf $W; }
trap cleanup EXIT
mkdir -p $W/dir $W/tmp $W/bin $W/dev
conf() { # conf <extra config lines…>
  { printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\nLONG_PRESS=0\n'; for l in "$@"; do echo "$l"; done; } > $W/dir/config
}
# everything before the command dispatch, with the Kindle's paths moved into the temp dir
sed -n '/^case "\$1" in/q;p' $HERE/../nexus.sh \
  | sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
  > $W/lib.sh

# ---- stubs ----
cat > $W/bin/eips <<STUB
#!/bin/sh
last=; for a in "\$@"; do last=\$a; done
case "\$*" in
  *-g*) pic=\$(cat "\$last" 2>/dev/null); echo "eips \$* = \$pic" >> $W/calls
        [ -f $W/draw_s ] && $RS \$(cat $W/draw_s)
        echo "drawn \$pic" >> $W/calls;;
  *) echo "eips \$*" >> $W/calls;;
esac
exit 0
STUB
printf '#!/bin/sh\necho "lipc-set $*" >> %s/calls\n' $W > $W/bin/lipc-set-prop
printf '#!/bin/sh\n[ -f %s/no_wifi ] && echo PENDING || echo CONNECTED\n' $W > $W/bin/lipc-get-prop
# timeout -t <s> <command…>: the real limit (GNU timeout), and a note of the limit given to the picture request
cat > $W/bin/timeout <<STUB
#!/bin/sh
lim=; [ "\$1" = -t ] && { lim=\$2; shift 2; }
case "\$*" in *stream.png*) echo "limit \$lim" >> $W/calls;; esac
[ -n "$RT" ] && [ -n "\$lim" ] && exec $RT \$lim "\$@"
exec "\$@"
STUB
# sleep: real while $W/sleep_real exists (part 2), else logged and over at once
printf '#!/bin/sh\n[ -f %s/sleep_real ] && exec %s "$@"\necho "sleep $*" >> %s/calls\nexec %s 0.05\n' $W $RS $W $RS > $W/bin/sleep
printf '#!/bin/sh\nexec %s $(printf "%%d.%%06d" $(( $1 / 1000000 )) $(( $1 %% 1000000 )))\n' $RS > $W/bin/usleep
printf '#!/bin/sh\npkill -f "of=%s/tmp/nexus.ev" 2>/dev/null\nexit 0\n' $W > $W/bin/killall   # never the box's other dd processes
# wget -q -O <file|-> <url>: the bridge. Like the Kindle's wget it refuses an output file that exists.
#   /press/<name>  "ok"; hangs while press_hang exists, fails while press_fail exists, takes 0.15 s while press_slow exists
#   /stream.png    the picture in $W/frame once it differs from ?have=; until then held open for `hold` x 0.05 s and
#                  answered empty; hangs while stream_hang exists, fails while stream_fail exists
cat > $W/bin/wget <<STUB
#!/bin/sh
out=\$3; url=\$4
echo "wget \$url" >> $W/calls
[ "\$out" != - ] && [ -e "\$out" ] && { echo "wget refused: \$out exists" >> $W/calls; exit 1; }
put() { if [ "\$out" = - ]; then echo "\$1"; else echo "\$1" > "\$out"; fi; }
pic() { if [ "\$out" = - ]; then cat $W/frame; else cat $W/frame > "\$out"; fi; }
case "\$url" in
  */press/*)
    [ -f $W/press_hang ] && exec $RS 61
    [ -f $W/press_fail ] && exit 1
    [ -f $W/press_slow ] && $RS 0.15
    put ok; echo "done \${url##*/}" >> $W/calls;;
  */wake) put ok;;
  */stream.png*)
    [ -f $W/stream_hang ] && exec $RS 61
    [ -f $W/stream_fail ] && exit 1
    have=\${url#*have=}; have=\${have%%&*}
    i=0
    while [ "\$(md5sum < $W/frame | cut -c1-32)" = "\$have" ]; do
      i=\$(( i + 1 )); [ \$i -gt \$(cat $W/hold 2>/dev/null || echo 6) ] && { : > "\$out"; exit 0; }
      $RS 0.05
    done
    pic;;
  */schedule*) if [ -f $W/doze ]; then put "20 doze \$(( \$(date +%s) + 120 )) 120 0 12:00"; else put "20 awake 0 0 0 -"; fi;;
  *connecting=1*) put BADGE;;
  */hint) if [ -f $W/hint_full ]; then put full; else put partial; fi;;
  */screen.png*|*/reload|*/key/*) pic;;
  *) put ok;;
esac
STUB
chmod +x $W/bin/*

# ---- helpers ----
fail=0
check() { # check <name> <command…>
  name=$1; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; echo "     calls: $(cat $W/calls 2>/dev/null | tr '\n' '|')"; echo "     log: $(cat $W/dir/nexus.log 2>/dev/null | tr '\n' '|')"; fail=1; fi
}
has() { grep -q -- "$1" $W/calls 2>/dev/null; }
hasnt() { ! has "$1"; }
count() { grep -c -- "$1" $W/calls 2>/dev/null; }
logged() { grep -q -- "$1" $W/dir/nexus.log 2>/dev/null; }
order() { # order <first> <second> : both recorded, first before second
  a=$(grep -n -- "$1" $W/calls | head -1 | cut -d: -f1); b=$(grep -n -- "$2" $W/calls | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
seq_is() { # seq_is <pattern> <expected> : the recorded lines matching the pattern, joined with |
  [ "$(grep -- "$1" $W/calls | tr '\n' '|')" = "$2" ]
}
waitfor() { # waitfor <tenths of a second> <command…> : true as soon as the command is
  n=$1; shift; i=0
  while [ $i -lt $n ]; do "$@" && return 0; $RS 0.1; i=$(( i + 1 )); done
  "$@"
}
frame() { echo "$1" > $W/frame.new; mv $W/frame.new $W/frame; }   # a new picture at the bridge, in one step
sum() { echo "$1" | md5sum | cut -c1-32; }
reset() { rm -f $W/calls $W/dir/nexus.log $W/tmp/nexus.* $W/press_* $W/stream_* $W/no_wifi $W/doze $W/hint_full $W/draw_s $W/hold; frame FRAME1; }
ms() { echo $(( $(date +%s%N) / 1000000 )); }
# process checks run in this shell: a `sh -c "pgrep -f …"` would find its own command line
nohung() { ! pgrep -f "$RS 61" > /dev/null; }             # the stub wget that never answers
requests() { pgrep -f "$W/bin/wget" | wc -l; }            # requests in flight
none_left() { [ -z "$(pgrep -f "$W/")" ]; }               # no shell of the copy, no stub
lib() { # lib <shell code> : run it inside nexus.sh's functions; the poll timer is a recorder
  ( set +u; . $W/lib.sh; arm() { echo "arm $1" >> $W/calls; }; eval "$1" ) > $W/out 2>&1
}
NOW=$(date +%s)
key() { echo "handle_event $(date +%s) 0 1 $1 1"; }   # a key-down event made this second
UP=103; DOWN=108; RIGHT=106; F1=158; F2=29; F4=102

# ---- 1. the switch is off: the old flow ----
conf; reset
lib "$(key $UP); cycle"
check "STREAM off: a key goes to /key/<name> and its answer is drawn" sh -c "grep -q 'wget http://bridge.test/x/key/up' $W/calls && grep -q 'drawn FRAME1' $W/calls"
check "STREAM off: nothing is sent to /press, /wake or /stream.png" sh -c "! grep -q -e /press/ -e /wake -e stream.png $W/calls"
check "STREAM off: the scheduled round fetches the screen itself" has "screen.png?fresh=1&etag=$(sum FRAME1)"
check "STREAM off: no main-loop beat file" [ ! -e $W/tmp/nexus.beat ]
conf "STREAM=0"; reset
lib "$(key $UP)"
check "STREAM=0 is the old flow too" sh -c "grep -q '/key/up' $W/calls && ! grep -q /press/ $W/calls"

# ---- 2. presses ----
conf "STREAM=1"; reset
lib "$(key $UP)"
check "a press is one request to /press/<name>" seq_is wget "wget http://bridge.test/x/press/up|"
check "a press draws nothing and fetches no picture" sh -c "! grep -q -e eips -e screen.png -e /key/ $W/calls"
check "a delivered press is not reported as lost" sh -c "! grep -q 'not delivered' $W/dir/nexus.log"

reset; touch $W/press_slow
lib "$(key $UP); $(key $RIGHT); $(key $DOWN)"
check "three presses: each is sent only after the one before was handed over" seq_is "press/\|done" \
  "wget http://bridge.test/x/press/up|done up|wget http://bridge.test/x/press/right|done right|wget http://bridge.test/x/press/down|done down|"

reset; touch $W/press_hang
t0=$(ms); lib "$(key $DOWN)"; t1=$(ms)
check "a press that gets no answer is given up after about 0.3 s (took $(( t1 - t0 )) ms)" [ $(( t1 - t0 )) -ge 280 -a $(( t1 - t0 )) -le 900 ]
check "the lost press is sent exactly once: no second try" [ "$(count /press/down)" = 1 ]
check "the lost press is reported as dropped" logged "key down not delivered, dropped"
check "the request that hung is gone" nohung
rm -f $W/press_hang
lib "$(key $RIGHT)"
check "the press after a lost one is sent normally and the lost one never follows" seq_is press/ \
  "wget http://bridge.test/x/press/down|wget http://bridge.test/x/press/right|"

reset; touch $W/press_fail
t0=$(ms); lib "$(key $UP); $(key $UP)"; t1=$(ms)
check "no connection (the request fails at once): one try per press, no waiting (took $(( t1 - t0 )) ms)" [ "$(count /press/up)" = 2 -a $(( t1 - t0 )) -lt 600 ]

reset
lib "handle_event $(( NOW - 5 )) 0 1 $UP 1"
check "a press that waited for its turn for seconds is dropped, not sent late" sh -c "! grep -q /press/ $W/calls 2>/dev/null && grep -q 'key up dropped: pressed' $W/dir/nexus.log"

conf "STREAM=1" "LONG_PRESS=1"; reset
lib "handle_event 0 0 1 $UP 0; handle_event $(date +%s) 0 1 194 1; handle_event $(date +%s) 300000 1 194 0; kill \$HOLDT 2>/dev/null"
check "centre key, short press: /press/select on release" seq_is press/ "wget http://bridge.test/x/press/select|"
reset
lib "handle_event 0 0 1 $UP 0; handle_event $(date +%s) 0 1 194 1; handle_event 0 0 hold \$SELGEN 0"
check "centre key, held: /press/select-long" seq_is press/ "wget http://bridge.test/x/press/select-long|"
conf "STREAM=1"

# ---- 3. the radio is off ----
gate() { # gate <shell code> : like lib, with the picture loop replaced by a recorder
  ( set +u; . $W/lib.sh; arm() { echo "arm $1" >> $W/calls; }; stream_start() { echo "stream_start $1" >> $W/calls; }
    WIFI_WAIT=3; eval "$1" ) > $W/out 2>&1
}
reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off; sum FRAME1 > $W/tmp/nexus.last.md5
gate "$(key $UP); $(key $UP); $(key $RIGHT); handle_event $(( $(date +%s) + 2 )) 0 1 $DOWN 1"
check "radio off: the press switches the radio on and shows the connecting label" order "wirelessEnable 1" "Connecting..."
check "radio off: that press is not sent" hasnt "/press/up"
check "radio off: presses made until the connection is up are dropped as well" hasnt "/press/right"
check "radio off: exactly one wake message, after the radio is on" sh -c "[ \"\$(grep -c 'wget http://bridge.test/x/wake\$' $W/calls)\" = 1 ] && grep -n -e 'wirelessEnable 1' -e /wake $W/calls | head -2 | tail -1 | grep -q /wake"
check "radio off: the picture loop starts again with a full redraw" has "stream_start full"
check "radio off: a press made after the connection is up is sent" seq_is press/ "wget http://bridge.test/x/press/down|"
check "radio off: the log says what happened to the presses" sh -c "grep -q 'key up only wakes the panel' $W/dir/nexus.log && grep -q 'key right dropped: pressed while the radio connected' $W/dir/nexus.log"
check "radio off: the marker is gone, the poll timer is armed" sh -c "[ ! -e $W/tmp/nexus.radio_off ] && grep -q 'arm 20' $W/calls"

# F1 / F4 judge the photo on the panel: with the radio off the press is sent once the radio is up (the owner's one
# exception to "a press made with the radio off is dropped", 2026-11-23), and the screensaver stays: no wake message
for kn in f1 f4; do
  reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off; sum FRAME1 > $W/tmp/nexus.last.md5
  if [ $kn = f1 ]; then kc=$F1; else kc=$F4; fi
  gate "$(key $kc); $(key $kc); handle_event $(( $(date +%s) + 2 )) 0 1 $DOWN 1"
  check "radio off, $kn: the radio comes up and the picture loop starts again with a full redraw" sh -c "grep -q 'wirelessEnable 1' $W/calls && grep -q 'stream_start full' $W/calls"
  check "radio off, $kn: no wake message, the screensaver stays" hasnt "/wake"
  check "radio off, $kn: the press is sent once, marked as a photo key, after the radio is on and before the picture loop" sh -c "[ \"\$(grep -c 'press/$kn' $W/calls)\" = 1 ] && grep -n -e 'wirelessEnable 1' -e 'press/$kn?saver=1\$' -e stream_start $W/calls | cut -d: -f2- | tr '\n' '|' | grep -q '^lipc-set com.lab126.cmd wirelessEnable 1|wget http://bridge.test/x/press/$kn?saver=1|stream_start full|\$'"
  check "radio off, $kn: a second $kn made while the radio connected is dropped, a later key is sent as usual" seq_is press/ "wget http://bridge.test/x/press/$kn?saver=1|wget http://bridge.test/x/press/down|"
  check "radio off, $kn: the log says so" sh -c "grep -q 'key $kn is a photo key, it is sent once the radio is up' $W/dir/nexus.log && grep -q 'key $kn dropped: pressed while the radio connected' $W/dir/nexus.log"
done
reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off; touch $W/press_hang
t0=$(ms); gate "$(key $F4)"; t1=$(ms)
check "radio off, f4 gets no answer: one try, given up after about 1 s, never sent again (took $(( t1 - t0 )) ms)" sh -c "[ \"\$(grep -c press/f4 $W/calls)\" = 1 ] && grep -q 'key f4 not delivered, dropped' $W/dir/nexus.log && [ $(( t1 - t0 )) -ge 950 ] && [ $(( t1 - t0 )) -le 2500 ]"
check "radio off, f4 gets no answer: the picture loop starts all the same" has "stream_start full"
check "radio off, f4 gets no answer: the request that hung is gone" nohung
rm -f $W/press_hang
reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off
gate "FAILS=1; $(key $F4)"
check "radio off, f4 after a picture that did not arrive: not sent (the panel may show an older photo), no wake message" sh -c "! grep -q -e /press/ -e /wake $W/calls && grep -q 'key f4 dropped: the last picture did not arrive' $W/dir/nexus.log && grep -q 'stream_start full' $W/calls"
reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off; touch $W/no_wifi
gate "$(key $F4)"
check "radio off, f4 and Wi-Fi does not come back: nothing is sent" sh -c "! grep -q -e /press/ -e /wake $W/calls"
rm -f $W/no_wifi

reset; echo $(( NOW + 600 )) > $W/tmp/nexus.radio_off; touch $W/no_wifi
gate "$(key $F2)"
check "radio off and Wi-Fi does not come back: no wake message, no press, says so on the screen" sh -c "! grep -q -e /wake -e /press/ $W/calls && grep -q 'No Wi-Fi yet' $W/calls"
check "radio off and Wi-Fi does not come back: the picture loop is started anyway (it retries by itself)" has "stream_start full"

# ---- 4. the picture loop ----
loop() { # loop <tenths> <shell code run while the loop is up> : stream_loop for that long at most, then stopped
  ( set +u; . $W/lib.sh; echo $(( $(date +%s) + 300 )) > $W/tmp/nexus.beat
    stream_start $LOOPARG; eval "$2"; i=0; while [ $i -lt $1 ] && [ ! -f $W/enough ]; do $RS 0.1; i=$(( i + 1 )); done; stream_stop ) > $W/out 2>&1
  rm -f $W/enough
}
LOOPARG=
reset; sum FRAME1 > $W/tmp/nexus.last.md5
loop 12 "$RS 0.2; frame FRAME2"
check "a newer frame is drawn the moment the held request is answered" has "drawn FRAME2"
check "the first request names the frame on the panel" has "stream.png?have=$(sum FRAME1)&wait=25000"
check "after the draw the next request names the new frame" has "stream.png?have=$(sum FRAME2)&wait=25000"
check "a frame from the stream is a partial update unless the bridge hints full" has "eips -g $W/tmp/nexus.png = FRAME2"
check "the held request is cut off 5 s after its wait" has "limit 30"
check "a drawn frame stamps the watchdog file" [ -s $W/tmp/nexus.last_ok ]

reset; sum FRAME1 > $W/tmp/nexus.last.md5; echo 0.4 > $W/draw_s
loop 20 "$RS 0.15; frame FRAME2; $RS 0.15; frame FRAME3; $RS 0.1; frame FRAME4"
check "frames that arrive during a draw: only the newest is drawn next (2 then 4, never 3)" seq_is drawn "drawn FRAME2|drawn FRAME4|"

reset; sum FRAME1 > $W/tmp/nexus.last.md5
loop 10 ":"
check "a hold that ends without a newer frame draws nothing" hasnt "eips"
check "a hold that ends without a newer frame is a success: the watchdog stamp is written" [ -s $W/tmp/nexus.last_ok ]
check "a hold that ends without a newer frame: the same request again" [ "$(count "stream.png?have=$(sum FRAME1)")" -ge 2 ]
check "a hold that ends without a newer frame: nothing is logged" [ ! -s $W/dir/nexus.log ]

reset; sum FRAME1 > $W/tmp/nexus.last.md5
loop 8 "echo 1 > $W/tmp/nexus.beat"
check "main loop stuck (its beat ran out): the picture loop no longer stamps the watchdog file" [ ! -e $W/tmp/nexus.last_ok ]

reset; sum FRAME1 > $W/tmp/nexus.last.md5; touch $W/hint_full
loop 10 "$RS 0.1; frame FRAME2"
check "the bridge's hint still decides a full refresh" has "eips -f -g $W/tmp/nexus.png = FRAME2"

conf "STREAM=1" "FULL_REFRESH_EVERY=2"; reset; sum FRAME1 > $W/tmp/nexus.last.md5
loop 15 "$RS 0.1; frame FRAME2; $RS 0.3; frame FRAME3; $RS 0.3; frame FRAME4"
check "FULL_REFRESH_EVERY still counts frames" seq_is "eips.*-g" "eips -g $W/tmp/nexus.png = FRAME2|eips -f -g $W/tmp/nexus.png = FRAME3|eips -g $W/tmp/nexus.png = FRAME4|"
conf "STREAM=1"

reset; sum FRAME1 > $W/tmp/nexus.last.md5; touch $W/stream_fail
loop 40 "waitfor 30 grep -q 'sleep 8' $W/calls; frame FRAME2; rm -f $W/stream_fail; waitfor 20 grep -q 'drawn FRAME2' $W/calls; touch $W/enough"
check "bridge unreachable: the pauses between tries grow (1, 2, 4, 8 s) and then stay at 10 s" sh -c "grep '^sleep' $W/calls | tr '\n' '|' | grep -q -E '^sleep 1\|sleep 2\|sleep 4\|sleep 8\|(sleep 10\|)*\$'"
check "bridge unreachable: said on the screen at the third failure, once" [ "$(count 'bridge unreachable')" = 1 ]
check "bridge unreachable: one log line, not one per try" [ "$(grep -c 'picture request failed' $W/dir/nexus.log)" = 1 ]
check "bridge back: the next request names no frame, so the bridge sends a complete one" has "stream.png?have=&wait=25000"
check "bridge back: drawn with a full refresh" has "eips -f -g $W/tmp/nexus.png = FRAME2"
check "bridge back: logged with the number of failed tries" logged "pictures are back after $(grep -c '^sleep' $W/calls) failed tries"
check "bridge back: a request that names no frame gets the usual short limit" has "limit 15"
reset; sum FRAME1 > $W/tmp/nexus.last.md5; touch $W/stream_fail
loop 6 ":"
check "bridge unreachable: no watchdog stamp while it lasts" [ ! -e $W/tmp/nexus.last_ok ]

conf "STREAM=1" "STREAM_WAIT=1"; reset; sum FRAME1 > $W/tmp/nexus.last.md5; touch $W/stream_hang
t0=$(ms)
loop 90 "waitfor 80 grep -q 'picture request failed' $W/dir/nexus.log; touch $W/enough"
t1=$(ms)
check "a dead connection (no answer at all): the request is cut off at wait + 5 s (STREAM_WAIT=1: $(( t1 - t0 )) ms)" sh -c "grep -q 'limit 6' $W/calls && grep -q 'picture request failed' $W/dir/nexus.log && [ $(( t1 - t0 )) -ge 5500 ] && [ $(( t1 - t0 )) -le 8500 ]"
check "a dead connection: the request that hung is gone" nohung
conf "STREAM=1"

reset; sum FRAME1 > $W/tmp/nexus.last.md5; echo 200 > $W/hold
t0=$(ms); loop 3 ":"; t1=$(ms)
# the limit leaves room for stream_stop's look through /proc for the held request, about a second on a box with many processes
check "stopping the loop while a request is held open: gone at once ($(( t1 - t0 )) ms)" [ $(( t1 - t0 )) -lt 3000 ]
check "stopping the loop while a request is held open: the request is gone too" [ "$(requests)" = 0 ]

# The Kindle's own shell (busybox 1.7.2) did not end the loop on TERM (seen on the device 2026-11-23, the main loop
# then waited for ever). A loop that is deaf to TERM stands in for it here: stream_stop must not wait for it.
reset; rm -f $W/deaf
t0=$(ms)
( set +u; . $W/lib.sh; ( trap '' TERM; while :; do $RS 0.2; done ) & SPID=$!; D=$SPID; stream_stop; kill -0 $D 2>/dev/null && echo alive > $W/deaf ) > $W/out 2>&1
t1=$(ms)
check "a picture loop that does not react to the stop signal is killed, nobody waits for it ($(( t1 - t0 )) ms)" [ $(( t1 - t0 )) -lt 3000 -a ! -e $W/deaf ]

reset; sum FRAME1 > $W/tmp/nexus.last.md5; echo 0.6 > $W/draw_s
loop 3 "$RS 0.1; frame FRAME2"
check "stopping the loop during a draw: the draw is finished first" has "drawn FRAME2"

reset; sum FRAME1 > $W/tmp/nexus.last.md5; touch $W/tmp/nexus.drawing
loop 6 ":"
check "a draw that was cut short is redone in full when the loop starts" sh -c "grep -q 'stream.png?have=&' $W/calls && grep -q 'eips -f -g $W/tmp/nexus.png = FRAME1' $W/calls && [ ! -e $W/tmp/nexus.drawing ]"

# ---- 5. the scheduled round with STREAM=1 ----
reset
gate "cycle"
check "awake round: the main loop fetches no picture, it only makes sure the picture loop runs" sh -c "! grep -q screen.png $W/calls && grep -q '^stream_start' $W/calls && grep -q /schedule $W/calls"
( set +u; . $W/lib.sh; stream_start() { :; }; cycle; kill $TIMER ) > $W/out 2>&1   # the real arm: it writes the beat
check "awake round: the main loop's beat reaches past its next round (20 s) by 120 s" sh -c "b=\$(cat $W/tmp/nexus.beat); [ \$b -ge $(( NOW + 140 )) ] && [ \$b -le $(( $(date +%s) + 140 )) ]"
touch $W/doze; rm -f $W/calls
( set +u; . $W/lib.sh; arm() { echo "arm $1" >> $W/calls; }; stream_stop() { echo stream_stop >> $W/calls; }; stream_start() { echo "stream_start $1" >> $W/calls; }; cycle ) > $W/out 2>&1
check "radio-off window: picture loop stopped, then full frame, badge download, radio off" sh -c "grep -n -e stream_stop -e 'eips -f -g' -e 'connecting=1' -e 'wirelessEnable 0' $W/calls | cut -d: -f2- | tr '\n' '|' | grep -q '^stream_stop|eips -f -g.*|wget.*connecting=1.*|lipc-set com.lab126.cmd wirelessEnable 0|\$'"
check "radio-off window: the picture loop stays stopped, the window stamp is written" sh -c "! grep -q stream_start $W/calls && [ -s $W/tmp/nexus.window ] && [ -e $W/tmp/nexus.radio_off ]"
rm -f $W/calls $W/doze
gate "cycle"
check "end of the window: radio on, then the picture loop with a full redraw" order "wirelessEnable 1" "stream_start full"
# the same frame is already on the panel, drawn completely with a full refresh: no second flash before the radio goes off
DOZE='arm() { echo "arm $1" >> $W/calls; }; stream_stop() { echo stream_stop >> $W/calls; }; stream_start() { echo "stream_start $1" >> $W/calls; }; cycle'
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "radio-off window, frame already drawn in full: asked with its etag, not drawn again, radio off" sh -c "grep -q 'screen.png?fresh=1&etag=$(sum FRAME1)' $W/calls && ! grep -q 'eips .*-g $W/tmp/nexus.png' $W/calls && grep -q 'wirelessEnable 0' $W/calls"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5; frame FRAME2
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "radio-off window, the screen changed meanwhile: the new frame is drawn in full" sh -c "grep -q 'eips -f -g $W/tmp/nexus.png = FRAME2' $W/calls && grep -q 'wirelessEnable 0' $W/calls"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "radio-off window, last draw was a partial one: drawn again in full" has "eips -f -g $W/tmp/nexus.png = FRAME1"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5; touch $W/tmp/nexus.drawing
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "radio-off window, a draw was cut short: drawn again in full" has "eips -f -g $W/tmp/nexus.png = FRAME1"
conf "STREAM=0"; reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "radio-off window, STREAM=0: always drawn again in full, as before" has "eips -f -g $W/tmp/nexus.png = FRAME1"
# the screensaver photo changes only on request: the timed wake that goes straight into the next window asks for it
conf "STREAM=1"; reset; touch $W/doze; echo $(( NOW - 1 )) > $W/tmp/nexus.radio_off; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5; frame FRAME2
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "timed wake, next window: radio on, schedule, ONE picture request that asks for the next photo" sh -c "grep -n -e 'wirelessEnable 1' -e /schedule -e 'screen.png?fresh' $W/calls | cut -d: -f2- | tr '\n' '|' | grep -q '^lipc-set com.lab126.cmd wirelessEnable 1|wget http://bridge.test/x/schedule[^|]*|wget http://bridge.test/x/screen.png?fresh=1&next=1|\$'"
check "timed wake, next window: exactly one draw, in full, of the new photo" seq_is "eips.*-g" "eips -f -g $W/tmp/nexus.png = FRAME2|"
check "timed wake, next window: the picture loop is not started, no press, no wake message" sh -c "! grep -q -e stream_start -e stream.png -e /press/ -e /wake $W/calls"
check "timed wake, next window: then the badge and the radio off again" sh -c "grep -n -e 'eips -f -g' -e 'connecting=1' -e 'wirelessEnable 0' $W/calls | cut -d: -f2- | tr '\n' '|' | grep -q '^eips -f -g.*|wget.*connecting=1.*|lipc-set com.lab126.cmd wirelessEnable 0|\$' && [ -e $W/tmp/nexus.radio_off ]"
reset; touch $W/doze; echo $(( NOW - 1 )) > $W/tmp/nexus.radio_off; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "timed wake at night (the bridge keeps the photo): still one request with next=1 and one full draw" sh -c "[ \"\$(grep -c 'screen.png?fresh' $W/calls)\" = 1 ] && grep -q 'fresh=1&next=1' $W/calls && [ \"\$(grep -c 'eips -f -g' $W/calls)\" = 1 ]"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5; sum FRAME1 > $W/tmp/nexus.full.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "first window after the screensaver started: the next photo is NOT asked for" sh -c "grep -q 'screen.png?fresh=1' $W/calls && ! grep -q 'next=1' $W/calls"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "first window, last draw was a partial one: drawn again in full, still without asking for the next photo" sh -c "grep -q 'eips -f -g' $W/calls && ! grep -q 'next=1' $W/calls"
reset; echo $(( NOW - 1 )) > $W/tmp/nexus.radio_off
gate "cycle"
check "timed wake, the panel is in use again (awake): the picture loop as before, the next photo is not asked for" sh -c "grep -q 'stream_start full' $W/calls && ! grep -q -e 'next=1' -e screen.png $W/calls"
conf "STREAM=0"; reset; touch $W/doze; echo $(( NOW - 1 )) > $W/tmp/nexus.radio_off; sum FRAME1 > $W/tmp/nexus.last.md5; frame FRAME2
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "timed wake, STREAM=0: the same one request with next=1 and one full draw" sh -c "[ \"\$(grep -c 'screen.png?fresh' $W/calls)\" = 1 ] && grep -q 'screen.png?fresh=1&next=1' $W/calls && [ \"\$(grep 'eips.*-g' $W/calls | tr '\n' '|')\" = 'eips -f -g $W/tmp/nexus.png = FRAME2|' ]"
reset; touch $W/doze; sum FRAME1 > $W/tmp/nexus.last.md5
( set +u; . $W/lib.sh; eval "$DOZE" ) > $W/out 2>&1
check "first window, STREAM=0: the next photo is not asked for" sh -c "grep -q 'screen.png?fresh=1' $W/calls && ! grep -q 'next=1' $W/calls"
conf "STREAM=1"; reset
lib 'echo FRAME1 > $SHOT.tmp; draw aaa full; cat $FULLTAG; echo FRAME1 > $SHOT.tmp; draw bbb; [ -e $FULLTAG ] || echo gone'
check "a finished full draw is remembered, a partial draw forgets it" sh -c "[ \"\$(tr '\n' '|' < $W/out)\" = 'aaa|gone|' ]"
reset; echo $(( NOW - 1 )) > $W/tmp/nexus.radio_off
gate "cycle; $(key $RIGHT); handle_event $(( $(date +%s) + 2 )) 0 1 $DOWN 1"
check "end of the window: a press made while the radio connected is dropped, a later one is sent" sh -c "grep -q 'key right dropped: pressed while the radio connected' $W/dir/nexus.log && [ \"\$(grep press/ $W/calls | tr '\n' '|')\" = 'wget http://bridge.test/x/press/down|' ]"
check "end of the window: no wake message (no press started it)" hasnt "/wake"
touch $W/doze; rm -f $W/calls; date +%s > $W/tmp/nexus.last_key
( set +u; . $W/lib.sh; arm() { echo "arm $1" >> $W/calls; }; stream_stop() { echo stream_stop >> $W/calls; }; stream_start() { echo "stream_start $1" >> $W/calls; }; cycle ) > $W/out 2>&1
check "a key within KEY_HOLD keeps the radio on and the picture loop running" sh -c "! grep -q -e stream_stop -e 'wirelessEnable 0' $W/calls && grep -q '^stream_start' $W/calls"

# ---- 6. the whole script: start, keys, stop, restart ----
# The copy differs from the original in paths only; nexus_pids is narrowed to this copy so that the stop under
# test can never touch another "nexus.sh run" on this box.
sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
    -e "s#/dev/input/event#$W/dev/event#g" -e "s#^GOV=.*#GOV=$W/gov#" -e "s#\\*\"nexus.sh run \")#*\"$W/dir/nexus.sh run \")#" \
    $HERE/../nexus.sh > $W/dir/nexus.sh
mkfifo $W/dev/event0 $W/dev/event1
exec 7<>$W/dev/event0 8<>$W/dev/event1   # keep both "devices" open, 7 is where the test presses keys
oct() { printf '\\%03o' "$1"; }
le4() { printf "$(oct $(( $1 & 255 )))$(oct $(( ($1 >> 8) & 255 )))$(oct $(( ($1 >> 16) & 255 )))$(oct $(( ($1 >> 24) & 255 )))"; }
press() { # press <code> : one 16-byte input_event (key down, now) in a single write
  { le4 $(date +%s); le4 0; printf "$(oct 1)$(oct 0)$(oct $1)$(oct 0)"; le4 1; } > $W/ev.bin
  cat $W/ev.bin >&7
}
conf "STREAM=1" "RADIO_DUTY=0"; reset; touch $W/sleep_real; echo 200 > $W/hold
/bin/sh $W/dir/nexus.sh start > $W/out 2>&1
check "start: running, the picture loop holds a request open" waitfor 50 sh -c "grep -q 'stream.png?have=$(sum FRAME1)' $W/calls"
check "start: the picture loop is recorded with the two readers" sh -c "[ \"\$(wc -w < $W/dir/children.pid)\" = 3 ]"
press $RIGHT
check "a key from the input device goes out as /press/right" waitfor 30 has "/press/right"
frame FRAME2
check "the picture the bridge then has is drawn by the picture loop" waitfor 30 has "drawn FRAME2"
check "status names the flow" sh -c "/bin/sh $W/dir/nexus.sh status | grep -qx 'stream=1'"
/bin/sh $W/dir/nexus.sh stop > $W/out 2>&1
check "stop: no process of the client is left (main loop, readers, picture loop, held request)" none_left
check "stop: its state files are gone" sh -c "[ ! -e $W/tmp/nexus.beat ] && [ ! -e $W/tmp/nexus.last_ok ] && [ ! -e $W/dir/children.pid ]"
/bin/sh $W/dir/nexus.sh start > $W/out 2>&1
waitfor 50 sh -c "[ \"\$(grep -c 'stream.png' $W/calls)\" -ge 2 ]"
/bin/sh $W/dir/nexus.sh restart > $W/out 2>&1
one_client() { [ "$(pgrep -f "of=$W/tmp/nexus.ev" | wc -l)" = 2 ] && [ "$(requests)" = 1 ] && kill -0 $(cat $W/dir/nexus.pid); }
check "restart: one client again (two readers, one held request)" waitfor 50 one_client
# A client that was killed outright (no trap ran) leaves its held request behind; stop must still find it, and must
# not take a shell with it that only quotes such a request (an operator's command line).
/bin/sh -c "$RS 20; : wget -q -O - http://bridge.test/x/hint" &
bystander=$!
for p in $(pgrep -f "$W/dir/nexus.sh run"); do kill -9 $p 2>/dev/null; done
check "a client killed outright leaves its held request behind" sh -c "[ \"\$(pgrep -f '$W/bin/wget' | wc -l)\" -ge 1 ]"
/bin/sh $W/dir/nexus.sh stop > $W/out 2>&1
check "stop after a kill: nothing left, not even the held request" none_left
check "stop leaves a shell alone that only quotes a request" kill -0 $bystander
kill $bystander 2>/dev/null
exec 7>&- 8>&-

[ $fail = 0 ] && echo "all stream checks passed"
exit $fail
