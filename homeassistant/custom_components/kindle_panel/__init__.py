"""Kindle Panel: Home Assistant companion of the kindle-home-nexus e-ink panel.

Gives the panel what Home Assistant's Music Assistant integration does not pass on, using the MA connection HA
already has (no extra token anywhere): the whole play queue of an MA player and "play queue item n". The panel keeps
talking only to Home Assistant; without this integration it falls back to the track list it sent itself.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv, entity_registry as er

from .const import CONF_MA_ENTRY, DOMAIN, MA_DOMAIN

GET_QUEUE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional("offset", default=0): vol.All(vol.Coerce(int), vol.Range(min=0)),
        vol.Optional("limit", default=200): vol.All(vol.Coerce(int), vol.Range(min=1, max=500)),
    }
)
PLAY_INDEX_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Required("index"): vol.All(vol.Coerce(int), vol.Range(min=0)),
    }
)


def _mass_and_player(hass: HomeAssistant, entry: ConfigEntry, entity_id: str) -> tuple[Any, str]:
    """The MA client and the MA player id behind a Music Assistant media_player entity."""
    reg = er.async_get(hass).async_get(entity_id)
    if reg is None or reg.platform != MA_DOMAIN:
        raise ServiceValidationError(f"{entity_id} is not a Music Assistant player")
    ma_entry = hass.config_entries.async_get_entry(reg.config_entry_id or entry.data[CONF_MA_ENTRY])
    if ma_entry is None or ma_entry.state is not ConfigEntryState.LOADED:
        raise ServiceValidationError("Music Assistant is not loaded")
    return ma_entry.runtime_data.mass, reg.unique_id


def _jellyfin_id(m: Any) -> str | None:
    """The Jellyfin item id behind an MA item (MA's own library ids are not Jellyfin ids)."""
    for pm in getattr(m, "provider_mappings", None) or []:
        if getattr(pm, "provider_domain", None) == "jellyfin":
            return pm.item_id
    uri = getattr(m, "uri", None) or ""
    return uri.rsplit("/", 1)[-1] if uri.startswith("jellyfin") else None


def _item_view(mass: Any, index: int, qi: Any) -> dict[str, Any]:
    m = getattr(qi, "media_item", None)
    artists = getattr(m, "artists", None) or []
    album = getattr(m, "album", None)
    uri = getattr(m, "uri", None)
    try:
        image = mass.get_media_item_image_url(qi)
    except Exception:  # noqa: BLE001 - an image is optional
        image = None
    return {
        "index": index,
        "queue_item_id": qi.queue_item_id,
        "name": qi.name,
        "duration": qi.duration,
        "uri": uri,
        "id": uri.rsplit("/", 1)[-1] if uri else None,
        "jellyfin_id": _jellyfin_id(m) if m is not None else None,
        "title": getattr(m, "name", None) or qi.name,
        "artist": artists[0].name if artists else None,
        "album": getattr(album, "name", None),
        "album_id": _jellyfin_id(album) if album is not None else None,
        "image": image,
    }


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    async def get_queue(call: ServiceCall) -> ServiceResponse:
        mass, player_id = _mass_and_player(hass, entry, call.data[ATTR_ENTITY_ID])
        queue = await mass.player_queues.get_active_queue(player_id)
        if queue is None:
            return {"queue_id": None, "name": None, "total": 0, "current_index": None, "offset": 0, "items": []}
        offset, limit = call.data["offset"], call.data["limit"]
        items = await mass.player_queues.get_queue_items(queue.queue_id, limit=limit, offset=offset)
        return {
            "queue_id": queue.queue_id,
            "name": queue.display_name,
            "total": queue.items,
            "current_index": queue.current_index,
            "shuffle_enabled": queue.shuffle_enabled,
            "offset": offset,
            "items": [_item_view(mass, offset + i, qi) for i, qi in enumerate(items)],
        }

    async def play_index(call: ServiceCall) -> None:
        mass, player_id = _mass_and_player(hass, entry, call.data[ATTR_ENTITY_ID])
        queue = await mass.player_queues.get_active_queue(player_id)
        if queue is None:
            raise ServiceValidationError("this player has no queue")
        if call.data["index"] >= (queue.items or 0):
            raise ServiceValidationError(f"index {call.data['index']} is past the end of the queue ({queue.items})")
        await mass.player_queues.play_index(queue.queue_id, call.data["index"])

    hass.services.async_register(DOMAIN, "get_queue", get_queue, GET_QUEUE_SCHEMA, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "play_index", play_index, PLAY_INDEX_SCHEMA)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.services.async_remove(DOMAIN, "get_queue")
    hass.services.async_remove(DOMAIN, "play_index")
    return True
