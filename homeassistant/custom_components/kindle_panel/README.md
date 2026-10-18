# Kindle Panel (Home Assistant integration)

The Home Assistant side of the kindle-home-nexus e-ink panel. Everything the panel shows is configured under
Settings → Devices & services → Kindle Panel → Configure: language, tabs (built-in and custom), lights and their scene
buttons, vacuum, plugs and their F1–F4 keys, media devices and keys, screensaver, battery-saver schedule.

## Media tab: your devices, and a music screen with its own player

Since 0.5.0 the Media tab is a list of **media devices** (Configure → *Media tab and music* → *Media devices*). Each row
has an id (a-z, 0-9, `_`; keep it once chosen), a type, a name (and an optional Hebrew name) and the entities of that
type:

* **Receiver / amplifier**: *Entity* = its media player (power and inputs). Optional: a volume number, a plug (and its
  power sensor), its DLNA/AirPlay stream-output select, and the **Music Assistant players it plays**. On the panel: on /
  off, volume (up / down), input list, stream output.
* **TV**: *Entity* = the TV's media player. Optional: movie-mode on / off scripts and *movie mode active*: best the
  movie-mode **script** itself (a script is `on` while it runs, so the TV screen's movie badge shows exactly while it
  runs; since 0.9.0, bus task 022), or a boolean. On the panel: on / off, volume, input list, movie mode.

**Inputs** (since 0.5.1): a device's input list on the panel is its media player's own `source_list`, live from Home
Assistant and in the device's order (a Yamaha through yamaha_netbridge: Spotify, NET RADIO, SERVER, AirPlay, USB,
TUNER, PHONO, CD, OPTICAL, COAXIAL, LINE…). Every input shows with the device's own title. To rename or hide some, pick
the device under *Then rename / hide the inputs of* on the Media page: the next page lists its inputs, each with a name,
a Hebrew name and *Hidden on the panel* (e.g. `CD` → "Bluetooth & TV" / "בלוטות׳ וטלוויזיה", `LINE3` hidden). Rows are
stored on the device as `inputs: [{input, name, name_he, hidden}]`; selecting an input on the panel calls
`media_player.select_source` with the device's own title, and a receiver in standby is turned on by that (yamaha_netbridge
≥ 0.2.1 does it itself, through its power supply switch when the plug is off).

**NET RADIO stations** (since 0.6.0): a receiver whose bridge has a station list (yamaha_netbridge ≥ 0.3.0, options →
*NET RADIO stations*) gets it on the panel with no setup. Since bus task 025 the **radio dial belongs to the
receiver's own device screen**: choosing the NET RADIO input opens the dial instead of switching right away, and the
receiver's screen opens straight on the dial while the receiver plays NET RADIO; Back from the dial returns to the
receiver's screen. The dial's bands are the list's groups in order (no favourites band: Music Assistant's favourites
are MA's, not the receiver's; the bridge publishes no preset list); left / right or a station from the list tunes,
which calls `select.select_option` on the bridge's `select.<receiver>_net_radio_station` (it turns the receiver on,
selects NET RADIO and walks its menu; Music Assistant is not involved). Up / down on the dial is the receiver's volume.
The select is found on the receiver's device; the optional node field *NET RADIO station select* (`net_radio`) names
another one. The panel ships no station file.

The **F1–F4 keys of the Media tab** each open the music screen, open one device's controls, run a script, switch all
media off, or do nothing. A new panel starts with F1 = music, F2 = the first receiver, F3 = the first TV.

**Music** is a screen of its own (library, playlist, now playing, transport, volume) that plays through Music
Assistant on **one player per panel**, chosen on the panel itself: the music screen's **Player** key (נגן; F3) opens a
list of every Music Assistant player Home Assistant has (names from Home Assistant). Up / down and select choose it,
Back closes the list without a change, and the picker's F1–F4 are quick keys to the players set under *F1–F4 in the
player picker*. A picker key can also be a **script** (its name shows on the key): it runs instead of picking, for
anything more than choosing a player. The list opens by itself when the panel has no player yet (or its player is gone
from Home Assistant). One player at a time by design: **to play in several rooms, make a group in Music Assistant**;
the group shows up as one more player. Since bus task 025 (0.9.2: labels only; the option keys `music_output`,
`output_keys`, `hidden_outputs`, … keep their names) the music screen is Music Assistant only: keys F1 = playlist (when
the player has a queue), F2 = library, F3 = player; no radio key. When the player's receiver is on an input of its own
(NET RADIO, TUNER, …) the screen says so and names the Media key of the receiver ("המגבר על NET RADIO · מגבר ← F2 במדיה").

**Since 0.8.0 (bus task 021) the music screen is a Music Assistant controller like the MA app's Players sheet.** Every
MA player has its own queue; the panel shows and controls only its player (state, queue, cover art), and says so when
another player plays instead ("R-N500 AirPlay is playing · F3 to switch"). In the picker:

* each row is two fixed lines (since 0.9.1, bus task 023): the name, then "what it plays · state" ("group" for MA
  groups), each cut with "…"; when the line is too long the album goes first, then the artist. Five rows a page; more
  page with up / down (page indicator "1/2" in the heading). Rows are sorted by name;
* **Enter** = this panel now controls that player (nothing moves);
* **Right**, or the right-most picker key left at *none* ("Move here"), = move the music there:
  `kindle_panel.move_queue` runs Music Assistant's transfer_queue (whole queue and position, plays at once, the source
  stops) and the target becomes the panel's player; the screen says "moving…" until it plays;
* **only what can be chosen is listed** (since 0.9.0, bus task 022): players that are unavailable, and Music Assistant
  players Home Assistant has no entity for (e.g. MA's own web player, "Web (Chrome on Android)", which comes and goes
  with a browser tab), are hidden. The panel's own player always stays listed. For debugging, *Media → Player picker:
  also list unavailable players* (`media.show_unavailable_outputs`) lists them again, greyed and not selectable;
* **hidden players** (since 0.9.1, bus task 023): a player hidden in Music Assistant (*Settings → Players → (the
  player) → Hide player*, MA's `hide_in_ui`) is never listed, and neither is one picked in *Media → Player picker:
  never list these players* (`media.hidden_outputs`, a list of MA players, default empty). The panel's current player
  is always listed. The F-key dropdowns still offer every player;
* **sync** (since 0.9.0): players Music Assistant can play in sync (its `can_group_with`, e.g. AirPlay ↔ a TV ↔ a
  Sendspin phone; a DLNA player syncs with nothing) get a **Sync** key on the next picker key left at *none* to the
  left of "Move here" (and on **Left**, the only way when no second key is free). On a highlighted player that can
  sync with the panel's player it joins that player's group (`kindle_panel.sync_output` since 0.9.1, which calls HA's
  `media_player.join` with the player, or the leader it follows, as the target); on a member it reads **Unsync**
  (`media_player.unjoin`). When Music Assistant says no, `sync_output` answers `{ok: false, reason: unavailable |
  cannot | failed | not_joined, error}` and the panel shows "Cannot sync: …" on the music screen, like a refused move.
  Members are listed under their leader with a link glyph on the icon side (the right in Hebrew), like in Music
  Assistant; the music screen's player label names the whole group
  ("R-N500 AirPlay + TV"). The group plays the leader's queue, so the panel's player stays the leader.

**A player missing from the list?** Music Assistant only gives Home Assistant an entity for a player whose setting
*Settings → Players → (the player) → Expose to Home Assistant* is on. It is off for some players added later (for
example a "universal" TV player or a phone running Sendspin). Turn it on; the entity appears at once (no reload).

`kindle_panel.move_queue` (`entity_id` = target, optional `source_player`, default the panel's player; `auto_play`,
default on) answers `{ok: true, music_output, moved_from, items}`. Since 0.9.0 it first checks the target: unavailable,
or its receiver **held** (yamaha_netbridge's `held` attribute, e.g. while a movie-mode script runs) answers
`{ok: false, reason: unavailable | held, error, music_output}` and nothing moves. Music Assistant's transfer stops and
clears the source before the target starts, so when the target refuses anyway the panel moves the queue back to the
source and plays it there (`reason: failed`, `restored: moved_back | resumed`); the panel's player never changes on a
refusal and the panel shows the reason on the music screen ("Cannot move: the receiver is busy (movie mode)"). Cover art from Music Assistant reaches the panel through
`GET /api/kindle_panel/ma_image?url=<MA imageproxy URL>` (Home Assistant auth; only the loaded MA server's
`/imageproxy` is fetched), for setups where the panel cannot reach Music Assistant's port.

When the chosen player is one of a receiver's Music Assistant players, the panel's music turns that receiver on first,
its volume keys act on the receiver, and its stream-output select is set to match (the option named in the player's
entity id, e.g. `dlna` / `airplay`). Any other player plays as it is (volume on the player itself). The choice is
stored per panel in Home Assistant (`kindle_panel.set_output`; `kindle_panel.get_config` answers `music_output` and
the list `outputs`). Configs saved before 0.5.0 are migrated: the amplifier fields become a receiver `amp`, the TV fields
a TV `tv`, and a panel that played through Home Assistant keeps the amplifier's DLNA player as its player.

The music screen never powers a receiver by itself (since 0.5.1): it is a Music Assistant controller. Playing, or
picking a player, wakes the player's receiver (the HA package does it through the receiver's `power_device`); the
screen shows the player's state. Device power is on the device's own screen (Media tab).

### Example: a picker key that wakes the amp and plays to it over DLNA

Plug on → amp on → input SERVER → the panel's player = the amp's DLNA player. Settings → Scripts → add (YAML), then
pick it under *F1–F4 in the player picker*. Use your own entity ids:

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

`kindle_panel.set_output` takes any Music Assistant player; the panel shows the new player within 30 s.

## Icons: one pack for every button

Every icon field in Configure offers the same 80 icons (since 0.7.0, bus task 019): lights, vacuum rooms, scene
buttons, custom tabs and their toggles, screensaver sensor cards, Power tab plugs, Media devices and receiver input rows.
Each is a dropdown in alphabetical order (no free text), with **auto** first.

### Precedence: the entity's own icon is the default (since 0.7.1, bus task 020)

Every button and key draws, in this order:

1. the pack icon chosen in the panel row, if one is chosen;
2. else the icon the entity has in Home Assistant (its `icon` state attribute: a custom icon or the integration's,
   e.g. `script.movie_mode` `mdi:theater`); Music Assistant's bare names (`speaker`) count as `mdi:speaker`;
3. else the row type's default (table below).

**auto** ("The entity's own icon (default)") is the first option of every icon select and what a new row gets; it is
stored as no icon at all, and a row without an icon shows **auto** in Configure. Entities whose icon HA only derives from
the domain (plain switches, most lights) carry no `icon` attribute, so they fall through to the default. Stored icons are
left as they are, also ones equal to an old default (`plug`, `speaker`, `tv` from 0.7.0): pick **auto** to switch such a
row to the entity's icon. Keys without a row of their own follow the same order without step 1: Media keys and player
picker keys that run a script or pick a Music Assistant player, custom-tab keys that run a scene or script (fallback:
their old glyph). Power keys and custom-tab toggle keys use their plug / toggle row. Changing an icon in HA shows on the
Kindle with the next redraw (the icons ride along with the states the app already polls; the app turns the MDI name
into its SVG path on the server).

| row | default (no row icon, no HA icon) |
|---|---|
| light | `bulb` |
| vacuum room | `room` |
| scene button | `star` |
| custom tab | `star` (a tab has no entity) |
| custom toggle | `plug` |
| sensor card | gauge (`gauge`) |
| Power plug | `plug` |
| Media device | receiver `speaker`, TV `tv` |
| receiver input row | none: no icon on the device's input list (an input has no entity; the music screen's source list keeps its own glyphs) |

The names live in `const.ICONS`; the app's `src/data/icons.json` maps each name to the icon it draws (lucide-react 0.575,
tree-shaken). A pytest (`test_icon_pack_equals_the_app_json`) and a vitest (`src/lib/icons.test.ts`) fail when the two
differ, so adding an icon means a row in both. A name the pack does not have is refused when the config is saved.

| name | drawn as (lucide export) | note |
|---|---|---|
| `air_vent` | `AirVent` |  |
| `alarm` | `AlarmClock` | AlarmClock |
| `armchair` | `Armchair` |  |
| `baby` | `Baby` |  |
| `bath` | `Bath` |  |
| `battery` | `Battery` |  |
| `bed` | `Bed` |  |
| `bell` | `Bell` |  |
| `blinds` | `Blinds` |  |
| `bluetooth` | `Bluetooth` |  |
| `book` | `BookOpen` | BookOpen |
| `bot` | `Bot` |  |
| `bulb` | `Lightbulb` | Lightbulb |
| `cable` | `Cable` |  |
| `calendar` | `CalendarDays` | CalendarDays |
| `camera` | `Camera` |  |
| `car` | `Car` |  |
| `cat` | `Cat` |  |
| `coffee` | `Coffee` |  |
| `disc` | `Disc3` | Disc3 |
| `dog` | `Dog` |  |
| `door` | `DoorOpen` | DoorOpen |
| `droplets` | `Droplets` |  |
| `fan` | `Fan` |  |
| `film` | `Film` |  |
| `flame` | `Flame` |  |
| `flower` | `Flower2` | Flower2 |
| `gamepad` | `Gamepad2` | Gamepad2 |
| `garage` | `Warehouse` | no garage icon: Warehouse |
| `gauge` | `Gauge` |  |
| `headphones` | `Headphones` |  |
| `heater` | `Heater` |  |
| `home` | `House` | House (lucide's Home alias) |
| `key` | `Key` |  |
| `kitchen` | `CookingPot` | no kitchen icon: CookingPot |
| `lamp` | `Lamp` | Lamp (before 0.7.0 a *light* with `lamp` drew LampCeiling; no configured light used it) |
| `lamp_ceiling` | `LampCeiling` |  |
| `lamp_desk` | `LampDesk` |  |
| `lamp_floor` | `LampFloor` |  |
| `laptop` | `Laptop` |  |
| `leaf` | `Leaf` |  |
| `lock` | `Lock` |  |
| `mic` | `Mic` |  |
| `monitor` | `Monitor` |  |
| `moon` | `Moon` |  |
| `music` | `Music` |  |
| `phone` | `Smartphone` | Smartphone |
| `plant` | `Sprout` | Sprout |
| `plug` | `Plug` |  |
| `power` | `Power` |  |
| `printer` | `Printer` |  |
| `radio` | `Radio` |  |
| `refrigerator` | `Refrigerator` |  |
| `room` | `House` | default room icon (same as home) |
| `shield` | `Shield` |  |
| `shower` | `ShowerHead` | ShowerHead |
| `snowflake` | `Snowflake` |  |
| `sofa` | `Sofa` |  |
| `sparkles` | `Sparkles` |  |
| `speaker` | `Speaker` |  |
| `spot` | `SpotLightIcon` | the app's own spot-light icon (not lucide) |
| `stairs` | `Footprints` | no stairs icon in lucide 0.575: Footprints (nearest) |
| `star` | `Star` |  |
| `strip` | `StripLightIcon` | the app's own LED-strip icon (not lucide) |
| `sun` | `Sun` |  |
| `thermometer` | `Thermometer` |  |
| `timer` | `Timer` |  |
| `toilet` | `Toilet` |  |
| `toy` | `ToyBrick` | ToyBrick |
| `trash` | `Trash2` | Trash2 |
| `tree` | `TreeDeciduous` | TreeDeciduous |
| `tv` | `Tv` |  |
| `umbrella` | `Umbrella` |  |
| `usb` | `Usb` |  |
| `utensils` | `Utensils` |  |
| `washing_machine` | `WashingMachine` |  |
| `water_heater` | `Cylinder` | no boiler / water heater icon: Cylinder (a tank) |
| `wifi` | `Wifi` |  |
| `wind` | `Wind` |  |
| `zap` | `Zap` |  |

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
