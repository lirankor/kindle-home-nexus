# Kindle Home Control

design a 600x800 grayscale none touch interface to control home assist this will run on a kindle 4th gen. attcahed current dashboard we will need seperate tabs for lights vacume power and media.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/79983d66-4b81-42bb-b336-b563196d3364).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Home Assistant and Immich

The server talks to Home Assistant (REST API) and Immich; the browser only talks to this app.
Copy `.env.example` to `.env` (git-ignored; `docker compose` loads it automatically):

| Variable | Meaning |
| --- | --- |
| `HA_BASE_URL` | Home Assistant URL as seen from the container, e.g. `http://host.docker.internal:8123` |
| `HA_TOKEN` | Long-lived access token. Empty = demo mode ("Demo · HA not configured") |
| `IMMICH_URL` | Immich server, e.g. `http://100.125.35.82:2283` |
| `IMMICH_API_KEY` | Immich API key. Empty = bundled sample screensaver photo |

The entity ids are mapped in `src/lib/home.ts`.

## Kindle bridge

`bridge/` runs this app in headless Chromium and exposes it to a Kindle 4 over plain HTTP GET:
`/screen.png` (8-bit grayscale 600x800), `/key/<name>` to inject keys, `/healthz`.
Run both with Docker Compose:

```sh
docker compose up -d --build
curl -o screen.png http://localhost:8790/screen.png
```

See `bridge/README.md` for details.
