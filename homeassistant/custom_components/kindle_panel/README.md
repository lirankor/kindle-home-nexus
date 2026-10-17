# Kindle Panel (Home Assistant integration)

The Home Assistant side of the kindle-home-nexus e-ink panel. Everything the panel shows is configured under
Settings → Devices & services → Kindle Panel → Configure: language, tabs (built-in and custom), lights and their scene
buttons, vacuum, plugs and their F1–F4 keys, media, screensaver, battery-saver schedule.

## Scene buttons are Home Assistant scenes

The panel has no scenes of its own (since 0.4.0). The Lights tab's F1–F3 each run an HA **scene** (`scene.turn_on`) or
**script** (`script.turn_on`); F4 switches the panel's lights off. A new panel starts with three buttons:
`scene.bright` (Bright), `scene.evening` (Evening) and the movie-mode script set under Media (Movie). Create the two scenes
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
