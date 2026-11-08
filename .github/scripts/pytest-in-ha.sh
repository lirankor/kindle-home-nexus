#!/usr/bin/env sh
# Run the kindle_panel test suite inside a Home Assistant container.
#
# Usage (from the repository root, Docker on the host):
#   .github/scripts/pytest-in-ha.sh                 # ghcr.io/home-assistant/home-assistant:stable
#   HA_IMAGE=ghcr.io/home-assistant/home-assistant:2026.10.4 .github/scripts/pytest-in-ha.sh
#
# The container installs pytest-homeassistant-custom-component in the release that pins the container's own Home
# Assistant version (`--no-deps`, so nothing in the image is touched) plus the pytest plugins the suite needs, then
# runs pytest in homeassistant/ (pytest config: homeassistant/pyproject.toml). The repository root is mounted whole:
# test_icon_pack_equals_the_app_json reads src/data/icons.json. Extra arguments go to pytest.
set -eu

HA_IMAGE="${HA_IMAGE:-ghcr.io/home-assistant/home-assistant:stable}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

exec docker run --rm -v "$repo:/src" -w /src/homeassistant -e PYTHONDONTWRITEBYTECODE=1 --entrypoint sh "$HA_IMAGE" -c '
set -eu
ha_version="$(python3 -c "from homeassistant.const import __version__; print(__version__)")"
echo "Home Assistant $ha_version"
harness="$(python3 - "$ha_version" <<"PY"
import json, sys, urllib.request
from packaging.version import Version

ha = sys.argv[1]
pkg = "pytest-homeassistant-custom-component"
releases = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/json"))["releases"]
for version in sorted(releases, key=Version, reverse=True)[:200]:
    info = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/{version}/json"))["info"]
    if any(r.replace(" ", "").startswith(f"homeassistant=={ha}") for r in info.get("requires_dist") or []):
        print(version)
        break
else:
    sys.exit(f"no {pkg} release pins homeassistant=={ha}")
PY
)"
echo "pytest-homeassistant-custom-component $harness"
pip install --quiet --no-cache-dir --no-deps "pytest-homeassistant-custom-component==$harness"
pip install --quiet --no-cache-dir pytest pytest-asyncio pytest-socket syrupy freezegun requests-mock pytest-unordered \
  respx pytest-xdist pytest-cov pytest-timeout
exec python3 -m pytest -p no:cacheprovider --timeout=120 "$@"
' sh "$@"
