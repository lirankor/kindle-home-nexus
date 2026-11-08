# Installing Kindle Home Nexus

Three parts, in this order:

1. **The server half** (`docker-compose.yml`: the app, the headless-Chromium bridge, YTuner and the stream relay) on a
   Docker host on the same LAN as the Kindle. This is the "HA Container" way: Home Assistant runs in Docker on a box you
   control, and this stack runs next to it.
2. **The `kindle_panel` integration** in Home Assistant, from the Marketplace (Settings > Marketplace, the former HACS,
   built into Home Assistant since 2026.11).
3. **The Kindle client** (`kindle/`, a shell script on a jailbroken Kindle 4) — see `kindle/README.md`.

An **add-on wrapper for Home Assistant OS / Supervised** (the server half as a Supervisor add-on, so nothing has to be
run with `docker compose` by hand) is planned; until then Home Assistant OS users need a second machine for step 1.

## 1. Server half (Docker Compose)

Requirements: Docker with the Compose plugin, Node/bun are **not** needed on the host (everything builds in containers),
and the host must be reachable from the Kindle and from Home Assistant.

```sh
git clone https://github.com/lirankor/kindle-home-nexus.git
cd kindle-home-nexus
cp .env.example .env          # git-ignored; the only file with secrets
```

Edit `.env` (every variable is documented in `.env.example`); the minimum is:

| variable | what |
|---|---|
| `LAN_IP` | this host's LAN address. The bridge (`:8790`), the app (`:8791`) and the relay (`:8792`) are published on it; everything else stays on `127.0.0.1`. `docker compose up` refuses to start without it. |
| `HA_BASE_URL` | Home Assistant as seen from the containers, e.g. `http://host.docker.internal:8123` (default) or `http://<LAN_IP>:8123` |
| `HA_TOKEN` | a long-lived access token (your HA profile page > Security). Without it the panel runs in demo mode. |
| `BRIDGE_TOKEN` | a shared secret the Kindle sends with every request (`openssl rand -hex 24`); the same value goes into the Kindle's `config` |

Optional: `IMMICH_URL` / `IMMICH_API_KEY` (screensaver photos), `AMP_HOST`, `JELLYFIN_*`, `VOICE_TOKEN` (the voice API
for HA Assist), `COVER_FORGE_URL` (generated station covers), the battery-saver schedule, `KINDLE_DATA_DIR` (where the
runtime state is kept; default `./data`).

Two things in `docker-compose.yml` are specific to a box that also runs [cover-forge](https://github.com/lirankor/cover-forge):
the `cover-forge` network (declared `external`) and `COVER_FORGE_URL`. If you do not run cover-forge, remove the two
`cover-forge` lines under `services.app.networks` and the `networks.cover-forge` block (or create the network once with
`docker network create cover-forge_default`), and leave `COVER_FORGE_URL` empty.

Then:

```sh
docker compose up -d --build                      # ~3 min the first time
curl -s http://127.0.0.1:8790/healthz             # {"ok":true,...}
curl -o screen.png -H "X-Bridge-Token: $BRIDGE_TOKEN" http://127.0.0.1:8790/screen.png
```

Networking notes:

- The containers must reach Home Assistant. The compose network has a fixed subnet (`10.90.90.0/24`) so a host firewall
  rule can allow exactly that, e.g. `sudo ufw allow from 10.90.90.0/24 to any port 8123 proto tcp`.
- Docker-published ports bypass ufw, so the bridge is reachable from the LAN without a rule. Everything on `LAN_IP` is
  open to the whole LAN (the bridge needs the token, the app port `8791` has **no login**; remove that line from
  `docker-compose.yml` if you do not want desktop debugging).
- After rebuilding only the app, recreate the bridge too: `docker compose up -d --force-recreate --no-deps bridge`
  (it shares the app's network namespace).

## 2. The `kindle_panel` integration (Home Assistant Marketplace)

The integration is distributed as a release asset (`kindle_panel.zip`, built by `.github/workflows/release.yml` on
every GitHub release; `hacs.json` tells the Marketplace to use it).

1. Home Assistant 2026.11 or newer: **Settings > Marketplace**. Older Home Assistant with HACS installed: **HACS**
   in the sidebar. (The integration itself works from Home Assistant 2026.8.)
2. Open the overflow menu (⋮) and choose **Add from link** (HACS: *Custom repositories*). Paste
   `https://github.com/lirankor/kindle-home-nexus`, category **Integration**, add it.
3. Open the new **Kindle Panel** entry, **Download / Install** (pick the latest release), then restart Home Assistant.
4. **Settings > Devices & services > Add integration > Kindle Panel**. The one question is which **Music Assistant**
   connection the panel should use for its queues and library; the panel is a Music Assistant client, so install and
   configure Music Assistant first if you want the music screens (the rest works without it).
5. Everything the panel shows (language, tabs, lights and scenes, vacuum, plugs, media devices, screensaver, battery-saver
   schedule) is configured in **Configure** on that entry; the panel seeds it on its first contact. See
   `homeassistant/custom_components/kindle_panel/README.md`.

Manual alternative: download `kindle_panel.zip` from the latest GitHub release, unzip it into
`<HA config>/custom_components/kindle_panel/` (so that `manifest.json` is directly in that folder) and restart Home
Assistant.

## 3. Kindle client

Copy `kindle/` to `/mnt/us/nexus/` on the device, set `BRIDGE_URL=http://<LAN_IP>:8790` and your `BRIDGE_TOKEN` in
`/mnt/us/nexus/config`, and add the cron line: `kindle/README.md` has the details (jailbreak, USBNetwork, buttons,
battery saver).
