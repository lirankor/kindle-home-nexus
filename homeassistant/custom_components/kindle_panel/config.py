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
    DEFAULT_CARDS,
    DEFAULT_UNSPLASH_QUERY,
    LANGUAGES,
    LIGHT_ICONS,
    MAX_CARDS,
    MUSIC_BACKENDS,
    PHOTO_FALLBACKS,
    PHOTO_MODES,
    ROOM_ICONS,
    SOURCE_IMMICH_FAVORITES,
    SOURCE_MEDIA,
    TABS,
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
        vol.Optional("tabs", default=list(TABS)): vol.All(cv.ensure_list, [vol.In(TABS)], vol.Length(min=1)),
        vol.Optional("names", default={}): {vol.In(LANGUAGES): {cv.string: cv.string}},
        vol.Optional("lights", default=[]): [LIGHT],
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


def normalize(config: dict[str, Any] | None) -> dict[str, Any]:
    """Validated config with every default filled in (raises vol.Invalid)."""
    return CONFIG_SCHEMA(copy.deepcopy(config or {}))


DEFAULT_SOURCES = [{"type": SOURCE_IMMICH_FAVORITES, "title": "Immich · Favourites"}]


def effective_sources(sources: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The screensaver sources actually used: an empty list means Immich favourites (owner, 2026-10-17)."""
    return [dict(s) for s in (sources or DEFAULT_SOURCES)]
