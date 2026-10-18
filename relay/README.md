# relay — https → http stream pass-through for the amp

The R-N500 only plays plain `http://` streams; most Israeli (and some other) stations are `https://` only.
This tiny service pipes a catalog station's stream unchanged over http. No transcoding, no HLS.

- URL the amp uses (via YTuner's station list): `http://<LAN address of this host>:8792/s/<station id>`
- Allowlist: a catalog JSON (`{"lists":[{"stations":[{"id","url"}]}]}`) mounted read-only at `/app/radio-stations.json`;
  unknown ids → 404. This repo mounts an empty example (`relay/stations.example.json`); the real allowlist is
  deployment data and comes from a `docker-compose.override.yml`.
- At most `MAX_CLIENTS` (4) concurrent listeners (the amp is one).
- Published on the LAN address only (Docker-published ports bypass ufw on pop-os).

The station list itself is owned by Home Assistant (yamaha_netbridge options, see ytuner/README.md): a station whose
source is https-only gets `http://<host>:8792/s/<id>` as its URL there and an entry in the allowlist.
