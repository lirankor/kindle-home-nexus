"""Constants for the Kindle Panel companion integration."""

DOMAIN = "kindle_panel"
CONF_MA_ENTRY = "music_assistant_entry"
MA_DOMAIN = "music_assistant"
IMMICH_DOMAIN = "immich"

# entry.options["config"] holds the panel configuration (see config.py); the panel reads it with get_config.
OPT_CONFIG = "config"
OPT_SEEDED = "seeded"  # the panel handed over its setup (or someone forced it); never seeded twice
OPT_EDITED = "edited"  # options pages saved in the HA UI; a (late) seed never overwrites those
# options page -> the config keys it owns
PAGE_KEYS = {
    "general": ("language", "tabs", "sensors", "names"),
    "lights": ("lights", "scenes"),
    "vacuum": ("vacuum",),
    "power": ("plugs", "power_keys"),
    "media": ("media",),
    "screensaver": ("screensaver",),
    "schedule": ("schedule",),
    "custom_tabs": ("custom_tabs",),
}

EVENT_CONFIG_UPDATED = f"{DOMAIN}_config_updated"

TABS = ["lights", "vacuum", "power", "media"]  # the built-in tabs; custom tabs are "custom:<id>" entries
CUSTOM_PREFIX = "custom:"
CUSTOM_ID = r"^[a-z0-9_]{1,24}$"
MAX_TABS = 6  # the tab bar is 600 px wide
MAX_CUSTOM_TABS = 4
MAX_TOGGLES = 4  # rows that fit on one screen above the footer
TOGGLE_DOMAINS = ["switch", "light", "input_boolean", "fan"]
# The panel's one icon pack (bus task 019): every icon field (lights, rooms, scenes, custom tabs, toggles, sensor
# cards, plugs, media nodes, receiver inputs) offers these names, sorted. The app's src/data/icons.json maps each to a
# lucide icon (two are the app's own light icons); a pytest and a vitest keep this list equal to that file.
ICONS = [
    "air_vent",
    "alarm",
    "armchair",
    "baby",
    "bath",
    "battery",
    "bed",
    "bell",
    "blinds",
    "bluetooth",
    "book",
    "bot",
    "bulb",
    "cable",
    "calendar",
    "camera",
    "car",
    "cat",
    "coffee",
    "disc",
    "dog",
    "door",
    "droplets",
    "fan",
    "film",
    "flame",
    "flower",
    "gamepad",
    "garage",
    "gauge",
    "headphones",
    "heater",
    "home",
    "key",
    "kitchen",
    "lamp",
    "lamp_ceiling",
    "lamp_desk",
    "lamp_floor",
    "laptop",
    "leaf",
    "lock",
    "mic",
    "monitor",
    "moon",
    "music",
    "phone",
    "plant",
    "plug",
    "power",
    "printer",
    "radio",
    "refrigerator",
    "room",
    "shield",
    "shower",
    "snowflake",
    "sofa",
    "sparkles",
    "speaker",
    "spot",
    "stairs",
    "star",
    "strip",
    "sun",
    "thermometer",
    "timer",
    "toilet",
    "toy",
    "trash",
    "tree",
    "tv",
    "umbrella",
    "usb",
    "utensils",
    "washing_machine",
    "water_heater",
    "wifi",
    "wind",
    "zap",
]
# Bus task 020: every icon select offers this first, and it is the default: the button draws the icon the entity has in
# HA (its `icon` attribute), else the row type's default (the app's ICON_DEFAULTS, applied at draw time). Stored as no
# icon at all; the options UI shows it for rows without one.
ICON_AUTO = "auto"
ICON_AUTO_LABEL = "The entity's own icon (default)"
LANGUAGES = ["he", "en"]
# Lights tab scene buttons (F1..F3, F4 stays "all off"): each runs an HA scene or script (the panel has no scenes of its own).
MAX_SCENES = 3
# kindle_panel <= 0.3.0 had built-in Bright / Evening rows; saved ones now run these HA scenes (see the README).
LEGACY_BUILTIN_SCENES = {"bright": "scene.bright", "evening": "scene.evening"}
# Power tab soft keys F1..F4: a plug (its switch entity id), all plugs off, or nothing.
POWER_KEY_COUNT = 4
POWER_KEY_ALL_OFF = "all_off"
POWER_KEY_NONE = "none"
# Media tab = typed device nodes (bus task 014). Per type: the field that names its main entity (and that entity's
# domain) and the optional fields with their domains. Adding a type here is all the config side needs.
NODE_TYPES: dict[str, dict] = {
    "receiver": {
        "entity": ("power_device", "media_player"),
        "optional": {
            "volume": "number",
            "plug": "switch",
            "plug_power": "sensor",
            "stream_output": "select",
            # yamaha_netbridge >= 0.3.0: its NET RADIO station select (empty = found on the receiver's device)
            "net_radio": "select",
            # the Music Assistant players this receiver plays (an output among them wakes the receiver)
            "players": "media_player[]",
            # only for the panel's own (app) music backend
            "dlna_player": "media_player",
            "ynca_entry_id": "text",
        },
    },
    "tv": {
        "entity": ("entity", "media_player"),
        # movie_active: what says "movie mode is on". The owner's Movie mode is a script (bus task 022): `script.movie_mode`
        # is on exactly while it runs; an input_boolean still works for other households.
        "optional": {"movie_on": "script", "movie_off": "script", "movie_active": "script|input_boolean"},
    },
}
MAX_NODES = 6
# Every node type may carry `inputs`: rows {input, name, name_he, hidden} that rename or hide entries of its entity's
# source_list (the list itself always comes live from HA, in the device's order; bus task 015).
MAX_INPUT_ROWS = 40
# Media tab F1..F4: none, all_off, "music" (the music screen), a node id (that node's controls) or a script.
MEDIA_KEY_MUSIC = "music"
# The output picker's F1..F4: none, a Music Assistant media_player (a player or an MA group) or a script (e.g. plug on,
# amp on, input SERVER, output DLNA; see the README).
# kindle_panel <= 0.4.0 (config version 1) had flat amp/tv fields and the owner's amp hard-wired in the HA package and
# the app: those become an "amp" receiver and a "tv" node, and the panel's output starts as the amp's DLNA player.
LEGACY_POWER_DEVICE = "media_player.r_n500"
LEGACY_STREAM_OUTPUT = "select.r_n500_stream_output"
# unique_id suffix of yamaha_netbridge's NET RADIO station select (found on the receiver's device when not named)
NET_RADIO_SELECT_SUFFIX = "_net_radio_station"
LEGACY_MA_PLAYERS = ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"]
LEGACY_MEDIA_KEYS = (
    "amp_player",
    "amp_volume",
    "dlna_player",
    "amp_plug",
    "amp_plug_power",
    "tv",
    "movie_on",
    "movie_off",
    "movie_active",
    "ynca_entry_id",
)
PHOTO_MODES = ["curate", "all_but_skipped", "kept_only"]
MUSIC_BACKENDS = ["app", "ha"]
CARD_TYPES = ["outdoor", "indoor", "calendar", "sensor"]
DEFAULT_CARDS = [{"type": "outdoor"}, {"type": "indoor"}, {"type": "calendar"}]
MAX_CARDS = 3  # the panel is 600 px wide
PHOTO_FALLBACKS = ["unsplash", "sample"]
DEFAULT_UNSPLASH_QUERY = "black and white art"

SOURCE_IMMICH_FAVORITES = "immich_favorites"
SOURCE_MEDIA = "media_source"
