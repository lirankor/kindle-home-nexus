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
    "lights": ("lights", "evening"),
    "vacuum": ("vacuum",),
    "power": ("plugs",),
    "media": ("media",),
    "screensaver": ("screensaver",),
    "schedule": ("schedule",),
}

EVENT_CONFIG_UPDATED = f"{DOMAIN}_config_updated"

TABS = ["lights", "vacuum", "power", "media"]
LANGUAGES = ["he", "en"]
LIGHT_ICONS = ["lamp_ceiling", "spot", "strip", "lamp", "bulb"]
ROOM_ICONS = [
    "shower",
    "baby",
    "door",
    "utensils",
    "home",
    "bath",
    "bed",
    "sofa",
    "room",
]
PHOTO_MODES = ["curate", "all_but_skipped", "kept_only"]
MUSIC_BACKENDS = ["app", "ha"]
CARD_TYPES = ["outdoor", "indoor", "calendar", "sensor"]
CARD_ICONS = [
    "thermometer",
    "droplets",
    "gauge",
    "zap",
    "plug",
    "wind",
    "sun",
    "leaf",
    "home",
    "battery",
]
DEFAULT_CARDS = [{"type": "outdoor"}, {"type": "indoor"}, {"type": "calendar"}]
MAX_CARDS = 3  # the panel is 600 px wide
PHOTO_FALLBACKS = ["unsplash", "sample"]
DEFAULT_UNSPLASH_QUERY = "black and white art"

SOURCE_IMMICH_FAVORITES = "immich_favorites"
SOURCE_MEDIA = "media_source"
