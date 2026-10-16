# Media platform branch (MUSIC_BACKEND=ha)

The plan, rollout phases, rollback and status live in homeserver-cloud: `docs/MEDIA-PLATFORM.md`
(branch `media-platform`). The server agent's tasks are in `ops/bus/tasks/` there.

What this branch changes in the app:
- `src/lib/media-ha.server.ts`: with `MUSIC_BACKEND=ha`, playback, queue, radio, amp power/volume/input and power-on
  go through Home Assistant scripts (`music_state`, `music_play_items`, `music_control`, `play_radio`,
  `music_radio_favourites`) and the `media_player.r_n500` bridge entity. The library views (lists, mixes, search, art)
  still read Jellyfin; MA plays the same items as `jellyfin://track/<id>`. The snapshot reuses `buildMediaSnapshot`
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

The app reads it with `kindle_panel.get_config` (cached for 30 s; refreshed immediately when the options change). The
bridge refreshes its wake schedule every 60 s from `/api/voice/panel-schedule`. Without the integration everything
runs on `DEFAULT_CONFIG` (`src/lib/panel-config.ts`) plus the env, exactly as before.

### Seeding: nothing changes on the first start

On its first start against an HA with `kindle_panel`, the app seeds:
- the config it was running with (`DEFAULT_CONFIG` + env: `UI_LANGUAGE`, `MUSIC_BACKEND`, the schedule variables);
- every photo marked with F1 so far, as kept.

Seeding never overwrites what was already edited in HA unless it is forced, and HA's existing keep/skip decisions win.
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

When `kindle_panel` is missing, the screensaver uses the app's own Immich connection, as before.

### Verified

- `kindle_panel`: 12 pytest tests (`homeassistant/tests`).
- App: 170 vitest tests.
- Screenshot regression: every tab at 600×800 in demo mode, in Hebrew and in English, is pixel-identical between
  `main` and this branch. The check uses puppeteer-core with the preinstalled Chromium and runs pixelmatch with
  threshold 0.
