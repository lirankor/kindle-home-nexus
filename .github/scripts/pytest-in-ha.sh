#!/usr/bin/env sh
# Run the kindle_panel test suite inside a Home Assistant container.
#
# Usage (from the repository root, Docker on the host):
#   .github/scripts/pytest-in-ha.sh                 # newest HA version that pytest-homeassistant-custom-component supports
#   HA_IMAGE=ghcr.io/home-assistant/home-assistant:2026.10.4 .github/scripts/pytest-in-ha.sh
#
# Which Home Assistant: without HA_IMAGE the script asks PyPI for the newest pytest-homeassistant-custom-component
# release and uses the Home Assistant version that release pins (the harness always trails HA by days to weeks; the
# `stable` tag would break every month until the matching harness release exists). With HA_IMAGE it uses that image
# and looks up the harness release pinning that very version. Either way the harness is installed `--no-deps`, so
# nothing in the image is touched, plus the pytest plugins the suite needs; then pytest runs in homeassistant/
# (pytest config: homeassistant/pyproject.toml). The repository root is mounted whole: test_icon_pack_equals_the_app_json
# reads src/data/icons.json. Extra arguments go to pytest.
set -eu

repo="$(cd "$(dirname "$0")/../.." && pwd)"
PKG=pytest-homeassistant-custom-component

# Host side: "<ha version> <harness version>" for the newest harness release that pins a Home Assistant version.
resolve_newest() {
  python3 - "$PKG" <<"PY"
import json, re, sys, urllib.request
pkg = sys.argv[1]
def key(v):
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", v)
    return tuple(int(x) for x in m.groups()) if m else None
releases = [v for v in json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/json"))["releases"] if key(v)]
for version in sorted(releases, key=key, reverse=True)[:30]:
    info = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/{version}/json"))["info"]
    for r in info.get("requires_dist") or []:
        m = re.fullmatch(r"homeassistant\s*==\s*([0-9][0-9.]*[0-9])", r.strip())
        if m:
            print(m.group(1), version)
            sys.exit(0)
sys.exit(f"no {pkg} release pins a homeassistant version")
PY
}

if [ -z "${HA_IMAGE:-}" ]; then
  set -- "$(resolve_newest)" "$@"
  ha_version="${1%% *}"; harness="${1##* }"; shift
  HA_IMAGE="ghcr.io/home-assistant/home-assistant:$ha_version"
  echo "newest harness $PKG $harness pins Home Assistant $ha_version -> $HA_IMAGE"
else
  harness=""
fi

exec docker run --rm -v "$repo:/src" -w /src/homeassistant -e PYTHONDONTWRITEBYTECODE=1 -e HARNESS="$harness" \
  --entrypoint sh "$HA_IMAGE" -c '
set -eu
ha_version="$(python3 -c "from homeassistant.const import __version__; print(__version__)")"
echo "Home Assistant $ha_version"
if [ -z "$HARNESS" ]; then
HARNESS="$(python3 - "$ha_version" <<"PY"
import json, re, sys, urllib.request
ha = sys.argv[1]
pkg = "pytest-homeassistant-custom-component"
def key(v):
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", v)
    return tuple(int(x) for x in m.groups()) if m else None
releases = [v for v in json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/json"))["releases"] if key(v)]
for version in sorted(releases, key=key, reverse=True)[:200]:
    info = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/{version}/json"))["info"]
    if any(r.replace(" ", "") == f"homeassistant=={ha}" for r in info.get("requires_dist") or []):
        print(version)
        break
else:
    sys.exit(f"no {pkg} release pins homeassistant=={ha} (yet): run with HA_IMAGE unset to test on the newest supported HA")
PY
)"
fi
echo "pytest-homeassistant-custom-component $HARNESS"
pip install --quiet --no-cache-dir --no-deps "pytest-homeassistant-custom-component==$HARNESS"
pip install --quiet --no-cache-dir pytest pytest-asyncio pytest-socket syrupy freezegun requests-mock pytest-unordered \
  respx pytest-xdist pytest-cov pytest-timeout
exec python3 -m pytest -p no:cacheprovider --timeout=120 "$@"
' sh "$@"
