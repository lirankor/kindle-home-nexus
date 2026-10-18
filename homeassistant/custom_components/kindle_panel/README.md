# Kindle Panel (Home Assistant integration)

The Home Assistant side of the kindle-home-nexus e-ink panel. Everything the panel shows is configured under
Settings → Devices & services → Kindle Panel → Configure: language, tabs (built-in and custom), lights and their scene
buttons, vacuum, plugs and their F1–F4 keys, media devices and keys, screensaver, battery-saver schedule.

## Media tab: your devices, and a music screen with its own output

Since 0.5.0 the Media tab is a list of **media devices** (Configure → *Media tab and music* → *Media devices*). Each row
has an id (a-z, 0-9, `_`; keep it once chosen), a type, a name (and an optional Hebrew name) and the entities of that
type:

* **Receiver / amplifier**: *Entity* = its media player (power and inputs). Optional: a volume number, a plug (and its
  power sensor), its DLNA/AirPlay stream-output select, and the **Music Assistant players it plays**. On the panel: on /
  off, volume (up / down), input list, stream output.
* **TV**: *Entity* = the TV's media player. Optional: movie-mode on / off scripts and the movie-mode boolean. On the
  panel: on / off, volume, input list, movie mode.

**Inputs** (since 0.5.1): a device's input list on the panel is its media player's own `source_list`, live from Home
Assistant and in the device's order (a Yamaha through yamaha_netbridge: Spotify, NET RADIO, SERVER, AirPlay, USB,
TUNER, PHONO, CD, OPTICAL, COAXIAL, LINE…). Every input shows with the device's own title. To rename or hide some, pick
the device under *Then rename / hide the inputs of* on the Media page: the next page lists its inputs, each with a name,
a Hebrew name and *Hidden on the panel* (e.g. `CD` → "Bluetooth & TV" / "בלוטות׳ וטלוויזיה", `LINE3` hidden). Rows are
stored on the device as `inputs: [{input, name, name_he, hidden}]`; selecting an input on the panel calls
`media_player.select_source` with the device's own title, and a receiver in standby is turned on by that (yamaha_netbridge
≥ 0.2.1 does it itself, through its power supply switch when the plug is off).

**NET RADIO stations** (since 0.6.0): a receiver whose bridge has a station list (yamaha_netbridge ≥ 0.3.0, options →
*NET RADIO stations*) gets it on the panel with no setup: choosing the NET RADIO input opens the station list instead of
switching right away (name, FM frequency where the list has one, else its group; up / down, select plays, Back
returns). Playing calls `select.select_option` on the bridge's `select.<receiver>_net_radio_station`, which turns the
receiver on, selects NET RADIO and walks its menu; the node screen then shows the station and song the receiver reports.
The select is found on the receiver's device; the optional node field *NET RADIO station select* (`net_radio`) names
another one. The panel's radio bands (music screen) come from the same list: favourites, then its groups in order; the
panel ships no station file.

The **F1–F4 keys of the Media tab** each open the music screen, open one device's controls, run a script, switch all
media off, or do nothing. A new panel starts with F1 = music, F2 = the first receiver, F3 = the first TV.

**Music** is a screen of its own (radio, library, playlist, now playing, transport, volume) that plays through Music
Assistant to **one output per panel**, chosen on the panel itself: the music screen's Output key opens a list of every
Music Assistant player Home Assistant has (names from Home Assistant). Up / down and select choose it, Back closes the
list without a change, and the picker's F1–F4 are quick keys to the outputs set under *F1–F4 in the output picker*.
A picker key can also be a **script** (its name shows on the key): it runs instead of picking, for anything more than
choosing a player. The list opens by itself when the panel has no output yet (or its output is gone from Home Assistant). One output at a
time by design: **to play in several rooms, make a group in Music Assistant**; the group shows up as one more player.

When the chosen output is one of a receiver's Music Assistant players, the panel's music turns that receiver on first,
its volume keys act on the receiver, and its stream-output select is set to match (the option named in the player's
entity id, e.g. `dlna` / `airplay`). Any other output plays as it is (volume on the player itself). The choice is
stored per panel in Home Assistant (`kindle_panel.set_output`; `kindle_panel.get_config` answers `music_output` and
the list `outputs`). Configs saved before 0.5.0 are migrated: the amplifier fields become a receiver `amp`, the TV fields
a TV `tv`, and a panel that played through Home Assistant keeps the amplifier's DLNA player as its output.

The music screen never powers a receiver by itself (since 0.5.1): it is a Music Assistant controller. Playing, or
picking an output, wakes the output's receiver (the HA package does it through the receiver's `power_device`); the
screen shows the output's state. Device power is on the device's own screen (Media tab).

### Example: a picker key that wakes the amp and plays to it over DLNA

Plug on → amp on → input SERVER → the panel's output = the amp's DLNA player. Settings → Scripts → add (YAML), then
pick it under *F1–F4 in the output picker*. Use your own entity ids:

```yaml
alias: Amp over DLNA          # the key's label on the panel
icon: mdi:speaker
mode: single
sequence:
  - action: switch.turn_on
    target: {entity_id: switch.media_plug}
  - action: media_player.turn_on          # yamaha_netbridge waits until the amp is up (up to a minute)
    target: {entity_id: media_player.r_n500}
  - action: media_player.select_source
    target: {entity_id: media_player.r_n500}
    data: {source: SERVER}
  - action: select.select_option          # the receiver's stream output follows the player
    target: {entity_id: select.r_n500_stream_output}
    data: {option: dlna}
  - action: kindle_panel.set_output       # the panel plays here from now on
    data: {entity_id: media_player.ma_amp_dlna}
```

`kindle_panel.set_output` takes any Music Assistant player; the panel shows the new output within 30 s.

## Scene buttons are Home Assistant scenes

The panel has no scenes of its own (since 0.4.0). The Lights tab's F1–F3 each run an HA **scene** (`scene.turn_on`) or
**script** (`script.turn_on`); F4 switches the panel's lights off. A new panel starts with three buttons:
`scene.bright` (Bright), `scene.evening` (Evening) and the movie-mode script of the first TV device (Movie). Create the two scenes
once, in Settings → Scenes (or paste them into `scenes.yaml`), with your own lights:

```yaml
- id: kindle_panel_bright
  name: Bright            # becomes scene.bright
  icon: mdi:white-balance-sunny
  entities:
    light.main_light: {state: "on", brightness: 255}
    light.spots: {state: "on", brightness: 255}
    light.dining_table: {state: "on", brightness: 255}
    light.cabinet_strips: {state: "on", brightness: 255}
- id: kindle_panel_evening
  name: Evening           # becomes scene.evening
  icon: mdi:weather-night
  entities:
    light.main_light: {state: "on", brightness: 102, color_temp_kelvin: 2200}   # 40 %, warm white
    light.spots: {state: "off"}
    light.dining_table: {state: "off"}
    light.cabinet_strips: {state: "off"}
```

Any other scene or script can take a button's place (Configure → Lights → Scene buttons). The names Bright, Evening and
Movie show in Hebrew by themselves; any other name takes its Hebrew from the row's Hebrew name field.

Upgrading from 0.3.x: saved built-in Bright / Evening buttons now run `scene.bright` / `scene.evening`, and the old
Evening light / brightness / warm-white settings are dropped. Create the two scenes above, otherwise those buttons
answer with an error.
