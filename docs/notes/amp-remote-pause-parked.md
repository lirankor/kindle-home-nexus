# Parked: amp remote, pause and resume (moved into the repo 2026-10-15)

On 2026-10-11 the user parked ("just do nothing") the amp remote / pause / resume problem of the Kindle panel: the R-N500 playing a pushed Jellyfin stream allows only Stop/Next/Previous, refuses Seek (UPnP 710 in every mode) and ignores YNCA Pause, so our pause is a stop (amp shows "No Content") and resume restarts the track; the Yamaha remote cannot skip/pause pushed playback at all.

**Why:** Measured directly on the amp (GetCurrentTransportActions, Seek tests, YNCA Play_Control) — the limit is the amp, not Jellyfin (which supports ranges).

**How to apply:** If the user comes back to it, read the "Open issue: amp remote, pause and resume" section in `docs/HANDOFF.md`. The user's preferred direction was intercepting the IR remote (ESP32 + IR receiver, ESPHome NEC decode → HA event → panel server). Don't re-run the amp probes; the numbers are recorded. Related: [[kindle4-home-control]].
