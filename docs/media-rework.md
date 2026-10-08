# Media rework — build spec (agreed with the user 2026-10-08)

Everything the app talks to lives on pop-os. Hard facts below were verified on the real hardware on
2026-10-08; do not "fix" them from general knowledge. Conventions in `AGENTS.md` still apply (Hebrew RTL,
`t()` strings in both languages, 600x800 e-ink, soft keys F1..F4, display-only cards → full-page modals,
`data-eink-refresh`, no fonts from the network).

## Devices and endpoints

| Thing | Where | Notes |
|---|---|---|
| Home Assistant | `HA_BASE_URL` + `HA_TOKEN` (existing `src/lib/home.server.ts`) | REST only |
| Amp (Yamaha R-N500) in HA | `media_player.r_n500_main` (custom `yamaha_ynca` 9.7.0) | attrs: `state` on/off/playing/idle, `source`, `volume_level` 0..1, `media_title`, `media_artist`, `media_album_name`, `media_channel`, `media_content_type`; `number.r_n500_main_volume_db` (-80.5..16.5 step 0.5); `switch.r_n500_main_all_zones_power`; `remote.r_n500_main_remote` |
| Amp as DLNA renderer in HA | `media_player.yamaha_r_n500` (`dlna_dmr`, manual URL) | state/position only; **its volume is wrong (0.0)**, use YNCA for volume |
| Amp XML API | `POST http://192.168.1.25/YamahaRemoteControl/ctrl` (env `AMP_HOST`) | body `<YAMAHA_AV cmd="GET|PUT">…</YAMAHA_AV>`, `Content-Type: text/xml`, reply `<YAMAHA_AV rsp=… RC="0">` |
| Amp UPnP AVTransport | `http://192.168.1.25:8080/AVTransport/ctrl` (SOAP, service `urn:schemas-upnp-org:service:AVTransport:1`) | desc `http://192.168.1.25:8080/MediaRenderer/desc.xml` |
| Amp YNCA (HA uses it) | tcp 192.168.1.25:50000 | do NOT open a second connection from the app |
| TV | `media_player.bravia_xr_65x90k` (braviatv) | existing |
| Media plug (TV + amp strip) | `switch.smart_switch_23081678814571510d0548e1e9d69992_outlet` | power sensor `sensor.…_power` |
| Movie mode | `script.movie_mode`, `script.movie_mode_off`, `input_boolean.movie_mode_active` | existing |
| Jellyfin | `JELLYFIN_URL=http://192.168.1.15:8096`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID` (user "Music") | header `Authorization: MediaBrowser Token="…"`; 17k tracks, 2.3k albums, 881 album artists, ~90% MP3 / 6% FLAC |
| YTuner (NET RADIO backend) | from the app container: `http://ytuner/` (compose service, port 80); from the amp: `http://radioyamaha.vtuner.com` | our station catalog `src/data/radio-stations.json` is the source of truth; `scripts/radio-stations.py` regenerates it and `ytuner/config/stations.yaml` |
| HA yamaha_ynca config entry | `01M0ZMQXMTWAAW7BXTBCXD1YZR` | `POST /api/config/config_entries/entry/<id>/reload` reconnects instantly after the amp was powered |

## Verified amp behaviour

- **Power-on routine**: plug on → amp reachable (tcp 80) after ~60–90 s, in standby → `POST reload` of the
  yamaha_ynca entry (otherwise HA's setup_retry backoff takes many minutes) → `media_player.turn_on` →
  select source. Total ≈ 2 min. Show progress on the panel.
- **Sources** (HA `select_source` names): `SERVER` (DLNA push / Jellyfin), `CD` (TV via Bluetooth adapter), `PHONO`, `TUNER` (FM), `NET RADIO` (YTuner).
- **Volume**: `media_player.volume_set` on `media_player.r_n500_main` (0..1) or `number.set_value` on
  `number.r_n500_main_volume_db`. One 5-way press = 2 dB. Show dB from `number.r_n500_main_volume_db`.
- **FM (TUNER)**: HA attrs `media_channel` ("FM 102.80 MHz" or RDS name), `media_title` (RDS text), `preset`.
  Recall preset: `play_media` type `music`, id `tun:preset:N`. **Never auto-seek** (it disconnects HA for ~60 s);
  direct frequency via XML `<Tuner><Play_Control><Tuning><Freq><FM><Val>10280</Val><Exp>2</Exp><Unit>MHz</Unit></FM></Freq></Tuning></Play_Control></Tuner>` is fine.
  Reception with the wire antenna is weak (mono); FM is a secondary list only.
- **NET RADIO via XML** (all verified):
  - `PUT <Main_Zone><Input><Input_Sel>NET RADIO</Input_Sel></Input></Main_Zone>`
  - `PUT <NET_RADIO><List_Control><Cursor>Return to Home</Cursor></List_Control></NET_RADIO>` → top menu
    (`Stations`, `Favourites`, `Radio Browser`, in this order = lines 1..3; configured in ytuner/config/avr.ini [MainMenu Items]).
  - `GET <NET_RADIO><List_Info>GetParam</List_Info></NET_RADIO>` → `Menu_Status` (Ready/Busy), `Menu_Layer`,
    `Menu_Name`, `Current_Line`, `Max_Line`, `Current_List/Line_1..8` (`Txt`, `Attribute` Container/Item/Unselectable). Poll until Ready.
  - `PUT <NET_RADIO><List_Control><Direct_Sel>Line_k</Direct_Sel></List_Control></NET_RADIO>` selects window line k (1..8).
  - **Tune by index**: `PUT <NET_RADIO><List_Control><Jump_Line>N</Jump_Line></List_Control></NET_RADIO>` (1-based, any page) then
    `PUT <NET_RADIO><List_Control><Cursor>Sel</Cursor></List_Control></NET_RADIO>`. Each step: wait ≥1.5 s / poll `Menu_Status=Ready`.
    Station order inside a category = order in `stations.yaml` = order in `radio-stations.json`. Categories in `My Stations` are in file order.
  - `GET <NET_RADIO><Play_Info>GetParam</Play_Info></NET_RADIO>` → `Playback_Info` (Play/Stop), `Station`, `Song`.
  - HA mirrors it: `media_player.r_n500_main` state `playing`, `media_channel` = station, `media_title` = song.
  - Favourites: YTuner bookmarks. Add = GET the station's `<Bookmark>` URL from YTuner's station XML
    (`http://ytuner/setupapp/favxml.asp?id=<StationId>&fav=add`, Host header `radioyamaha.vtuner.com`); list = `http://ytuner/ytuner/bookmark?ytuner=true&mac=KINDLE&fver=W&dlang=eng&startitems=1&enditems=100`.
    Station XML: `http://ytuner/ytuner/mystations/<Category>?ytuner=true&mac=KINDLE&fver=W&dlang=eng&startitems=1&enditems=100` → `StationId`, `StationName`, `StationUrl`, `Logo`, `Bookmark`.
  - Switching the amp input to NET RADIO or selecting lists can take 3–6 s; keep the UI responsive with optimistic state.
- **DLNA push (Jellyfin)**: only works when source is `SERVER` (else UPnP 501). Use raw SOAP from our server:
  `SetAVTransportURI` (InstanceID 0, CurrentURI, CurrentURIMetaData = DIDL-Lite with `dc:title`, `upnp:artist`,
  `upnp:album`, `upnp:albumArtURI`, `res protocolInfo="http-get:*:audio/mpeg:*"`), `SetNextAVTransportURI` (same shape),
  `Play` (Speed 1), `Stop`, `Seek` (Unit REL_TIME, Target H:MM:SS), `GetPositionInfo` (RelTime, TrackDuration, TrackURI),
  `GetTransportInfo`. **`Pause` returns 501** on pushed streams (use Stop, resume = re-push + Seek). The amp does NOT report
  STOPPED at the end of a track (RelTime keeps counting): advance by our own duration timer, confirmed by `TrackURI` /
  `RelTime` from `GetPositionInfo`; prefer `SetNextAVTransportURI` right after `Play` for gapless (verify once on the device, untested).
  Stream URL: `${JELLYFIN_URL}/Audio/<id>/stream.mp3?static=true&api_key=…` for mp3/flac/aac/wma (amp plays them natively);
  ogg/opus → `/Audio/<id>/universal?…&container=mp3&audioCodec=mp3&api_key=…`. Art: `/Items/<id>/Images/Primary?maxWidth=200` (no auth needed).
  Title/artist/album on the amp display come from the DIDL metadata we send (YNCA then shows them in HA).
- **Jellyfin endpoints** (userId = `JELLYFIN_USER_ID`): `/Users/{u}/Items?IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=…`,
  `…IncludeItemTypes=MusicAlbum…`, `/Artists/AlbumArtists?userId=…&sortBy=Random`, `/Items/{id}/InstantMix?userId=…&limit=…`,
  `/Users/{u}/Suggestions?type=Audio`, recently played albums `…IncludeItemTypes=MusicAlbum&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed`,
  `/Genres?userId=…&IncludeItemTypes=Audio` (12 genres), album tracks `/Users/{u}/Items?ParentId=<album>&SortBy=SortName`.

## Screens (all 600x800, Hebrew default, soft keys F1..F4 left→right)

### Media tab (replaces the current one)
Read-only cards: **TV** (state, app/input if known), **Amp** (power, source, now playing one-liner: NET RADIO station /
Jellyfin title / FM channel), **Movie mode** (on/off). Footer: F1 מצב סרט (toggle), F2 טלוויזיה (power), F3 מגבר
(opens amp view), F4 blank. Enter on the amp card = amp view. Enter on TV card = TV modal (power, mute, source if cheap).

### Amp view (full page)
Now-playing header: source badge, title / artist / album (or station / song), album art (server-resized 160px grayscale, `data-eink-photo`? no — plain img, dithered by CSS is fine), progress bar for Jellyfin (our timer).
**5-way**: up/down = volume ±2 dB shown on the SAME retro dial bar as the radio (docs/design/radio-dial-reference.svg): needle = volume position on a -80…+16 dB scale, caption "dB", big numeric readout next to it (user 2026-10-08: "tuner is still a basic circle, use controls.svg"; no circle knob); left/right = next/prev
(Jellyfin queue, radio station in the current list, FM preset). Enter = play/pause (Jellyfin) / nothing (radio).
Footer: F1 חזרה (back to Media tab), F2 מוזיקה (Jellyfin screen), F3 מקור (source list), F4 הפעלה/כיבוי (amp power;
if off → runs the power-on routine with progress text, then restores last source).
Source list = list picker (icon – title – detail): ג׳ליפין (SERVER), טלוויזיה (CD), פטיפון (PHONO), רדיו (NET RADIO), FM (TUNER).
Up/down highlights, Enter or F4 applies; F1 cancels. Selecting רדיו opens the radio screen; ג׳ליפין opens the music screen.

### Radio screen
Lists ("bands"): **מועדפים** (YTuner bookmarks), **דיסלדורף** (local), **ישראל** (israel), **אנגלית** (english) — from `radio-stations.json`
(+ bookmarks from YTuner). FM presets appear as a fifth, secondary list only if cheap.
Layout: band switch row (4 slots, active filled), **one retro dial bar** (not full screen) drawn after
`docs/design/radio-dial-reference.svg` (user-supplied 2026-10-08): a single horizontal black bar made of block segments
(thick solid ends, short dashes between), a thick rounded vertical needle crossing the bar at the current station,
labels above the bar (the list name at the left end like "AM"/"FM" in the reference, then station names or FM MHz for the
local list) and below it. Render it as inline SVG scaled to the full width (600 px minus margins), ~140 px tall, pure black on white. Below: station name
large, song line, bitrate · codec small, station logo (server-resized 96px grayscale PNG, cached) left of the name.
5-way: up/down volume (knob + dB), left/right = previous/next station in the current list (tunes immediately: Jump_Line + Sel),
Enter = open the station list of the current band (list rows: logo – name – "128k MP3", up/down highlight, Enter tunes).
Footer: F1 חזרה, F2 רשימה (band picker: 4 lists), F3 הוסף/הסר מועדפים, F4 הפעלה/כיבוי.
Implemented (M3, 2026-10-08): the dial is `DialBar` in `src/components/dial-bar.tsx` (geometry, label planning and the
volume scale in `src/lib/radio-dial.ts`), used three times: the station dial (needle on the station, "<|>" arrows at the
needle top, band name as the caption), a compact volume dial under it on the radio screen, and the amp view's volume (needle
= dB on a -80.5…+16.5 scale, ticks -80…+16.5, value beside the needle, big readout under the bar; no circle knob). There is
no band row: F3 cycles the band (label = the next band), F2 adds / removes the favourite ("הוסף/הסר ממועדפים"), F1 back,
F4 power. Enter = station list (8 rows, F2/F3 previous/next page, Enter/F4 tunes, F1 back). Band + index per band persist
in `kindle-panel-state` (`radio`); the needle follows `nowPlaying.stationId` (the band the user is on first, then
favourites, then the rest) whenever the server reports a new station. Left/right call `tuneRadioStation` directly and
coalesce quick presses. Amp off: tuning starts the power-on routine with NET RADIO and tunes the chosen station once it is done.
Tuning path on the amp: ensure input NET RADIO → Return to Home → Line_1 (Stations) → Jump_Line <category index> + Sel →
Jump_Line <station index> + Sel. Favourites list: Line_2 (Favourites) → Jump_Line <bookmark index> + Sel. Remember the current
list/index server-side so the UI doesn't re-walk menus when it isn't needed (check `List_Info` `Menu_Name` first).

### Music screen (Jellyfin)
Tabs via 5-way left/right at the top: מיקסים – מומלצים – אמנים – אלבומים – המשך. Lists: image/icon left, title + detail right,
8 rows per page, F1/F2 = previous/next page, up/down highlight, Enter plays (album → its tracks as queue; mix → the mix;
artist → random album of the artist). Mixes generated server-side on load: Daily mix (InstantMix of a random favourite/played track),
Discover (random tracks never played), Relaxed (genres Ambient/Classical/Jazz/Acoustic), Evening (Blues/Jazz/Vocal/Lounge). No keyboard.
Playing: select SERVER if needed → push track 1 with metadata → SetNext track 2 → our queue state (server-side, in-memory + JSON file
in `/data` volume) drives progress and advance. F4 on this screen = back to amp view.
Implemented (M4, 2026-10-08): `MusicScreen` in `src/components/media-screens.tsx`, state in `useMediaPanel` (music section).
Tabs row at the top (active filled black; left/right in reading order, so in Hebrew the first tab is at the right end), 8 rows
per page (cover from `/media/img?item=…&w=56`, glyph per kind when there is none), F2/F3 = previous/next page (greyed at the
ends, page counter "n/m" bottom-left), up/down cross page edges, Enter plays, F1 back to the amp view, F4 power (not "back":
the footer stays the same as the other screens). Mix ids are named client-side (`music.mix.*` in i18n) with a one-line
description; a bare number in `detail` is a track count (mix) or album count (artist). Lists are fetched per tab and page
(`["musicList", tab, page]`, 5 min stale) so returning to a tab is instant. Tab + page per tab persist in `kindle-panel-state`
(`music`). Play: optimistic "מנגן: …" status line, `playMusic`, then the amp view opens with the returned queue written into
the snapshot cache until the next poll. Amp off: the power-on routine starts with SERVER and the choice plays when it reaches
"done". Amp view with music: Enter sends queue `pause` while playing and `resume` otherwise (never `toggle`), left/right =
queue previous/next, the progress bar counts on client-side from `positionMs` with a 1 s ticker that only runs while the amp
view shows playing music; "n of N" sits under the bar, "· paused" appended while paused. Demo mode plays the four demo tracks
locally without any server call.

### Pickers rework (existing light modals)
Replace card grids with lists (icon – title – detail). Colour/shade lists apply immediately on up/down. Up/down replaces left/right.

### Later (not now)
Screensaver shows now playing + the same 5-way volume/next/prev. Stream relay container (ffmpeg → plain http MP3) for HTTPS/HLS stations (Kan, BBC national). Weather card.

## Milestones (each: tests pass, `docker compose up -d --build` on pop-os, Kindle screenshot via bridge checked)
1. **Server plumbing**: `src/lib/media.server.ts` (amp XML client, AVTransport SOAP client, YTuner client, Jellyfin client, image resize via sharp to grayscale PNG with disk cache), `src/lib/media.functions.ts` server functions, types in `src/lib/media.ts`, env in `.env.example`, demo data without env, unit tests for parsers (List_Info XML, Play_Info, YTuner XML, DIDL builder, queue advance).
2. **Media tab + amp view + power-on routine + source list** (volume on 5-way).
3. **Radio screen** (dial bar, lists, favourites, tune by index).
4. **Music screen** (Jellyfin lists, mixes, queue/gapless, now playing progress).
5. **Pickers rework** for lights.
