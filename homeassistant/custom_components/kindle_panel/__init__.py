"""Kindle Panel: the Home Assistant side of the kindle-home-nexus e-ink panel.

* The panel's whole configuration (tabs, entities, names, screensaver, schedule) is edited in the HA UI and read by
  the panel with `kindle_panel.get_config`. On its first start the panel seeds it with what it shipped with
  (`kindle_panel.seed`), including the photo marks it already collected.
* Screensaver photos come from HA (Immich favourites through HA's Immich connection, or any media-browser folder);
  the panel's F1 keep / F4 skip decisions are stored here (`pick_photo`, `mark_photo`).
* Music Assistant queues the HA integration does not pass on: `get_queue` (the whole queue) and `play_index`.
The panel only ever talks to Home Assistant.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import ATTR_ENTITY_ID, Platform
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .config import is_empty, normalize
from .const import CONF_MA_ENTRY, DOMAIN, EVENT_CONFIG_UPDATED, MA_DOMAIN, OPT_CONFIG
from .photos import MarkStore, Photo, PhotoLibrary, pick

PLATFORMS = [Platform.SENSOR]
SIGNAL_MARKS = f"{DOMAIN}_marks_updated"

GET_QUEUE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional("offset", default=0): vol.All(vol.Coerce(int), vol.Range(min=0)),
        vol.Optional("limit", default=200): vol.All(vol.Coerce(int), vol.Range(min=1, max=500)),
    }
)
PLAY_INDEX_SCHEMA = vol.Schema(
    {vol.Required(ATTR_ENTITY_ID): cv.entity_id, vol.Required("index"): vol.All(vol.Coerce(int), vol.Range(min=0))}
)
SEED_SCHEMA = vol.Schema(
    {
        vol.Optional("config"): dict,
        vol.Optional("kept", default={}): vol.Any({cv.string: cv.string}, [cv.string]),
        vol.Optional("skipped", default={}): vol.Any({cv.string: cv.string}, [cv.string]),
        vol.Optional("force", default=False): bool,
    }
)
PICK_SCHEMA = vol.Schema({vol.Optional("previous_id"): vol.Any(None, cv.string)})
MARK_SCHEMA = vol.Schema(
    {vol.Required("photo_id"): cv.string, vol.Required("verdict"): vol.In(["keep", "skip", "clear"])}
)


@dataclass
class PanelRuntime:
    marks: MarkStore
    library: PhotoLibrary
    served: deque[str] = field(default_factory=lambda: deque(maxlen=32))
    last: dict[str, Photo] = field(default_factory=dict)


type KindlePanelConfigEntry = ConfigEntry[PanelRuntime]


def panel_config(entry: ConfigEntry) -> dict[str, Any]:
    return normalize(entry.options.get(OPT_CONFIG))


def _as_dict(v: dict[str, str] | list[str]) -> dict[str, str]:
    return v if isinstance(v, dict) else dict.fromkeys(v, "")


# ---------------------------------------------------------------- Music Assistant queue


def _mass_and_player(hass: HomeAssistant, entry: ConfigEntry, entity_id: str) -> tuple[Any, str]:
    reg = er.async_get(hass).async_get(entity_id)
    if reg is None or reg.platform != MA_DOMAIN:
        raise ServiceValidationError(f"{entity_id} is not a Music Assistant player")
    ma_entry = hass.config_entries.async_get_entry(reg.config_entry_id or entry.data.get(CONF_MA_ENTRY) or "")
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


# ---------------------------------------------------------------- setup


async def async_setup_entry(hass: HomeAssistant, entry: KindlePanelConfigEntry) -> bool:
    marks = MarkStore(hass)
    await marks.async_load()
    rt = PanelRuntime(marks=marks, library=PhotoLibrary(hass))
    entry.runtime_data = rt

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

    async def get_config(call: ServiceCall) -> ServiceResponse:
        raw = entry.options.get(OPT_CONFIG)
        return {"seeded": not is_empty(raw), "marks_seeded": rt.marks.seeded, "config": normalize(raw)}

    async def seed(call: ServiceCall) -> ServiceResponse:
        """The panel's first start: its shipped setup + its own photo marks. Never overwrites HA-side edits."""
        result: dict[str, Any] = {"config": "kept"}
        if "config" in call.data and (call.data["force"] or is_empty(entry.options.get(OPT_CONFIG))):
            try:
                cfg = normalize(call.data["config"])
            except vol.Invalid as err:
                raise ServiceValidationError(f"invalid panel config: {err}") from err
            hass.config_entries.async_update_entry(entry, options={**entry.options, OPT_CONFIG: cfg})
            result["config"] = "seeded"
        added = rt.marks.merge(_as_dict(call.data["kept"]), _as_dict(call.data["skipped"]))
        rt.marks.seeded = True
        await rt.marks.async_save()
        async_dispatcher_send(hass, SIGNAL_MARKS)
        result.update(kept_added=added[0], skipped_added=added[1])
        return result

    async def pick_photo(call: ServiceCall) -> ServiceResponse:
        cfg = panel_config(entry)["screensaver"]
        sources = cfg["sources"]
        if not sources:
            return {"photo": None, "reason": "no photo sources configured"}
        candidates = await rt.library.candidates(sources)
        photo = pick(candidates, rt.marks, cfg["mode"], call.data.get("previous_id"))
        if photo is None:
            return {"photo": None, "reason": "no photos left (all skipped?)", "candidates": len(candidates)}
        rt.served.append(photo.id)
        rt.last[photo.id] = photo
        return {
            "photo": {
                "id": photo.id,
                "url": await rt.library.resolve(photo),
                "title": photo.title,
                "source": photo.source,
                "kept": photo.id in rt.marks.kept,
            },
            "candidates": len(candidates),
            "kept": len(rt.marks.kept),
            "skipped": len(rt.marks.skipped),
        }

    async def mark_photo(call: ServiceCall) -> ServiceResponse:
        pid = call.data["photo_id"]
        if pid not in rt.served and pid not in rt.marks.kept and pid not in rt.marks.skipped:
            raise ServiceValidationError("not a photo shown recently")
        rt.marks.mark(pid, call.data["verdict"])
        await rt.marks.async_save()
        async_dispatcher_send(hass, SIGNAL_MARKS)
        return {"kept": len(rt.marks.kept), "skipped": len(rt.marks.skipped)}

    async def get_marks(call: ServiceCall) -> ServiceResponse:
        return {"kept": dict(rt.marks.kept), "skipped": dict(rt.marks.skipped)}

    hass.services.async_register(DOMAIN, "get_queue", get_queue, GET_QUEUE_SCHEMA, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "play_index", play_index, PLAY_INDEX_SCHEMA)
    hass.services.async_register(DOMAIN, "get_config", get_config, None, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "seed", seed, SEED_SCHEMA, SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, "pick_photo", pick_photo, PICK_SCHEMA, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "mark_photo", mark_photo, MARK_SCHEMA, SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, "get_marks", get_marks, None, SupportsResponse.ONLY)

    entry.async_on_unload(entry.add_update_listener(_options_updated))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    # No reload: the panel re-reads the config (it polls and listens for this event).
    hass.bus.async_fire(EVENT_CONFIG_UPDATED, {"entry_id": entry.entry_id})


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    for svc in ("get_queue", "play_index", "get_config", "seed", "pick_photo", "mark_photo", "get_marks"):
        hass.services.async_remove(DOMAIN, svc)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
