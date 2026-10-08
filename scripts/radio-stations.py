#!/usr/bin/env python3
"""Build the radio station catalog.

Input:  the LISTS below (name -> plain http stream URL, verified by hand / this script).
Output: src/data/radio-stations.json   (used by the app: lists, names, bitrate, codec, logo, FM freq)
        ytuner/config/stations.yaml     (served to the amp's NET RADIO by YTuner; NO comment lines!)

Every URL is checked (HTTP 200, audio/* content type, no https redirect) because the Yamaha R-N500
only plays plain http MP3/AAC. Bitrate/codec/logo come from the Radio Browser API when it knows the URL.
Run:  python3 scripts/radio-stations.py   (needs internet; stdlib only)
"""
import json, re, sys, urllib.parse, urllib.request, pathlib

UA = {"User-Agent": "kindle-home-nexus/1.0"}
RB = "http://de1.api.radio-browser.info/json/stations/"
ROOT = pathlib.Path(__file__).resolve().parent.parent

# The local list is kept in ascending FM order on purpose: the Kindle dial shows the frequencies left→right.
LISTS = [
  {"id": "local", "ytuner": "Duesseldorf FM", "stations": [
    ("WDR 5", "http://wdr-wdr5-live.icecast.wdr.de/wdr/wdr5/live/mp3/128/stream.mp3", 88.8),
    ("NRW1", "http://stream.nrw1.de/nrw1/stream/mp3", 92.6),
    ("WDR 3", "http://wdr-wdr3-live.icecast.wdr.de/wdr/wdr3/live/mp3/128/stream.mp3", 95.1),
    ("Deutschlandfunk Kultur", "http://st02.sslstream.dlf.de/dlf/02/128/mp3/stream.mp3", 96.5),
    ("WDR 2", "http://wdr-wdr2-rheinruhr.icecast.wdr.de/wdr/wdr2/rheinruhr/mp3/128/stream.mp3", 99.2),
    ("WDR 4", "http://wdr-wdr4-live.icecast.wdr.de/wdr/wdr4/live/mp3/128/stream.mp3", 101.3),
    ("Deutschlandfunk", "http://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3", 102.8),
    ("COSMO", "http://wdr-cosmo-live.icecast.wdr.de/wdr/cosmo/live/mp3/128/stream.mp3", 103.3),
    ("Antenne Duesseldorf", "http://stream.antenneduesseldorf.de/444z5kv", 104.2),
    ("bigFM", "http://streams.bigfm.de/bigfm-deutschland-128-mp3", 105.7),
    ("1LIVE", "http://wdr-1live-live.icecast.wdr.de/wdr/1live/live/mp3/128/stream.mp3", 106.7),
    ("Deutschlandfunk Nova", "http://st03.sslstream.dlf.de/dlf/03/128/mp3/stream.mp3", None),
  ]},
  {"id": "israel", "ytuner": "Israel", "stations": [
    ("Galgalatz", "http://glzwizzlv.bynetcdn.com/glglz_mp3", 91.8),
    ("Galei Zahal", "http://glzwizzlv.bynetcdn.com/glz_mp3", 96.6),
    ("100FM Oldies", "http://gb25.streamgates.net/radios-audio/100Oldies/icecast.audio", None),
    ("100FM Movies", "http://gb25.streamgates.net/radios-audio/100Movies/icecast.audio", None),
    ("Kol Barama", "http://kb.cdnwz.net/kol_barama", 92.1),
    ("Kol Hashfela", "http://1036kh.cdnwz.net/1036kh", 103.6),
  ]},
  {"id": "english", "ytuner": "English", "stations": [
    ("BBC World Service", "http://stream.live.vc.bbcmedia.co.uk/bbc_world_service", None),
    ("Classic FM", "http://ice-the.musicradio.com/ClassicFMMP3", None),
    ("LBC", "http://media-sov.musicradio.com/LBC973MP3Low", None),
    ("Capital FM London", "http://media-ice.musicradio.com/CapitalMP3", None),
    ("Heart London", "http://ice-sov.musicradio.com/HeartLondonMP3", None),
    ("Smooth Radio", "http://media-the.musicradio.com/SmoothEastMids", None),
    ("Radio X", "http://icecast.thisisdax.com/RadioXUKMP3", None),
    ("Radio Caroline", "http://78.129.202.200:8040/;", None),
    ("Radio Paradise", "http://stream-uk1.radioparadise.com/aac-320", None),
    ("NPR", "http://npr-ice.streamguys1.com/live.mp3", None),
    ("101 Smooth Jazz", "http://jking.cdnstream1.com/b22139_128mp3", None),
    ("Your Classical Relax", "http://relax.stream.publicradio.org/relax.mp3", None),
    ("Ambient Sleeping Pill", "http://radio.stereoscenic.com/asp-h", None),
    ("181.FM Old School", "http://listen.181fm.com/181-oldschool_128k.mp3", None),
  ]},
  {"id": "music", "ytuner": "Musik", "stations": [
    ("Klassik Radio Pure Mozart", "http://stream.klassikradio.de/mozart/mp3-128/vtuner/", None),
    ("Klassik Radio Lounge", "http://stream.klassikradio.de/lounge/mp3-128/www.klassikradio.de/", None),
    ("Klassik Radio Opera", "http://stream.klassikradio.de/opera/mp3-128/www.klassikradio.de/", None),
    ("Radio BOB", "http://streams.radiobob.de/bob-national/mp3-192/mediaplayer", None),
    ("Radio BOB Classic Rock", "http://streams.radiobob.de/bob-classicrock/mp3-192/streams.radiobob.de/", None),
    ("bigFM Sunset Lounge", "http://streams.bigfm.de/bigfm-sunsetlounge-128-mp3", None),
  ]},
]

def get(url, **kw):
    return urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **kw.pop("headers", {})}), timeout=kw.pop("timeout", 15))

def check(url):
    try:
        r = get(url, headers={"Range": "bytes=0-255", "Icy-MetaData": "1"}, timeout=12)
        ct = r.headers.get("Content-Type", ""); br = r.headers.get("icy-br"); fin = r.geturl(); r.close()
        ok = ("audio" in ct or "mpeg" in ct or "aac" in ct) and fin.startswith("http://")
        return ok, ct, br, fin
    except Exception as e:
        return False, "ERR " + str(e)[:40], None, url

def rb_lookup(url, name):
    """Codec/bitrate/logo from Radio Browser: by exact URL, else by name (best-voted, same host)."""
    try:
        items = json.load(get(RB + "byurl?" + urllib.parse.urlencode({"url": url})))
    except Exception:
        items = []
    if not items:
        try:
            q = urllib.parse.urlencode({"name": name, "order": "votes", "reverse": "true", "limit": 10, "hidebroken": "true"})
            host = urllib.parse.urlparse(url).netloc
            items = [i for i in json.load(get(RB + "search?" + q)) if urllib.parse.urlparse(i.get("url_resolved") or i["url"]).netloc == host]
        except Exception:
            items = []
    if not items: return {}
    it = items[0]
    return {"codec": it.get("codec") or None, "bitrate": it.get("bitrate") or None, "logo": it.get("favicon") or None, "rb_name": it.get("name")}

catalog = {"generated": "by scripts/radio-stations.py", "lists": []}
yaml_lines = []
bad = []
for lst in LISTS:
    entry = {"id": lst["id"], "ytunerCategory": lst["ytuner"], "stations": []}
    yaml_lines.append(f"{lst['ytuner']}:")
    for name, url, fm in lst["stations"]:
        ok, ct, icy_br, fin = check(url)
        if not ok:
            bad.append((lst["id"], name, ct, fin)); print(f"  DROP {lst['id']:8} {name:28} {ct} {fin[:60]}"); continue
        meta = rb_lookup(url, name)
        codec = (meta.get("codec") or ("AAC" if "aac" in ct else "MP3")).upper().replace("AAC+", "AAC")
        bitrate = meta.get("bitrate") or (int(icy_br) if icy_br and icy_br.isdigit() else None)
        sid = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        st = {"id": sid, "name": name, "url": url, "codec": codec, "bitrate": bitrate, "fm": fm, "logo": meta.get("logo")}
        entry["stations"].append(st)
        print(f"  ok   {lst['id']:8} {name:28} {codec:4} {str(bitrate):>4}k logo={'yes' if st['logo'] else 'no '}")
        yaml_lines.append(f"  {name}: {url}" + (f"|{st['logo']}" if st["logo"] else ""))
    yaml_lines.append("")
    catalog["lists"].append(entry)

(ROOT / "src/data/radio-stations.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
(ROOT / "ytuner/config/stations.yaml").write_text("\n".join(yaml_lines).rstrip() + "\n")
print(f"\nwrote {sum(len(l['stations']) for l in catalog['lists'])} stations; dropped {len(bad)}")
sys.exit(1 if bad else 0)
