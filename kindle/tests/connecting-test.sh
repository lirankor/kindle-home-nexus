#!/bin/sh
# The battery saver's "connecting" icon (kindle/nexus.sh show_connecting / radio_up), runnable on any box with a POSIX
# sh:  sh kindle/tests/connecting-test.sh
# nexus.sh's functions are loaded from a copy whose paths point into a temp dir; eips, lipc-*, timeout and sleep are
# PATH stubs that record what the client did.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf $W' EXIT
mkdir -p $W/dir $W/tmp $W/bin
printf 'BRIDGE_URL="http://bridge.test"\nBRIDGE_TOKEN="x"\nPOLL_SECONDS=20\n' > $W/dir/config
# everything before the command dispatch, with the Kindle's paths moved into the temp dir
sed -n '/^case "\$1" in/q;p' $HERE/../nexus.sh \
  | sed -e "s#^export PATH=.*#export PATH=$W/bin:\$PATH#" -e "s#/mnt/us/nexus#$W/dir#g" -e "s#/tmp/nexus#$W/tmp/nexus#g" \
  > $W/lib.sh
# stubs: eips logs its arguments (and fails -g while $W/old_eips exists); lipc-set-prop logs; the radio
# associates unless $W/no_wifi exists
cat > $W/bin/eips <<STUB
#!/bin/sh
echo "eips \$*" >> $W/calls
case " \$* " in *" -g "*) [ -f $W/old_eips ] && exit 1;; esac
exit 0
STUB
printf '#!/bin/sh\necho "lipc-set $*" >> %s/calls\n' $W > $W/bin/lipc-set-prop
printf '#!/bin/sh\n[ -f %s/no_wifi ] && echo PENDING || echo CONNECTED\n' $W > $W/bin/lipc-get-prop
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\nexec "$@"\n' > $W/bin/timeout
printf '#!/bin/sh\nexit 0\n' > $W/bin/sleep
chmod +x $W/bin/*
cp $HERE/../connecting.png $W/dir/connecting.png
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
up() { # up <why> : radio_up with the radio switched off before
  rm -f $W/calls; touch $W/tmp/nexus.radio_off
  ( . $W/lib.sh; WIFI_WAIT=3; radio_up "$1" )
}

up key
check "key while the radio is off: the full-frame picture, no -x/-y" sh -c "grep -qx 'eips -g $W/dir/connecting.png' $W/calls"
check "key: the radio is switched on before the icon is drawn" order "wirelessEnable 1" "eips -g"
check "key: no text line when the icon was drawn" hasnt "Connecting..."
check "key: the radio-off marker is gone" [ ! -e $W/tmp/nexus.radio_off ]

touch $W/old_eips; up key; rm -f $W/old_eips
check "an eips that cannot draw the image: the text line" has "eips 1 38 Connecting..."

mv $W/dir/connecting.png $W/icon.bak; up key; mv $W/icon.bak $W/dir/connecting.png
check "icon not deployed: the text line, no image call" sh -c "grep -q 'Connecting...' $W/calls && ! grep -q 'eips -g' $W/calls"

up poll
check "scheduled wake (nobody waiting): nothing drawn" hasnt "eips"

rm -f $W/calls $W/tmp/nexus.radio_off; ( . $W/lib.sh; radio_up key )
check "key while the radio is on: nothing drawn" hasnt "eips"

touch $W/no_wifi; up key; rm -f $W/no_wifi
check "Wi-Fi does not come back: says so on the screen" has "No Wi-Fi yet"

check "the picture is a full 600x800 frame" sh -c "head -c 24 $HERE/../connecting.png | tail -c 8 | od -An -tx1 | tr -d ' \n' | grep -q '0000025800000320'"

[ $fail = 0 ] && echo "all connecting checks passed"
exit $fail
