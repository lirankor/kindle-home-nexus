# ytuner — NET RADIO for the Yamaha R-N500

The R-N500's NET RADIO input asks vTuner (`radioyamaha.vtuner.com`) for its station lists; Yamaha stopped
paying for that service, so every category now contains only a "go to yradio.vtuner.com" stub.
This container runs [YTuner](https://github.com/coffeegreg/YTuner), a drop-in vTuner emulation, with our
own station list (`config/stations.yaml`), YTuner bookmarks ("Favourites") and the Radio Browser directory.

## How the amp reaches it (pop-os)

1. The amp has a manual network config with DNS = 192.168.1.15 (Pi-hole on pop-os).
2. Pi-hole answers `*.vtuner.com` with 192.168.1.15 (`misc.dnsmasq_lines = ["address=/vtuner.com/192.168.1.15"]`).
3. Caddy (host network, owns port 80) has an `http://*.vtuner.com` site that proxies to `127.0.0.1:8098`,
   which is this container's port 80 (see `docker-compose.yml`). vTuner-era AVRs cannot do HTTPS.
4. `ytuner.ini` sets `ActAsHost=radioyamaha.vtuner.com` so every URL handed back to the amp goes through the same path.

Caddy block (in `/srv/data/caddy/Caddyfile`):

```
http://radioyamaha.vtuner.com, http://radioyamaha2.vtuner.com, http://*.vtuner.com {
	reverse_proxy 127.0.0.1:8098
}
```

## Stations

`config/stations.yaml`:

```
Category name:
  Station name: http://stream-url|http://logo-url
```

No comment lines: YTuner's YAML reader is minimal and a `#` line makes it drop the whole file
("No station(s) found"). Streams must be plain `http://` MP3 or AAC (no HTTPS, HLS, OGG, Opus); the
R-N500 cannot follow https redirects. URLs were verified 2026-10-14 (`scripts/radio-stations.py` writes this file).
The file is bind-mounted read-only into the container: edit, commit, `docker compose restart ytuner`; the log should say
`Successfully loaded N my stations`.

Bookmarks (the amp's / Kindle's "Favourites") are written by YTuner to `config/bookmark.xml`, which lives in the
`ytuner-config` dir (`${KINDLE_DATA_DIR:-./data}/ytuner-config`, a named volume until 2026-10-16) so rebuilds keep them (before 2026-10-14 it was container-local and a rebuild emptied the list).

## Checks

```
curl -s -H 'Host: radioyamaha.vtuner.com' 'http://127.0.0.1/setupapp/Yamaha/asp/BrowseXML/loginXML.asp?mac=00A0DEA5A78E&dlang=eng'
docker compose logs --tail 50 ytuner
```
On the amp: NET RADIO → the top menu should read Duesseldorf / Favourites / Radio Browser.
