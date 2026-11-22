#!/bin/sh
# Server side of the Kindle rescue guard (kindle/rescue.sh; procedure in kindle/RESCUE.md).
# Reaches the device only through the SSH host alias "kindle" (KINDLE_HOST overrides it) and holds no address,
# token or other secret. Output from the device is masked (addresses, URLs, long keys); config is never read out.
#
#   wait [minutes]          retry until the Kindle answers (its radio may be off), then hold the radio on for 60 min
#   hold on [minutes]       keep the radio on (default 60, at most 240); the guard removes the hold when it expires
#   hold off                remove the hold now
#   status                  processes, radio, hold, trial, snapshot, last log lines
#   log [lines]             the guard's own log
#   snapshot                make the files running now the known-good set (good/)
#   trial start <minutes>   arm the dead-man switch: no "trial confirm" within <minutes> -> the guard rolls back
#   trial extend <minutes>  new deadline, <minutes> from now
#   trial confirm           disarm: the new files stay (then run "snapshot")
#   rollback                roll back now (at the guard's next run, within a minute)
#   screen <out.png>        copy the Kindle's framebuffer and write it as a PNG: what is on the panel right now
#   install                 copy kindle/rescue.sh to the device
#   cron-install            add the guard's own line to the device's crontab (root file system rw for the edit only)
set -u
HOST=${KINDLE_HOST:-kindle}
HERE=$(cd "$(dirname "$0")" && pwd)
D=/mnt/us/nexus
CRONLINE='* * * * * /bin/sh /mnt/us/nexus/rescue.sh'
k() { timeout "${KT:-30}" ssh -q -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "$@"; }
mask() {
  sed -e 's/[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}/<ip>/g' \
      -e 's/\([0-9A-Fa-f]\{2\}[:-]\)\{5\}[0-9A-Fa-f]\{2\}/<mac>/g' \
      -e 's#[A-Za-z][A-Za-z]*://[^ "'"'"']*#<url>#g' \
      -e 's/[A-Za-z0-9_+/=-]\{24,\}/<masked>/g'
}
die() { echo "kindle-rescue: $*" >&2; exit 1; }
minutes() { # minutes <value> <max>
  case "$1" in ''|*[!0-9]*|0*) die "minutes: a whole number from 1 to $2";; esac
  [ ${#1} -le 4 ] && [ "$1" -le "$2" ] || die "minutes: at most $2"
}
# Shell functions for the device side. A rollback kills every shell whose script is nexus.sh or nexus/cron.sh
# ("sh <path>/nexus.sh ..."), so nothing here starts one; text inside an "sh -c" command is not matched.
PRE='D=/mnt/us/nexus; G=$D/good; now=$(date +%s)
good_ok() { [ -s $G/nexus.sh ] && [ -s $G/cron.sh ] && [ -s $G/config ] && [ -s $G/md5 ] && [ "$(cd $G && md5sum nexus.sh cron.sh config 2>/dev/null)" = "$(cat $G/md5)" ] && sh -n $G/nexus.sh && sh -n $G/cron.sh; }
ours() { case "$(cat $D/NORADIO 2>/dev/null)" in "rescue "*) return 0;; esac; return 1; }
holdleft() { set -- $(cat $D/NORADIO 2>/dev/null) x x; case "$2" in *[!0-9]*) echo 0;; *) echo $(( $2 - now ));; esac; }
sethold() { # sethold <seconds> [longer] : "longer" never shortens a hold that is already there
  if [ -f $D/NORADIO ] && ! ours; then echo "NORADIO was made by hand: left alone, the radio stays on until someone removes it"
  elif [ "$2" = longer ] && ours && [ $(holdleft) -ge $1 ]; then echo "radio hold: $(( $(holdleft) / 60 )) min left"
  else echo "rescue $(( now + $1 ))" > $D/NORADIO; echo "radio hold set for $(( $1 / 60 )) min"; fi
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
}
guard_alive() { set -- $(cat /tmp/rescue.last 2>/dev/null) 0; [ -f $D/rescue.sh ] && [ $(( now - $1 )) -lt 150 ]; }
'
cmd=${1:-}; arg=${2:-}; arg2=${3:-}
case "$cmd" in
wait)
  m=${arg:-20}; minutes "$m" 120; end=$(( $(date +%s) + m * 60 ))
  while :; do
    out=$(KT=12 k "$PRE sethold 3600 longer; echo in" 2>/dev/null)
    case "$out" in *in) echo "$out" | grep -v '^in$'; echo "connected ($0 hold off removes the hold)"; exit 0;; esac
    [ $(date +%s) -ge $end ] && die "no answer from the Kindle within $m minutes"
    sleep 15
  done;;
hold)
  case "$arg" in
    on) m=${arg2:-60}; minutes "$m" 240; k "$PRE sethold $(( m * 60 )); sync";;
    off) k "$PRE rm -f \$D/NORADIO; sync; [ -f \$D/NORADIO ] && echo 'NORADIO is STILL THERE' || echo 'NORADIO removed: the battery saver may switch the radio off again'";;
    *) die "usage: hold on [minutes] | hold off";;
  esac;;
status)
  sum=$(md5sum < "$HERE/../rescue.sh" 2>/dev/null | cut -d' ' -f1)
  k "$PRE"'
  up=$(cut -d. -f1 /proc/uptime); echo "time    : $(date "+%Y-%m-%d %H:%M:%S") UTC, up $(( up / 86400 )) d $(( up % 86400 / 3600 )) h, battery $(cat /sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity 2>/dev/null | tr -dc 0-9)%"
  if [ ! -f $D/rescue.sh ]; then g="rescue.sh NOT INSTALLED"
  elif [ "$(md5sum < $D/rescue.sh | cut -d" " -f1)" = "'"$sum"'" ]; then g="rescue.sh installed (same as the repo copy)"; else g="rescue.sh installed (DIFFERS from the repo copy)"; fi
  grep -q "^[* ]* /bin/sh $D/rescue.sh\$" /etc/crontab/root && g="$g, crontab line present" || g="$g, NO CRONTAB LINE"
  set -- $(cat /tmp/rescue.last 2>/dev/null) x; t=$1; shift
  case "$t" in x|*[!0-9]*) g="$g, has not run since the boot";; *) g="$g, last run $(( now - t )) s ago: $*";; esac
  echo "guard   : ${g% x}"
  n=0; for p in /proc/[0-9]*; do case "$( { tr "\0" " " < $p/cmdline; } 2>/dev/null )" in *"nexus.sh run ") n=$(( n + 1 ));; esac; done
  kill -0 "$(cat $D/nexus.pid 2>/dev/null)" 2>/dev/null && p="client running" || p="CLIENT NOT RUNNING"
  [ -f $D/DISABLED ] && p="$p, DISABLED is set"
  echo "panel   : $p, $n panel processes, last successful fetch $(( now - $(cat /tmp/nexus.last_ok 2>/dev/null || echo $now) )) s ago"
  r="wirelessEnable $(lipc-get-prop com.lab126.cmd wirelessEnable 2>/dev/null), wifid $(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)"
  if [ -f /tmp/nexus.radio_off ]; then set -- $(cat /tmp/nexus.window 2>/dev/null) 0; r="$r, battery saver window open, $(( $1 - now )) s left"; fi
  echo "radio   : $r"
  if [ ! -f $D/NORADIO ]; then echo "hold    : none"; elif ours; then echo "hold    : by the guard, $(holdleft) s left"; else echo "hold    : NORADIO made by hand (never expires)"; fi
  if [ -f $D/TRIAL ]; then set -- $(cat $D/TRIAL) x x; echo "trial   : RUNNING, $(( $1 - now )) s left of $2 min"; else echo "trial   : none"; fi
  [ -f $D/ROLLBACK ] && echo "rollback: REQUESTED, runs within a minute"
  [ -f $D/ROLLED_BACK ] && echo "rollback: last one $(cat $D/ROLLED_BACK)"
  if good_ok; then
    s="good/ verified, taken $(cat $G/taken 2>/dev/null)"; d=
    for f in nexus.sh cron.sh config; do cmp -s $D/$f $G/$f || d="$d $f"; done
    [ -n "$d" ] && s="$s; RUNNING FILES DIFFER:$d" || s="$s; the running files are the same"
  else s="good/ MISSING OR DAMAGED: a rollback would restore nothing"; fi
  echo "snapshot: $s"
  s=; for f in NONET NOREBOOT WIFID_RESTART RESCUE_DEBUG; do [ -f $D/$f ] && s="$s $f"; done; [ -n "$s" ] && echo "switches:$s"
  [ -f $D/rescue.net ] && { set -- $(cat $D/rescue.net) 0 0; echo "network : NOT CONNECTED for $(( now - $1 )) s, step $2 taken"; }
  echo "--- rescue.log"; tail -n 6 $D/rescue.log 2>/dev/null
  echo "--- nexus.log"; tail -n 6 $D/nexus.log 2>/dev/null
  echo' | mask;;
log)
  n=${arg:-30}; minutes "$n" 400; k "tail -n $n $D/rescue.log 2>/dev/null; echo" | mask;;
snapshot)
  k "$PRE"'
  [ -f $D/TRIAL ] || [ -f $D/ROLLBACK ] && { echo "a trial or a rollback is pending: confirm or let it finish first"; exit 1; }
  sh -n $D/nexus.sh && sh -n $D/cron.sh && [ -s $D/config ] || { echo "the running files do not even parse: no snapshot taken"; exit 1; }
  kill -0 "$(cat $D/nexus.pid 2>/dev/null)" 2>/dev/null || echo "warning: the client is not running right now; is this really a good state?"
  N=$D/good.new; rm -rf $N; mkdir $N && cp $D/nexus.sh $D/cron.sh $D/config $N/ || { echo "copy failed"; exit 1; }
  cp /etc/crontab/root $N/crontab.root; [ -f $G/crontab.before-rescue ] && cp $G/crontab.before-rescue $N/
  date "+%Y-%m-%d %H:%M:%S" > $N/taken
  ( cd $N && md5sum nexus.sh cron.sh config > md5 )
  for f in nexus.sh cron.sh config; do cmp -s $D/$f $N/$f || { echo "verify failed for $f"; rm -rf $N; exit 1; }; done
  rm -rf $D/good.prev; [ -d $G ] && mv $G $D/good.prev; mv $N $G; sync
  good_ok && echo "snapshot taken: good/ = the files running now (the one before is kept as good.prev/)" || { echo "SNAPSHOT NOT USABLE"; exit 1; }
  echo';;
trial)
  case "$arg" in
    start)
      minutes "$arg2" 720; s=$(( arg2 * 60 + 300 )); [ $s -gt 14400 ] && s=14400   # radio held on a little past the deadline
      k "$PRE"'
      [ -f $D/TRIAL ] && { echo "a trial is already running: use trial extend or trial confirm"; exit 1; }
      good_ok || { echo "no usable good/ snapshot: run snapshot first"; exit 1; }
      guard_alive || { echo "the guard has not run in the last 150 s (not installed, no crontab line, or cron is stuck): no trial started"; exit 1; }
      d=; for f in nexus.sh cron.sh config; do cmp -s $D/$f $G/$f || d="$d $f"; done
      [ -n "$d" ] && echo "note: the running files already differ from good/ (:$d): a rollback brings the good/ versions back"
      rm -f $D/ROLLED_BACK $D/ROLLBACK
      echo "$(( now + '"$arg2"' * 60 )) '"$arg2"'" > $D/TRIAL.tmp && mv $D/TRIAL.tmp $D/TRIAL || { echo "could not write TRIAL"; exit 1; }
      echo "trial started: rollback to good/ at $(awk "BEGIN{print strftime(\"%H:%M:%S\", $(( now + '"$arg2"' * 60 )))}") UTC unless confirmed"
      sethold '"$s"' longer; sync
      echo';;
    extend)
      minutes "$arg2" 720
      k "$PRE"'
      [ -f $D/TRIAL ] || { echo "no trial is running (did it already roll back? see status)"; exit 1; }
      echo "$(( now + '"$arg2"' * 60 )) '"$arg2"'" > $D/TRIAL.tmp && mv $D/TRIAL.tmp $D/TRIAL && echo "trial extended: '"$arg2"' min from now"; sync
      echo';;
    confirm)
      k "$PRE"'
      [ -f $D/TRIAL ] || { echo "no trial is running"; [ -f $D/ROLLED_BACK ] && echo "TOO LATE, it rolled back: $(cat $D/ROLLED_BACK)"; exit 1; }
      rm -f $D/TRIAL; sync
      [ -f $D/TRIAL ] && { echo "TRIAL IS STILL THERE"; exit 1; }
      [ -f $D/ROLLED_BACK ] && { echo "TOO LATE, it rolled back: $(cat $D/ROLLED_BACK)"; exit 1; }
      ours && rm -f $D/NORADIO && echo "radio hold removed"
      echo "trial confirmed: the new files stay. Run snapshot to make them the known-good set."
      echo' | mask;;
    *) die "usage: trial start <minutes> | trial extend <minutes> | trial confirm";;
  esac;;
rollback)
  k "$PRE"'guard_alive || echo "warning: the guard has not run in the last 150 s"; rm -f $D/ROLLED_BACK; : > $D/ROLLBACK; sync; echo "rollback requested, waiting for the guard"' || die "could not reach the Kindle"
  i=0
  while [ $i -lt 12 ]; do
    sleep 10; i=$(( i + 1 ))
    out=$(KT=12 k "cat $D/ROLLED_BACK 2>/dev/null; [ -f $D/ROLLBACK ] && echo pending; echo" 2>/dev/null)
    case "$out" in *pending*|'') ;; *) echo "rolled back: $out" | mask; exit 0;; esac
  done
  die "no rollback seen within 2 minutes: see status";;
screen)
  [ -n "$arg" ] || die "usage: screen <out.png>"
  geo=$(k 'cat /sys/class/graphics/fb0/virtual_size /sys/class/graphics/fb0/bits_per_pixel /sys/class/graphics/fb0/stride' | tr ',\n' '  ')
  set -- $geo; [ $# -eq 4 ] && [ "$3" = 8 ] || die "unexpected framebuffer geometry: $geo"
  raw=$(mktemp); trap 'rm -f "$raw"' EXIT
  KT=60 k 'cat /dev/fb0' > "$raw" || die "could not read the framebuffer"
  python3 - "$raw" "$arg" "$1" "$2" "$4" "${SCREEN_INVERT:-1}" <<'PY'
import struct, sys, zlib
raw, out, w, h, stride, invert = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6] == "1"
data = open(raw, "rb").read()
if len(data) < stride * h:
    sys.exit("framebuffer too short: %d bytes" % len(data))
rows = b"".join(b"\0" + (bytes(255 - b for b in data[y * stride:y * stride + w]) if invert else data[y * stride:y * stride + w]) for y in range(h))
def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
open(out, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
print("%s: %dx%d" % (out, w, h))
PY
  ;;
install)
  f=$HERE/../rescue.sh; sh -n "$f" || die "rescue.sh does not parse"
  sum=$(md5sum < "$f" | cut -d' ' -f1)
  k "cat > $D/rescue.sh.new" < "$f" || die "copy failed"
  k "sh -n $D/rescue.sh.new && [ \"\$(md5sum < $D/rescue.sh.new | cut -d' ' -f1)\" = $sum ] && mv $D/rescue.sh.new $D/rescue.sh && sync && echo 'rescue.sh installed and verified' || { rm -f $D/rescue.sh.new; echo 'INSTALL FAILED: the copy on the device did not verify, nothing changed'; exit 1; }";;
cron-install)
  # busybox 1.7.2 crond reads its tables again when a file "cron.update" in the crontab folder names the user; it
  # removes that file itself, which needs the root file system writable, so we wait for that before going back to ro.
  KT=150 k "$PRE"'C=/etc/crontab/root; L="'"$CRONLINE"'"
  grep -q "^[* ]* /bin/sh $D/rescue.sh\$" $C && { echo "the crontab line is already there"; exit 0; }
  [ -f $D/rescue.sh ] && sh -n $D/rescue.sh || { echo "install rescue.sh first"; exit 1; }
  mkdir -p $G; cp $C $G/crontab.before-rescue && cmp -s $C $G/crontab.before-rescue || { echo "could not save a copy of the crontab: nothing changed"; exit 1; }
  [ "$(tail -n 1 $C | wc -l)" -eq 1 ] || { echo "the crontab does not end with a newline: nothing changed, edit by hand"; exit 1; }
  mount -o remount,rw / || { echo "could not remount / read-write: nothing changed"; exit 1; }
  { cat $C; echo "$L"; } > $C.new && [ "$(cat $C.new)" = "$(cat $C; echo "$L")" ] && chmod 644 $C.new && mv $C.new $C && echo root > /etc/crontab/cron.update || echo "EDIT FAILED"
  rm -f $C.new; sync
  i=0; while [ -f /etc/crontab/cron.update ] && [ $i -lt 100 ]; do sleep 1; i=$(( i + 1 )); done
  [ -f /etc/crontab/cron.update ] && { rm -f /etc/crontab/cron.update; echo "crond did not take the update within 100 s; it reads the folder again by itself once an hour"; } || echo "crond took the update after $i s"
  sync; mount -o remount,ro /; mount | grep "^/dev/root"
  echo' || die "the edit did not finish: check the crontab and that / is read-only again"
  a=$(mktemp); b=$(mktemp); trap 'rm -f "$a" "$b"' EXIT
  k "cat $D/good/crontab.before-rescue" > "$a" && k "cat /etc/crontab/root" > "$b" || die "could not read the crontab back"
  echo "--- crontab now"; cat "$b"; echo "--- changed against the copy saved before the edit (good/crontab.before-rescue)"; diff "$a" "$b"
  [ "$(diff "$a" "$b" | grep -c '^[<>]')" = 1 ] && tail -n 1 "$b" | grep -qxF "$CRONLINE" && echo "verified: one line added, nothing else changed" || die "THE CRONTAB IS NOT WHAT WAS EXPECTED";;
*) sed -n '2,19p' "$0" | cut -c3-; exit 1;;
esac
