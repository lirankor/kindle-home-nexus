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
- Known gaps in HA mode:
  - The playlist screen shows current + next only, and "jump" steps with next (≤ 10). See Q2 in homeserver-cloud
    `ops/bus/QUESTIONS.md`.
  - F2 (favourite) says favourites are kept in Music Assistant.
  - `queue.jump` is approximate.
