#!/bin/sh
# The "connecting" frame of the battery saver (kindle/nexus.sh prepare_connecting / show_connecting / radio_up),
# runnable on any box with a POSIX sh:  sh kindle/tests/connecting-test.sh
# nexus.sh's functions are loaded from a copy whose paths point into a temp dir; eips, lipc-*, wget, timeout and
# sleep are PATH stubs that record what the client did.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf $W' EXIT
mkdir -p $W/dir $W/tmp $W/bin
printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n' > $W/dir/config
# everything before the command dispatch, with the Kindle's paths moved into the temp dir
sed -n '/^case "\$1" in/q;p' $HERE/../nexus.sh \
  | sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
  > $W/lib.sh
# stubs: eips and lipc-set-prop log their arguments; the radio associates unless $W/no_wifi exists;
# the bridge answers per $W/bridge: "png" (a frame), "empty" (unchanged) or "404"
printf '#!/bin/sh\necho "eips $*" >> %s/calls\n' $W > $W/bin/eips
printf '#!/bin/sh\necho "lipc-set $*" >> %s/calls\n' $W > $W/bin/lipc-set-prop
printf '#!/bin/sh\n[ -f %s/no_wifi ] && echo PENDING || echo CONNECTED\n' $W > $W/bin/lipc-get-prop
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\nexit 0\n' > $W/bin/sleep
cat > $W/bin/wget <<STUB
#!/bin/sh
out=\$3; url=\$4
echo "wget \$url" >> $W/calls
case \$(cat $W/bridge) in
  png) printf 'FRAME-%s' "\$url" > "\$out";;
  empty) : > "\$out";;
  *) exit 1;;
esac
STUB
chmod +x $W/bin/*
CONN=$W/tmp/nexus.connecting.png
fail=0
check() { # check <name> <condition…>
  name=$1; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; echo "     calls: $(tr '\n' '|' < $W/calls 2>/dev/null)"; fail=1; fi
}
has() { grep -q -- "$1" $W/calls 2>/dev/null; }
order() { # order <first> <second> : both logged, first before second
  a=$(grep -n -- "$1" $W/calls | head -1 | cut -d: -f1); b=$(grep -n -- "$2" $W/calls | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
t() { rm -f $W/calls $W/no_wifi; echo "$1" > $W/bridge; ( . $W/lib.sh; WIFI_WAIT=3; shift; "$@" ); }

t png prepare_connecting
check "prepare: fetches the connecting frame and keeps it" [ -s $CONN ] && check "prepare: remembers its md5" [ -s $CONN.md5 ]
sum=$(cat $CONN.md5)
t empty prepare_connecting
check "prepare: unchanged frame (empty answer) keeps the stored one" [ "$(cat $CONN.md5)" = "$sum" ]
check "prepare: asks with the stored frame's etag" has "connecting.png?etag=$sum"
t 404 prepare_connecting
check "prepare: no badge on this screen (404) -> nothing stored" [ ! -e $CONN ]

t png prepare_connecting
touch $W/tmp/nexus.radio_off; t png radio_up key
check "key while the radio is off: draws the stored frame" has "eips -g $CONN"
check "key: the radio is switched on before the frame is drawn" order "wirelessEnable 1" "eips -g"
check "key: the radio-off marker is gone" [ ! -e $W/tmp/nexus.radio_off ]

rm -f $CONN; touch $W/tmp/nexus.radio_off; t png radio_up key
check "key without a stored frame: a text line instead" has "eips 1 38 Connecting..."

t png prepare_connecting; touch $W/tmp/nexus.radio_off; t png radio_up poll
check "scheduled wake (nobody waiting): nothing drawn" sh -c "! grep -q eips $W/calls"

t png radio_up key
check "key while the radio is on: nothing drawn" sh -c "! grep -q eips $W/calls 2>/dev/null"

touch $W/tmp/nexus.radio_off; rm -f $W/calls; echo png > $W/bridge; touch $W/no_wifi
( . $W/lib.sh; WIFI_WAIT=3; radio_up key )
check "key, Wi-Fi does not come back: says so on the screen" has "No Wi-Fi yet"

[ $fail = 0 ] && echo "all connecting checks passed"
exit $fail
