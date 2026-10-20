# Media platform branch (MUSIC_BACKEND=ha)

The plan, rollout phases, rollback and status live in homeserver-cloud: `docs/MEDIA-PLATFORM.md`
(branch `media-platform`). The server agent's tasks are in `ops/bus/tasks/` there.

What this branch changes in the app:
- `src/lib/media-ha.server.ts`: with `MUSIC_BACKEND=ha`, playback, queue, radio, amp power/volume/input and power-on
  go through Home Assistant scripts (`music_state`, `music_play_items`, `music_control`, `play_radio`;
  `music_radio_favourites` until bus task 025, deleted in 026) and the `media_player.r_n500` bridge entity. Since bus
  task 027 the library is a Music Assistant client (`src/lib/library*.ts`, `use-library.ts`, `components/library-screens.tsx`;
  kindle_panel 0.10.0 `library_*` services): Discover, the Library tabs, search, favourites and the MA radio dial read
  Music Assistant; the Jellyfin list views (lists, mixes, artist, search) remain for `MUSIC_BACKEND=app` only. The snapshot reuses `buildMediaSnapshot`
  by projecting the bridge entity onto `AMP.player`, so the screen rules are unchanged.
- In HA mode the legacy queue never resumes or touches the amp, and `/api/voice/{play,action,radio}` answer 409.
- For every mode:
  - YTuner moves to `127.0.0.1:8098`, because Music Assistant needs :8095.
  - No plug cycle.
  - Automatic pushes (advance, replay, re-sync) stop instead of switching the input back, and nothing switches it
    while movie mode is on.
- Playlist in HA mode: with the `kindle_panel` integration installed, the playlist screen shows the whole Music
  Assistant queue and "jump" plays the chosen item (`kindle_panel.get_queue` / `play_index`). Without it, it falls back
  to the list the panel itself sent, or current + next.
- F2 (favourite) says favourites are kept in Music Assistant.
- Mixes in HA mode (bus task 018): Enter on a mix plays the nightly Music Assistant playlist of that mix
  (`script.play_music kind: mix`, query = the mix id, `fallback: false`); homeserver-cloud's `bin/ma-mixes.py` rebuilds
  those playlists every night at 04:45, so the Kindle, the MA app, HA and voice share the same lists. The list title is
  the mix (`music_state` `queue.kind: mix`). Only when MA has no playlist for the mix does the panel build and send its
  own list as before. The Mixes tab itself (ids, labels, track counts) is unchanged.

## Control center: the panel is configured in Home Assistant (`kindle_panel`)

`homeassistant/custom_components/kindle_panel/` is a custom integration (install by copying it to HA's
`custom_components/`, or with HACS as a custom repository). Settings → Devices & services → Kindle Panel → Configure
opens a menu:

| Page | What it sets |
| --- | --- |
| General | language, which tabs and in which order, display names per language |
| Lights | the lights (entity, name, room, icon), the evening scene light |
| Vacuum | vacuum, battery sensor, rooms script, the room toggles |
| Power | the smart plugs with their power/energy sensors |
| Media | music backend (app / HA), amp, DLNA player, TV, movie-mode scripts, sensors |
| Screensaver | idle minutes, minutes per photo, mode, photo sources |
| Schedule | radio duty, wake intervals by day and night, night window, time zone |

The app reads it with `kindle_panel.get_config` (cached for 30 s, so a change shows within 30 s). The bridge
refreshes its wake schedule every 60 s from `/api/voice/panel-schedule`. Without the integration everything runs on
`DEFAULT_CONFIG` (`src/lib/panel-config.ts`) plus the env, exactly as before.
- While HA is unreachable, e.g. during a restart, the panel keeps the last config it got from HA. That includes
  while HA is starting up and kindle_panel's services are not registered yet.
- It goes back to the defaults only when HA is up and twice, a minute apart, has no Kindle Panel entry at all
  (rollback).
- The bridge then also returns to its env schedule.

### Seeding: nothing changes on the first start

On its first start against an HA with `kindle_panel`, the app seeds:
- the config it was running with (`DEFAULT_CONFIG` + env: `UI_LANGUAGE`, `MUSIC_BACKEND`, the schedule variables);
- every photo marked with F1 so far, as kept.

Seeding happens once, and never overwrites what was already edited in HA unless it is forced:
- A page saved in the HA UI before the panel first connected keeps what was saved there. The other pages get the
  panel's setup.
- HA's existing keep/skip decisions win.
- If the marks file can't be read (state dir not mounted), the marks are not handed over yet. The config is seeded,
  and HA keeps asking for the marks on every start.
You can check it under the Kindle Panel device: the kept and skipped photo sensors show the counts.

### Screensaver photos from any HA picture library

Sources are HA's own integrations:
- `Immich · Favourites`: the favourites of every Immich account added with HA's core Immich integration.
- Any folder in HA's media browser: an Immich album, person or tag; local media; or any other media source.
  Pick one or several on the Screensaver page.

F1 = keep (looks good on e-ink) and F4 = skip (never shown again). Both are stored on the Kindle Panel device in HA
(`kindle_panel.mark_photo`, `.storage/kindle_panel.photo_marks`), keyed by the Immich asset id. A photo kept in your
favourites stays kept when it also appears in an album.

Modes:
- `curate` (default, as before): unjudged photos first, then the kept ones.
- `all_but_skipped`: every photo except the skipped ones.
- `kept_only`: only kept photos.

The screensaver uses the app's own Immich connection, as before, in three cases:
- `kindle_panel` is missing;
- HA has no photos at all, e.g. HA's Immich integration is not added or not loaded yet;
- HA is unreachable, e.g. restarting.

F1/F4 marks still go to HA in the second case, keyed by the same Immich asset ids. Photos are fetched with the HA
token only from HA itself. A source that resolves to another host gets no credentials.

### When no photos are connected: black-and-white art from Unsplash

When none of the sources above gives a photo, the screensaver shows a black-and-white photo from Unsplash, credited on
the screen ("Photo by <name> on Unsplash", Unsplash's wording; the panel cannot show links). That covers no library set up, HA's Immich not added yet, Immich
unreachable, or everything skipped.
- **With an Unsplash access key** (free at unsplash.com/developers; HA → Kindle Panel → Configure → Screensaver, or
  `UNSPLASH_ACCESS_KEY` in the app env): photos for the search on that page, default "black and white art", portrait.
  They are fetched in batches of 20, well inside a demo key's 50 requests an hour.
  - The key stays on the server: it is never sent to the browser, not even back to the HA options page. Leaving the
    field empty keeps the stored key; a checkbox removes it.
  - A refused key or a rate limit falls back to the keyless Lorem Picsum path.
- **Without a key:** random grayscale Unsplash photos through Lorem Picsum (picsum.photos). They are not picked by
  subject.
- **Offline:** the bundled sample photo, with a 5-minute pause before trying again. A new key or search tries
  again at once.
- Setting "When no photos are connected" to *the built-in sample photo* turns this off.
- F4 shows the next photo. F1 does nothing on these photos, since they aren't yours to curate.

### Screensaver cards

Screensaver page → **Cards**: up to 3, in order. Card types:
- **Outdoor:** the weather entity.
- **Indoor:** temperature and humidity sensors (General page).
- **Calendar**.
- **Sensor:** any entity's state with its unit, a label (translated through the names list) and an icon. The icons
  are thermometer, droplets, gauge, zap, plug, wind, sun, leaf, home and battery.

The default is Outdoor, Indoor, Calendar, as before. Fewer cards share the width.

### Verified

- `kindle_panel`: 18 pytest tests (`homeassistant/tests`).
- App: 185 vitest tests.
- A third independent review: no blockers. Its important findings are fixed.
- A second independent review: 1 blocker and 6 important findings, all fixed with regression tests.
- Screenshot regression: every tab at 600×800 in demo mode, in Hebrew and in English, is pixel-identical between
  `main` and this branch. With the default cards and no network, the screensaver is identical too. The check uses puppeteer-core with the preinstalled Chromium and runs pixelmatch with
  threshold 0.
