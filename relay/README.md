# relay — https → http stream pass-through for the amp

The R-N500 only plays plain `http://` streams; most Israeli (and some other) stations are `https://` only.
This tiny service pipes a catalog station's stream unchanged over http. No transcoding, no HLS.

- URL the amp uses (via YTuner's station list): `http://192.168.1.15:8792/s/<station id>`
- Allowlist: `src/data/radio-stations.json` (mounted read-only); unknown ids → 404.
- At most `MAX_CLIENTS` (4) concurrent listeners (the amp is one).
- Published on the LAN address only (Docker-published ports bypass ufw on pop-os).

`scripts/radio-stations.py` marks stations whose source is https with `relay: true` and writes the relay URL
into `ytuner/config/stations.yaml`; the app shows the station's real codec/bitrate from the catalog.
