#!/bin/sh
# The battery saver's "connecting" badge and label (kindle/nexus.sh fetch_badge / show_connecting / radio_up / cycle),
# runnable on any box with a POSIX sh:  sh kindle/tests/connecting-test.sh
# nexus.sh's functions are loaded from a copy whose paths point into a temp dir; eips, lipc-*, wget, timeout and sleep
# are PATH stubs that record what the client did.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf $W' EXIT
mkdir -p $W/dir $W/tmp $W/bin
printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n' > $W/dir/config
# everything before the command dispatch, with the Kindle's paths moved into the temp dir
sed -n '/^case "\$1" in/q;p' $HERE/../nexus.sh \
  | sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
  > $W/lib.sh
# stubs: eips logs its arguments; lipc-set-prop logs; the radio associates unless $W/no_wifi exists
cat > $W/bin/eips <<STUB
#!/bin/sh
echo "eips \$*" >> $W/calls
exit 0
STUB
printf '#!/bin/sh\necho "lipc-set $*" >> %s/calls\n' $W > $W/bin/lipc-set-prop
printf '#!/bin/sh\n[ -f %s/no_wifi ] && echo PENDING || echo CONNECTED\n' $W > $W/bin/lipc-get-prop
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\nexit 0\n' > $W/bin/sleep
# wget -q -O <file|-> <url>: the bridge. /schedule says doze for 120 s, frames are the text in $W/frame, the badge
# variant fails while $W/badge_fail exists.
cat > $W/bin/wget <<STUB
#!/bin/sh
out=\$3; url=\$4
echo "wget \$url" >> $W/calls
case "\$url" in
  */schedule*) body="20 doze \$(( \$(date +%s) + 120 )) 120 0 12:00";;
  *connecting=1*) [ -f $W/badge_fail ] && exit 1; body="BADGE";;
  */screen.png*) body=\$(cat $W/frame);;
  */hint) body=full;;
  *) body=ok;;
esac
if [ "\$out" = - ]; then echo "\$body"; else echo "\$body" > "\$out"; fi
STUB
echo FRAME1 > $W/frame
chmod +x $W/bin/*
fail=0
check() { # check <name> <command…>
  name=$1; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; echo "     calls: $(tr '\n' '|' < $W/calls 2>/dev/null)"; fail=1; fi
}
has() { grep -q -- "$1" $W/calls 2>/dev/null; }
hasnt() { ! has "$1"; }
order() { # order <first> <second> : both logged, first before second
  a=$(grep -n -- "$1" $W/calls | head -1 | cut -d: -f1); b=$(grep -n -- "$2" $W/calls | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
CONN=$W/tmp/nexus.conn.png
up() { # up <why> : radio_up with the radio switched off before, frame "e1" on the panel
  rm -f $W/calls; touch $W/tmp/nexus.radio_off; echo e1 > $W/tmp/nexus.last.md5
  ( . $W/lib.sh; WIFI_WAIT=3; radio_up "$1" )
}

up key
check "key while the radio is off: the text label in the middle, no image draw" sh -c "grep -qx 'eips 18 20 Connecting...' $W/calls && ! grep -q 'eips -g' $W/calls"
check "key: the radio is switched on before the label is drawn" order "wirelessEnable 1" "Connecting..."
check "key: the radio-off marker is gone" [ ! -e $W/tmp/nexus.radio_off ]

rm -f $W/calls; touch $W/tmp/nexus.radio_off; ( . $W/lib.sh; WIFI_WAIT=3; CONNECTING_COL=1; CONNECTING_ROW=38; radio_up key )
check "CONNECTING_COL/ROW move the label" has "eips 1 38 Connecting..."

up poll
check "scheduled wake (nobody waiting): nothing drawn" hasnt "eips"

rm -f $W/calls $W/tmp/nexus.radio_off; ( . $W/lib.sh; radio_up key )
check "key while the radio is on: nothing drawn" hasnt "eips"

touch $W/no_wifi; up key; rm -f $W/no_wifi
check "Wi-Fi does not come back: says so on the screen" has "No Wi-Fi yet"

# ---- the badge picture ----
echo BADGE > $CONN; echo e1 > $W/tmp/nexus.conn.etag
up key
check "badge for the frame on the panel: drawn with a partial update (eips -g, no -f)" grep -qx "eips -g $CONN" $W/calls
check "badge: no text label on top" hasnt "Connecting..."
check "badge: the DRAWING marker is gone afterwards" [ ! -e $W/tmp/nexus.drawing ]
up poll
check "badge, scheduled wake (nobody waiting): nothing drawn" hasnt "eips"

echo e0 > $W/tmp/nexus.conn.etag
up key
check "stale badge (another frame): the text label, no image draw" sh -c "grep -qx 'eips 18 20 Connecting...' $W/calls && ! grep -q 'eips -g' $W/calls"
rm -f $CONN; echo e1 > $W/tmp/nexus.conn.etag
up key
check "no badge file: the text label" sh -c "grep -qx 'eips 18 20 Connecting...' $W/calls && ! grep -q 'eips -g' $W/calls"

rm -f $W/calls $CONN $W/tmp/nexus.conn.etag; echo e1 > $W/tmp/nexus.last.md5
( . $W/lib.sh; fetch_badge; fetch_badge )
check "fetch_badge: the variant of the frame on the panel" has "wget http://bridge.test/x/screen.png?connecting=1&of=e1"
check "fetch_badge: once per ETag" [ "$(grep -c 'connecting=1' $W/calls)" = 1 ]
check "fetch_badge: file + its ETag stored" sh -c "[ -s $CONN ] && [ \"\$(cat $W/tmp/nexus.conn.etag)\" = e1 ]"
echo e2 > $W/tmp/nexus.last.md5; ( . $W/lib.sh; fetch_badge )
check "fetch_badge: a new frame ETag downloads again" has "connecting=1&of=e2"
rm -f $W/calls; echo e3 > $W/tmp/nexus.last.md5; touch $W/badge_fail
( . $W/lib.sh; fetch_badge ) && r=0 || r=1; rm -f $W/badge_fail
check "fetch_badge: a failed download leaves no badge (text fallback) and says so" sh -c "[ $r = 1 ] && [ ! -e $CONN ] && [ ! -e $W/tmp/nexus.conn.etag ] && grep -q 'text label will be used' $W/dir/nexus.log"

# ---- the doze path: full frame, then the badge download, then the radio goes off ----
rm -f $W/calls $CONN $W/tmp/nexus.conn.etag $W/tmp/nexus.last.md5 $W/tmp/nexus.radio_off
( set +u; . $W/lib.sh; cycle; cycle ) > /dev/null 2>&1
e=$(echo FRAME1 | md5sum | cut -c1-32)
check "doze: the badge variant of the frame just drawn" has "connecting=1&of=$e"
check "doze: drawn in full, then the badge download, then the radio off" sh -c "grep -n -e 'eips -f -g' -e 'connecting=1' -e 'wirelessEnable 0' $W/calls | head -3 | cut -d: -f2- | tr '\n' '|' | grep -q '^eips -f -g.*|wget.*connecting=1.*|lipc-set com.lab126.cmd wirelessEnable 0|\$'"
check "doze: two windows on the same frame download the badge once" [ "$(grep -c 'connecting=1' $W/calls)" = 1 ]
check "doze: two windows, the radio went off twice" [ "$(grep -c 'wirelessEnable 0' $W/calls)" = 2 ]
echo FRAME2 > $W/frame; ( set +u; . $W/lib.sh; cycle ) > /dev/null 2>&1
check "doze: a new frame downloads its badge" has "connecting=1&of=$(echo FRAME2 | md5sum | cut -c1-32)"


[ $fail = 0 ] && echo "all connecting checks passed"
exit $fail
