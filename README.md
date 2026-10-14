# Kindle Home Nexus

Home/music control panel for a **Kindle 4 (600×800 e-ink, no touch)**: lights, vacuum, power plugs and the living-room
music (Yamaha R-N500 amp, Jellyfin queue, NET RADIO) driven by Home Assistant, Immich and Jellyfin. The Kindle only ever
fetches a grayscale PNG and sends key presses; everything else runs on the home server.

Started from a Lovable design mock, now developed locally in this repository (`git@github.com:lirankor/kindle-home-nexus.git`).

## What is in here

| dir | what | runs as |
|---|---|---|
| `src/` | the app — TanStack Start (React, Vite, Nitro node server on `:3000`). HA / Immich / Jellyfin / amp are reached **only** from server functions in `src/lib/`; the browser never sees a credential | container `app` |
| `bridge/` | headless Chromium that keeps the app open and serves `/screen.png` (8-bit grayscale 600×800), `/key/<name>`, `/healthz` to the Kindle over plain HTTP on `:8790`; shares the app's network namespace | container `bridge` |
| `ytuner/` | vTuner replacement so the amp's NET RADIO input works again (`:8095`, via Caddy for `*.vtuner.com`) | container `ytuner` |
| `relay/` | https → http stream pass-through for stations the amp cannot play directly (`:8792`) | container `relay` |
| `kindle/` | the scripts that run **on the Kindle** (`nexus.sh`, `cron.sh`, config) — see `kindle/README.md` | the Kindle |
| `docs/` | design reference + the media rework notes | — |
| `AGENTS.md` | the working rules for this codebase (e-ink UX, keys, RTL, i18n, focus) — read it before changing the UI | — |

## Local development

Node 22+ and [bun](https://bun.sh) (the lockfile is `bun.lock`; `bunfig.toml` enforces a 24 h supply-chain guard on installs).

```sh
cp .env.example .env     # fill in HA_TOKEN etc.; git-ignored, read server-side only, never prefixed VITE_
bun install --frozen-lockfile
bun run dev              # Vite dev server; restart it after editing .env
bun run lint && bunx tsc --noEmit && bun run test
```

Without `HA_TOKEN` the UI runs in demo mode ("Demo · HA not configured"); without `IMMICH_API_KEY` the screensaver uses
the bundled sample photo; without the media variables the media screens show demo data. For local dev omit
`MEDIA_STATE_DIR` / `MEDIA_CACHE_DIR` (temp dirs are used). All variables are documented in `.env.example`.
Station art: the catalogue logo when it is a real image, else a placeholder cover rendered by
[cover-forge](https://github.com/lirankor/cover-forge) (`COVER_FORGE_URL` / `COVER_FORGE_TOKEN`; the compose file joins
its docker network), served grayscale to the Kindle (`/media/img?station=`) and in colour to Home Assistant
(`/api/voice/art?station=`).

Keeping the checkout clean when testing inside Docker instead of a local toolchain:

```sh
docker run --rm -v "$PWD":/app -v khn-node-modules:/app/node_modules -v khn-bridge-nm:/app/bridge/node_modules -w /app oven/bun:1 \
  bash -c 'bun install --frozen-lockfile && bunx tsc --noEmit && bun run lint && bunx vitest run'
```

## Running it (Docker Compose — this is how it runs on the server)

```sh
docker compose up -d --build            # app + bridge + ytuner + relay (bun + node images, ~3 min)
curl -s http://127.0.0.1:8790/healthz   # {"ok":true,...}
curl -o screen.png -H "X-Bridge-Token: $BRIDGE_TOKEN" http://127.0.0.1:8790/screen.png
```

- Ports (see `docker-compose.yml`): bridge `192.168.1.15:8790` + `127.0.0.1:8790` (the Kindle polls
  `http://192.168.1.15:8790/<BRIDGE_TOKEN>/screen.png`), the app itself `127.0.0.1:8791` (voice API for Home Assistant),
  ytuner `127.0.0.1:8095`, relay `192.168.1.15:8792`.
- The compose network has a fixed subnet (`10.90.90.0/24`) so the host firewall can let it reach Home Assistant:
  `sudo ufw allow from 10.90.90.0/24 to any port 8123 proto tcp`.
- **Rebuilding only the app:** `docker compose up -d --build app` **then** `docker compose up -d --force-recreate --no-deps bridge`.
  The bridge uses `network_mode: service:app`; without the second command it stays in the dead namespace and `:8790` stops answering.
- Persistent state: volume `app-data` (queue / radio position / image cache), `ytuner-cache`, `ytuner-db`.
- `.env` is the only secret-bearing file. Its encrypted copy and the restore procedure live in the home-server DR repo
  (`homeserver-cloud/stacks/kindle-home-nexus/SOURCE.md`); the server backs this directory up nightly.

## Voice API (Home Assistant Assist)

`/api/voice/{state,search,play,action,radio}` on the app port (`127.0.0.1:8791`), bearer `VOICE_TOKEN`, implemented in
`src/routes/api/voice.$.ts` + `src/lib/voice-match.ts`. Home Assistant's package `packages/voice_music.yaml` and the
en/he sentences call it so "play some Beatles" / "תנגן משהו של queen" / "what's playing" work from the phone.
The endpoint table, match rule, amp power semantics, HA package and measured latencies are documented in the DR repo:
**`homeserver-cloud/docs/KINDLE-APP.md`** (voice pipeline itself: `docs/VOICE.md`).
