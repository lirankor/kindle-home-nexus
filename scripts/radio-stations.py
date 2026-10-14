#!/usr/bin/env python3
"""Build the radio station catalog.

Input:  the LISTS below ((name, plain http stream URL, FM MHz or None[, logo URL or None]), verified by hand / this script).
        A 4th item pins the logo (None = none on purpose: the app renders a cover-forge placeholder); otherwise Radio
        Browser's favicon is used. Every logo is checked to be an image (audit 2026-10-15: 26 of 71 were pages/404s/16 px icons).
Output: src/data/radio-stations.json   (used by the app: lists, names, bitrate, codec, logo, FM freq)
        ytuner/config/stations.yaml     (served to the amp's NET RADIO by YTuner; NO comment lines!)

Every URL is checked (HTTP 200, audio/* content type). The Yamaha R-N500 only plays plain http MP3/AAC, so
https sources are marked relay=true and served to the amp through relay/ (RELAY_BASE). HLS is not supported. Bitrate/codec/logo come from the Radio Browser API when it knows the URL.
Run:  python3 scripts/radio-stations.py   (needs internet; stdlib only)
"""
import json, re, ssl, sys, urllib.parse, urllib.request, pathlib

UA = {"User-Agent": "kindle-home-nexus/1.0"}
# Stations whose stream is https (or redirects to https) are played through relay/ (plain http for the amp).
RELAY_BASE = "http://192.168.1.15:8792/s/"
RB = "http://de1.api.radio-browser.info/json/stations/"
ROOT = pathlib.Path(__file__).resolve().parent.parent

# The local list is kept in ascending FM order on purpose: the Kindle dial shows the frequencies left→right.
LISTS = [
  {"id": "local", "ytuner": "Duesseldorf FM", "stations": [
    ("WDR 5", "http://wdr-wdr5-live.icecast.wdr.de/wdr/wdr5/live/mp3/128/stream.mp3", 88.8),
    ("NRW1", "http://stream.nrw1.de/nrw1/stream/mp3", 92.6, None),
    ("WDR 3", "http://wdr-wdr3-live.icecast.wdr.de/wdr/wdr3/live/mp3/128/stream.mp3", 95.1),
    ("Deutschlandfunk Kultur", "http://st02.sslstream.dlf.de/dlf/02/128/mp3/stream.mp3", 96.5),
    ("WDR 2", "http://wdr-wdr2-rheinruhr.icecast.wdr.de/wdr/wdr2/rheinruhr/mp3/128/stream.mp3", 99.2),
    ("WDR 4", "http://wdr-wdr4-live.icecast.wdr.de/wdr/wdr4/live/mp3/128/stream.mp3", 101.3),
    ("Deutschlandfunk", "http://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3", 102.8),
    ("COSMO", "http://wdr-cosmo-live.icecast.wdr.de/wdr/cosmo/live/mp3/128/stream.mp3", 103.3, "https://www1.wdr.de/radio/cosmo/resources-v5.181.2/img/favicon/apple-touch-icon.png"),
    ("Antenne Duesseldorf", "http://stream.antenneduesseldorf.de/444z5kv", 104.2, "https://logos-der-nrwlokalradios.s3.eu-central-1.amazonaws.com/0153-37-45.png"),
    ("bigFM", "http://streams.bigfm.de/bigfm-deutschland-128-mp3", 105.7, "https://file.atsw.de/production/static/1791270044062/icons/icon_512.cWprpqopSeo.png"),
    ("1LIVE", "http://wdr-1live-live.icecast.wdr.de/wdr/1live/live/mp3/128/stream.mp3", 106.7),
    ("Deutschlandfunk Nova", "http://st03.sslstream.dlf.de/dlf/03/128/mp3/stream.mp3", None),
  ]},
  {"id": "israel", "ytuner": "Israel", "stations": [
    ("Galgalatz", "http://glzwizzlv.bynetcdn.com/glglz_mp3", 91.8, "https://upload.wikimedia.org/wikipedia/commons/e/e2/GLGLZ.svg"),
    ("Kol Barama", "http://kb.cdnwz.net/kol_barama", 92.1, "https://kol-barama.co.il/wp-content/themes/qs-starter/images/favicon/apple-touch-icon-180x180.png"),
    ("Kol Chai", "https://media2.93fm.co.il/live-new", 93.0, "https://upload.wikimedia.org/wikipedia/he/b/b3/Radiokolhi.jpeg"),
    ("Kan Bet", "https://28563.live.streamtheworld.com/KAN_BET.mp3", 95.5, "https://upload.wikimedia.org/wikipedia/commons/5/50/KanBet.svg"),
    ("Galei Zahal", "http://glzwizzlv.bynetcdn.com/glz_mp3", 96.6, "https://glz.co.il/favicons/glz/favicon-192x192.png"),
    ("Radio Darom", "https://cdn.cybercdn.live/Darom_97FM/Live/icecast.audio", 97.0),
    ("Kan Gimel", "https://27873.live.streamtheworld.com/KAN_GIMMEL.mp3", 97.8, "https://upload.wikimedia.org/wikipedia/commons/3/39/KanGimel.svg"),
    ("Eco 99", "https://eco01.livecdn.biz/ecolive/99fm_aac/icecast.audio", 99.0, "https://eco99fm.maariv.co.il/assets/images/eco99seo.jpeg"),
    ("Radios 100FM", "https://cdn.cybercdn.live/Radios_100FM/Audio/icecast.audio", 100.0),
    ("Radio Tel Aviv 102", "http://102.livecdn.biz/102fm_aac", 102.0, "https://www.102fm.co.il/seo_image.jpg"),
    ("Galey Yisrael", "https://cdn.cybercdn.live/Galei_Israel/Live/icecast.audio", 102.5, "https://www.gly.co.il/static/images/webclip.png"),
    ("103FM", "https://cdn.cybercdn.live/103FM/Live/icecast.audio", 103.0),
    ("Kol Hashfela", "https://radio.streamgates.net/stream/1036kh", 103.6, "https://static.wixstatic.com/media/cbf57a_58fc13152b9548a882cc9f731c4c1e35.jpg/v1/fill/w_512,h_512,lg_1,usm_0.66_1.00_0.01/cbf57a_58fc13152b9548a882cc9f731c4c1e35.jpg"),  # moved off cdnwz 2026-10 (404)
    ("Kan Tarbut", "https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_TARBUT.mp3", 106.5, "https://upload.wikimedia.org/wikipedia/commons/e/ed/KanTarbutNewLogo.svg"),
    ("Radio Haifa", "https://1075.livecdn.biz/radiohaifa", 107.5, "https://upload.wikimedia.org/wikipedia/he/3/3f/1075fm.png"),
    ("Kan Kol HaMusica", "https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_KOL_HAMUSICA.mp3", None, "https://upload.wikimedia.org/wikipedia/he/c/cf/KolHamusica.jpg"),
    ("Radio Lev Hamedina", "http://cdn.cybercdn.live/Lev_Hamedina/Audio/icecast.audio", None, "https://upload.wikimedia.org/wikipedia/commons/0/04/%D7%A1%D7%9E%D7%9C_%D7%A8%D7%93%D7%99%D7%95_%D7%9C%D7%91_%D7%94%D7%9E%D7%93%D7%99%D7%A0%D7%94.png"),
    ("Hakatze", "http://kzradio.mediacast.co.il/kzradio_live/kzradio/icecast.audio", None),
  ]},
  {"id": "english", "ytuner": "English", "stations": [
    ("BBC World Service", "http://stream.live.vc.bbcmedia.co.uk/bbc_world_service", None, "https://sounds.files.bbci.co.uk/3.12.0/networks/bbc_world_service/blocks-colour_600x600.png"),
    ("Classic FM", "http://ice-the.musicradio.com/ClassicFMMP3", None, "https://www.classicfm.com/assets_v4r/classic/img/favicon-196x196.png"),
    ("LBC", "http://media-sov.musicradio.com/LBC973MP3Low", None, "https://www.lbc.co.uk/apple-touch-icon.png"),
    ("Capital FM London", "http://media-ice.musicradio.com/CapitalMP3", None, "https://www.capitalfm.com/assets_v4r/capital/img/favicon-196x196.png"),
    ("Heart London", "http://ice-sov.musicradio.com/HeartLondonMP3", None, "https://www.heart.co.uk/assets_v4r/heart/img/favicon-196x196.png"),
    ("Smooth Radio", "http://media-the.musicradio.com/SmoothEastMids", None, "https://www.smoothradio.com/assets_v4r/smooth/img/favicon-196x196.png"),
    ("Radio X", "http://icecast.thisisdax.com/RadioXUKMP3", None),
    ("Radio Caroline", "http://78.129.202.200:8040/;", None, "https://www.radiocaroline.co.uk/images/logo_for_fb.jpg"),
    ("Radio Paradise", "http://stream-uk1.radioparadise.com/aac-320", None),
    ("NPR", "http://npr-ice.streamguys1.com/live.mp3", None, "https://media.npr.org/templates/favicon/favicon-180x180.png"),
    ("101 Smooth Jazz", "http://jking.cdnstream1.com/b22139_128mp3", None),
    ("Your Classical Relax", "http://relax.stream.publicradio.org/relax.mp3", None),
    ("Ambient Sleeping Pill", "http://radio.stereoscenic.com/asp-h", None, "https://ambientsleepingpill.com/logo.png"),
    ("181.FM Old School", "http://listen.181fm.com/181-oldschool_128k.mp3", None, "https://www.181.fm/images/og181fmlogo.jpg"),
  ]},
  # Music band: Radios 100FM's ad-free digital channels (digital.100fm.co.il, verified 2026-10-14; the 4th tuple
  # item is the channel's own cover art), then the German music stations. The FM live station stays in "israel".
  {"id": "music", "ytuner": "Musik", "stations": [
    ("100FM Hits", "http://gb25.streamgates.net/radios-audio/100Hits/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-hits.png"),
    ("100FM 70s", "http://gb25.streamgates.net/radios-audio/10070s/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-70s.png"),
    ("100FM 80s", "http://gb25.streamgates.net/radios-audio/10080s/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-80s.png"),
    ("100FM 90s", "http://gb25.streamgates.net/radios-audio/10090s/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-90s.png"),
    ("100FM 2000s", "http://gb25.streamgates.net/radios-audio/1002000s/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-2000s.png"),
    ("100FM Oldies", "http://gb25.streamgates.net/radios-audio/100Oldies/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-oldies.png"),
    ("100FM Nostalgia", "http://gb25.streamgates.net/radios-audio/100Nostalgia/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-nostalgia.png"),
    ("100FM Israeli", "http://gb25.streamgates.net/radios-audio/100Israeli/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-israeli.png"),
    ("100FM Mizrahit", "http://gb25.streamgates.net/radios-audio/100Mizrachit/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-mizrachit.png"),
    ("100FM Rock", "http://gb25.streamgates.net/radios-audio/100Rock/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-rock.png"),
    ("100FM Classic Rock", "http://gb25.streamgates.net/radios-audio/100ClassicRock/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-classicrock.png"),
    ("100FM Dance", "http://gb25.streamgates.net/radios-audio/100Dance/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-dance.png"),
    ("100FM Jazz", "http://gb25.streamgates.net/radios-audio/100Jazz/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-jazz.png"),
    ("100FM Blues", "http://gb25.streamgates.net/radios-audio/100Blues/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-blues.png"),
    ("100FM Classic", "http://gb25.streamgates.net/radios-audio/100Classic/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-classic.png"),
    ("100FM Chillout", "http://gb25.streamgates.net/radios-audio/100Chillout/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-chillout.png"),
    ("100FM Cafe", "http://gb25.streamgates.net/radios-audio/100Cafe/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-cafe.png"),
    ("100FM Love", "http://gb25.streamgates.net/radios-audio/100Love/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-love.png"),
    ("100FM Movies", "http://gb25.streamgates.net/radios-audio/100Movies/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-movies.png"),
    ("100FM Kids", "http://gb25.streamgates.net/radios-audio/100Kids/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-kids.png"),
    ("100FM Disney", "http://gb25.streamgates.net/radios-audio/100Disney/icecast.audio", None, "https://d203uamca1bsc4.cloudfront.net/app/thumbnails/t-disney.png"),
    ("Klassik Radio Pure Mozart", "http://stream.klassikradio.de/mozart/mp3-128/vtuner/", None),
    ("Klassik Radio Lounge", "http://stream.klassikradio.de/lounge/mp3-128/www.klassikradio.de/", None),
    ("Klassik Radio Opera", "http://stream.klassikradio.de/opera/mp3-128/www.klassikradio.de/", None),
    ("Radio BOB", "http://streams.radiobob.de/bob-national/mp3-192/mediaplayer", None, "https://upload.radiobob.de/production/static/1791270449174/icons/icon_512.8WpccMNcjjc.png"),
    ("Radio BOB Classic Rock", "http://streams.radiobob.de/bob-classicrock/mp3-192/streams.radiobob.de/", None, "https://images.radiobob.de/files/2025-05/classic_rock_stream_schrift.jpg"),
    ("bigFM Sunset Lounge", "http://streams.bigfm.de/bigfm-sunsetlounge-128-mp3", None, "https://image.atsw.de/atsw/production/2024-07/bigfm-sl-web-clean-1600x1600.jpg"),
  ]},
]

# macOS python often lacks a CA bundle; the stream check then falls back to an unverified context
# (this only checks that a stream exists; the relay container verifies TLS itself).
_ctx = ssl.create_default_context()
def get(url, **kw):
    req = urllib.request.Request(url, headers={**UA, **kw.pop("headers", {})})
    timeout = kw.pop("timeout", 15)
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_ctx)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e): raise
        return urllib.request.urlopen(req, timeout=timeout, context=ssl._create_unverified_context())

def check(url):
    try:
        r = get(url, headers={"Range": "bytes=0-255", "Icy-MetaData": "1"}, timeout=12)
        ct = r.headers.get("Content-Type", ""); br = r.headers.get("icy-br"); fin = r.geturl(); r.close()
        audio = "audio" in ct or "mpeg" in ct or "aac" in ct
        # ok = playable directly; relay = playable but only via the https->http relay
        return audio and fin.startswith("http://"), ct, br, fin, audio
    except Exception as e:
        return False, "ERR " + str(e)[:40], None, url, False

def check_logo(url):
    """Keep a logo only when the URL really answers an image (web pages and dead links used to reach the catalog;
    the app then shows a cover-forge placeholder instead). Explicit None in LISTS = no logo on purpose.
    Wikimedia logos: use the ORIGINAL .svg (sharp rasterises it; the /thumb/ renderer rate-limits with 429)."""
    if not url: return None
    for attempt in range(3):
        try:
            r = get(url, headers={"Accept": "image/*,*/*;q=0.5"}, timeout=12); ct = r.headers.get("Content-Type", ""); r.read(64); r.close()
            if r.status == 200 and ct.startswith("image/"): return url
            print(f"    logo dropped ({r.status} {ct[:30]}): {url[:80]}"); return None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:  # Wikimedia rate limit: transient, not a bad URL
                import time; time.sleep(15); continue
            print(f"    logo dropped ({e.code}): {url[:80]}"); return None
        except Exception as e:
            print(f"    logo dropped ({str(e)[:40]}): {url[:80]}"); return None
    print(f"    logo kept unverified (rate-limited): {url[:80]}"); return url

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
    for name, url, fm, *extra in lst["stations"]:
        has_override = bool(extra)
        logo_override = extra[0] if extra else None
        ok, ct, icy_br, fin, audio = check(url)
        relay = (not ok) and audio
        if not ok and not relay:
            bad.append((lst["id"], name, ct, fin)); print(f"  DROP {lst['id']:8} {name:28} {ct} {fin[:60]}"); continue
        meta = rb_lookup(url, name)
        codec = (meta.get("codec") or ("AAC" if "aac" in ct else "MP3")).upper().replace("AAC+", "AAC")
        bitrate = meta.get("bitrate") or (int(icy_br) if icy_br and icy_br.isdigit() else None)
        sid = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        play_url = RELAY_BASE + sid if relay else url
        st = {"id": sid, "name": name, "url": url, "playUrl": play_url, "relay": relay, "codec": codec, "bitrate": bitrate, "fm": fm, "logo": check_logo(logo_override if has_override else meta.get("logo"))}
        entry["stations"].append(st)
        print(f"  {'relay' if relay else 'ok   '} {lst['id']:8} {name:28} {codec:4} {str(bitrate):>4}k logo={'yes' if st['logo'] else 'no '}")
        yaml_lines.append(f"  {name}: {play_url}" + (f"|{st['logo']}" if st["logo"] else ""))
    yaml_lines.append("")
    catalog["lists"].append(entry)

(ROOT / "src/data/radio-stations.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
(ROOT / "ytuner/config/stations.yaml").write_text("\n".join(yaml_lines).rstrip() + "\n")
print(f"\nwrote {sum(len(l['stations']) for l in catalog['lists'])} stations; dropped {len(bad)}")
sys.exit(1 if bad else 0)
