"""The panel configuration: what the Kindle shows and how it behaves, edited in the HA UI.

One JSON-able dict, stored in the config entry's options under "config". The panel reads it with
`kindle_panel.get_config`; on its first start the panel seeds it with the setup it shipped with
(`kindle_panel.seed`), so moving to HA-managed config changes nothing on the screen.
"""

from __future__ import annotations

import copy
import re
from typing import Any

import voluptuous as vol
from homeassistant.helpers import config_validation as cv

from .const import (
    CARD_ICONS,
    CARD_TYPES,
    CUSTOM_ID,
    CUSTOM_PREFIX,
    DEFAULT_CARDS,
    DEFAULT_UNSPLASH_QUERY,
    LANGUAGES,
    LIGHT_ICONS,
    MAX_CARDS,
    MAX_CUSTOM_TABS,
    MAX_SCENES,
    MAX_TABS,
    MAX_TOGGLES,
    MUSIC_BACKENDS,
    PHOTO_FALLBACKS,
    PHOTO_MODES,
    POWER_KEY_ALL_OFF,
    POWER_KEY_COUNT,
    POWER_KEY_NONE,
    ROOM_ICONS,
    SCENE_BUILTINS,
    SCENE_ICONS,
    SOURCE_IMMICH_FAVORITES,
    SOURCE_MEDIA,
    TABS,
    TOGGLE_DOMAINS,
    TOGGLE_ICONS,
)

CONFIG_VERSION = 1
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _hhmm(v: Any) -> str:
    s = str(v).strip()
    if not HHMM.match(s):
        raise vol.Invalid("expected HH:MM")
    return s


def _opt_entity(v: Any) -> str | None:
    return None if v in (None, "") else cv.entity_id(v)


LIGHT = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("name"): cv.string,
        vol.Optional("room", default=""): str,
        vol.Optional("icon", default="bulb"): vol.In(LIGHT_ICONS),
    }
)
ROOM = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("name"): cv.string,
        vol.Optional("icon", default="room"): vol.In(ROOM_ICONS),
    }
)
PLUG = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("name"): cv.string,
        vol.Optional("power_entity"): _opt_entity,
        vol.Optional("energy_entity"): _opt_entity,
        vol.Optional("energy_to_wh", default=1): vol.Coerce(float),
    }
)


SCENE_BASE = vol.Schema(
    {
        vol.Optional("entity_id"): _opt_entity,
        vol.Optional("builtin"): vol.Any(None, vol.In(SCENE_BUILTINS)),
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
        vol.Optional("icon", default="star"): vol.In(SCENE_ICONS),
    }
)


def _scene(v: Any) -> dict[str, Any]:
    """A Lights tab scene button: exactly one of an HA scene/script (`entity_id`) or a built-in scene (`builtin`)."""
    row = {k: x for k, x in SCENE_BASE(v).items() if x not in (None, "")}
    if ("entity_id" in row) == ("builtin" in row):
        raise vol.Invalid("a scene button runs either an HA scene/script or a built-in scene")
    if "entity_id" in row and row["entity_id"].split(".", 1)[0] not in ("scene", "script"):
        raise vol.Invalid(f"a scene button runs a scene or a script, not {row['entity_id']}")
    return row


def _power_key(v: Any) -> str:
    if v in (None, "", POWER_KEY_NONE):
        return POWER_KEY_NONE
    if v == POWER_KEY_ALL_OFF:
        return v
    return cv.entity_id(v)


def _tab(v: Any) -> str:
    s = str(v)
    if s in TABS:
        return s
    if s.startswith(CUSTOM_PREFIX) and re.match(CUSTOM_ID, s[len(CUSTOM_PREFIX) :]):
        return s
    raise vol.Invalid(f"unknown tab {s!r}")


def _custom_id(v: Any) -> str:
    s = str(v).strip()
    if not re.match(CUSTOM_ID, s):
        raise vol.Invalid(f"a custom tab id is 1-24 of a-z, 0-9, _ (not {s!r})")
    return s


KEYS = vol.Any(None, vol.All(cv.ensure_list, [_power_key], vol.Length(max=POWER_KEY_COUNT)))
TOGGLE = vol.Schema(
    {
        vol.Required("entity_id"): vol.All(cv.entity_id, cv.entity_domain(TOGGLE_DOMAINS)),
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
        vol.Optional("icon", default="plug"): vol.In(TOGGLE_ICONS),
    }
)
CUSTOM_TAB = vol.Schema(
    {
        vol.Required("title"): vol.All(cv.string, vol.Length(min=1, max=24)),
        vol.Optional("icon", default="star"): vol.In(TOGGLE_ICONS),
        vol.Optional("toggles", default=[]): vol.All([TOGGLE], vol.Length(max=MAX_TOGGLES)),
        # F1..F4: a toggle of this tab, a scene or script, all_off (every toggle of this tab off) or none
        vol.Optional("keys"): KEYS,
    }
)


def _custom_tabs(v: dict[str, Any]) -> dict[str, Any]:
    return {_custom_id(k): CUSTOM_TAB(t) for k, t in v.items()}


def _card(v: Any) -> dict[str, Any]:
    card = CARD_BASE(v)
    if card["type"] == "sensor" and not card.get("entity_id"):
        raise vol.Invalid("a sensor card needs an entity")
    return card


CARD_BASE = vol.Schema(
    {
        vol.Required("type"): vol.In(CARD_TYPES),
        vol.Optional("entity_id"): _opt_entity,
        vol.Optional("label"): vol.Any(None, str),
        vol.Optional("icon"): vol.Any(None, vol.In(CARD_ICONS)),
    }
)
SOURCE = vol.Any(
    vol.Schema({vol.Required("type"): SOURCE_IMMICH_FAVORITES, vol.Optional("title"): str}),
    vol.Schema(
        {
            vol.Required("type"): SOURCE_MEDIA,
            vol.Required("id"): cv.string,
            vol.Optional("title"): str,
        }
    ),
)

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional("version", default=CONFIG_VERSION): int,
        vol.Optional("language", default="en"): vol.In(LANGUAGES),
        vol.Optional("tabs", default=list(TABS)): vol.All(cv.ensure_list, [_tab], vol.Length(min=1)),
        vol.Optional("custom_tabs", default={}): vol.All(dict, _custom_tabs, vol.Length(max=MAX_CUSTOM_TABS)),
        vol.Optional("names", default={}): {vol.In(LANGUAGES): {cv.string: cv.string}},
        vol.Optional("lights", default=[]): [LIGHT],
        # No defaults here: normalize() derives them from the rest (today's buttons and keys) while the key is absent.
        vol.Optional("scenes"): vol.Any(None, vol.All(cv.ensure_list, [_scene], vol.Length(max=MAX_SCENES))),
        vol.Optional("evening", default={}): vol.Schema(
            {
                vol.Optional("entity_id"): _opt_entity,
                vol.Optional("brightness_pct", default=40): vol.All(vol.Coerce(int), vol.Range(1, 100)),
                vol.Optional("warm_kelvin", default=2200): vol.All(vol.Coerce(int), vol.Range(1500, 7000)),
            }
        ),
        vol.Optional("vacuum", default={}): vol.Schema(
            {
                vol.Optional("entity_id"): _opt_entity,
                vol.Optional("battery_entity"): _opt_entity,
                vol.Optional("rooms_script"): _opt_entity,
                vol.Optional("rooms", default=[]): [ROOM],
            }
        ),
        vol.Optional("plugs", default=[]): [PLUG],
        vol.Optional("power_keys"): KEYS,
        vol.Optional("media", default={}): vol.Schema(
            {
                vol.Optional("music_backend", default="app"): vol.In(MUSIC_BACKENDS),
                vol.Optional("amp_player"): _opt_entity,
                vol.Optional("amp_volume"): _opt_entity,
                vol.Optional("dlna_player"): _opt_entity,
                vol.Optional("amp_plug"): _opt_entity,
                vol.Optional("amp_plug_power"): _opt_entity,
                vol.Optional("tv"): _opt_entity,
                vol.Optional("movie_on"): _opt_entity,
                vol.Optional("movie_off"): _opt_entity,
                vol.Optional("movie_active"): _opt_entity,
                vol.Optional("ynca_entry_id"): vol.Any(None, str),
            }
        ),
        vol.Optional("sensors", default={}): vol.Schema(
            {
                vol.Optional("indoor_temperature"): _opt_entity,
                vol.Optional("indoor_humidity"): _opt_entity,
                vol.Optional("weather"): _opt_entity,
            }
        ),
        vol.Optional("screensaver", default={}): vol.Schema(
            {
                vol.Optional("idle_minutes", default=5): vol.All(vol.Coerce(int), vol.Range(1, 120)),
                vol.Optional("photo_minutes", default=10): vol.All(vol.Coerce(int), vol.Range(1, 240)),
                vol.Optional("mode", default="curate"): vol.In(PHOTO_MODES),
                vol.Optional("sources", default=[]): [SOURCE],
                vol.Optional("cards", default=lambda: [dict(c) for c in DEFAULT_CARDS]): vol.All(
                    [_card], vol.Length(max=MAX_CARDS)
                ),
                vol.Optional("fallback", default="unsplash"): vol.In(PHOTO_FALLBACKS),
                vol.Optional("unsplash_query", default=DEFAULT_UNSPLASH_QUERY): vol.All(str, vol.Length(max=200)),
                vol.Optional("unsplash_key"): vol.Any(None, vol.All(str, vol.Length(max=200))),
            }
        ),
        vol.Optional("schedule", default={}): vol.Schema(
            {
                vol.Optional("radio_duty", default=True): bool,
                vol.Optional("day_wake_min", default=10): vol.All(vol.Coerce(int), vol.Range(1, 120)),
                vol.Optional("night_start", default="00:00"): _hhmm,
                vol.Optional("night_end", default="06:00"): _hhmm,
                vol.Optional("night_wake_min", default=120): vol.All(vol.Coerce(int), vol.Range(10, 720)),
                vol.Optional("timezone", default="Europe/Berlin"): cv.time_zone,
            }
        ),
    },
    extra=vol.REMOVE_EXTRA,
)


def default_scenes(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """The scene buttons the panel always had: Bright and Evening (built in), Movie (the movie-mode script)."""
    rows: list[dict[str, Any]] = [
        {"builtin": "bright", "name": "Bright", "icon": "sun"},
        {"builtin": "evening", "name": "Evening", "icon": "moon"},
    ]
    if movie := cfg.get("media", {}).get("movie_on"):
        rows.append({"entity_id": movie, "name": "Movie", "icon": "film"})
    return rows


def default_power_keys(plugs: list[dict[str, Any]]) -> list[str]:
    """F1..F3 the first three entities of a tab's list, F4 all of them off: the Power tab as it always was (custom
    tabs start the same way)."""
    keys = [p["entity_id"] for p in plugs[: POWER_KEY_COUNT - 1]]
    return [*keys, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - 1 - len(keys)), POWER_KEY_ALL_OFF]


def _keys(keys: list[str] | None, rows: list[dict[str, Any]]) -> list[str]:
    if keys is None:
        return default_power_keys(rows)
    return [*keys, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - len(keys))]


def normalize(config: dict[str, Any] | None) -> dict[str, Any]:
    """Validated config with every default filled in (raises vol.Invalid)."""
    cfg = CONFIG_SCHEMA(copy.deepcopy(config or {}))
    if cfg.get("scenes") is None:
        cfg["scenes"] = default_scenes(cfg)
    cfg["power_keys"] = _keys(cfg.get("power_keys"), cfg["plugs"])
    for tab in cfg["custom_tabs"].values():
        tab["keys"] = _keys(tab.get("keys"), tab["toggles"])
    # Tabs: no duplicates, no custom tab without its block (a block without a tab entry is a hidden tab, kept).
    tabs: list[str] = []
    for t in cfg["tabs"]:
        if t not in tabs and (not t.startswith(CUSTOM_PREFIX) or t[len(CUSTOM_PREFIX) :] in cfg["custom_tabs"]):
            tabs.append(t)
    if not tabs:
        raise vol.Invalid("the panel needs at least one tab")
    if len(tabs) > MAX_TABS:
        raise vol.Invalid(f"at most {MAX_TABS} tabs fit on the screen")
    cfg["tabs"] = tabs
    return cfg


DEFAULT_SOURCES = [{"type": SOURCE_IMMICH_FAVORITES, "title": "Immich · Favourites"}]


def effective_sources(sources: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The screensaver sources actually used: an empty list means Immich favourites (owner, 2026-10-17)."""
    return [dict(s) for s in (sources or DEFAULT_SOURCES)]
