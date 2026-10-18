"""Kindle Panel: the Home Assistant side of the kindle-home-nexus e-ink panel.

* The panel's whole configuration (tabs, entities, names, screensaver, schedule) is edited in the HA UI and read by
  the panel with `kindle_panel.get_config`. On its first start the panel seeds it with what it shipped with
  (`kindle_panel.seed`), including the photo marks it already collected.
* Screensaver photos come from HA (Immich favourites through HA's Immich connection, or any media-browser folder);
  the panel's F1 keep / F4 skip decisions are stored here (`pick_photo`, `mark_photo`).
* Music Assistant queues the HA integration does not pass on: `get_queue` (the whole queue) and `play_index`.
* The panel's music output (one MA player or MA group per panel, picked on the panel): `set_output`, stored here;
  `get_config` answers it with every MA player HA has (`music_output`, `outputs`).
The panel only ever talks to Home Assistant.
"""

from __future__ import annotations

from dataclasses import dataclass
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
from homeassistant.helpers.storage import Store

from .config import effective_sources, needs_media_migration, normalize
from .const import (
    CONF_MA_ENTRY,
    DOMAIN,
    EVENT_CONFIG_UPDATED,
    IMMICH_DOMAIN,
    LEGACY_MA_PLAYERS,
    MA_DOMAIN,
    NET_RADIO_SELECT_SUFFIX,
    OPT_CONFIG,
    OPT_EDITED,
    OPT_SEEDED,
    PAGE_KEYS,
    POWER_KEY_NONE,
)
from .photos import MarkStore, PhotoLibrary, pick

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
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Required("index"): vol.All(vol.Coerce(int), vol.Range(min=0)),
    }
)
SEED_SCHEMA = vol.Schema(
    {
        vol.Optional("config"): dict,
        # Only when given are the panel's own marks taken as handed over (marks_seeded).
        vol.Optional("kept"): vol.Any({cv.string: cv.string}, [cv.string]),
        vol.Optional("skipped"): vol.Any({cv.string: cv.string}, [cv.string]),
        vol.Optional("force", default=False): bool,
    }
)
PICK_SCHEMA = vol.Schema({vol.Optional("previous_id"): vol.Any(None, cv.string)})
SET_OUTPUT_SCHEMA = vol.Schema({vol.Required(ATTR_ENTITY_ID): vol.All(cv.entity_id, cv.entity_domain("media_player"))})
MARK_SCHEMA = vol.Schema(
    {
        vol.Required("photo_id"): vol.All(cv.string, vol.Length(min=1, max=512)),
        vol.Required("verdict"): vol.In(["keep", "skip", "clear"]),
    }
)


class OutputStore:
    """The panel's music output (an MA media_player), persisted in .storage; None = not chosen yet."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, 1, f"{DOMAIN}.music_output")
        self.output: str | None = None

    async def async_load(self) -> None:
        self.output = (await self._store.async_load() or {}).get("output")

    async def async_set(self, output: str | None) -> None:
        self.output = output
        await self._store.async_save({"output": output})


def ma_players(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Every Music Assistant media_player HA has (players and MA groups), names from HA, in entity id order."""
    out = []
    for e in sorted(er.async_get(hass).entities.values(), key=lambda x: x.entity_id):
        if e.platform != MA_DOMAIN or e.domain != "media_player" or e.disabled_by is not None:
            continue
        st = hass.states.get(e.entity_id)
        name = (st.name if st else None) or e.name or e.original_name or e.entity_id
        out.append({"entity_id": e.entity_id, "name": name, "state": st.state if st else "unavailable"})
    return out


def fill_net_radio(hass: HomeAssistant, nodes: list[dict[str, Any]]) -> None:
    """A receiver node without `net_radio` gets the NET RADIO station select of its receiver's device
    (yamaha_netbridge >= 0.3.0 with a station list), so the panel needs no extra setup. Only in get_config's answer;
    the stored config is not changed."""
    reg = er.async_get(hass)
    for n in nodes:
        if n.get("type") != "receiver" or n.get("net_radio"):
            continue
        main = reg.async_get(n.get("power_device") or "")
        if main is None or main.device_id is None:
            continue
        for e in er.async_entries_for_device(reg, main.device_id):
            if e.domain == "select" and (e.unique_id or "").endswith(NET_RADIO_SELECT_SUFFIX) and not e.disabled_by:
                n["net_radio"] = e.entity_id
                break


@dataclass
class PanelRuntime:
    marks: MarkStore
    library: PhotoLibrary
    output: OutputStore


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
    legacy = entry.options.get(OPT_CONFIG) or {}
    if (
        (legacy.get("lights") or legacy.get("plugs"))
        and OPT_SEEDED not in entry.options
        and OPT_EDITED not in entry.options
    ):
        # configured before the seeded flag existed (0.2 pre-release): it was seeded, never seed over it again
        hass.config_entries.async_update_entry(entry, options={**entry.options, OPT_SEEDED: True})
    marks = MarkStore(hass)
    await marks.async_load()
    output = OutputStore(hass)
    await output.async_load()
    if (
        output.output is None
        and needs_media_migration(legacy)
        and (legacy.get("media") or {}).get("music_backend") == "ha"
    ):
        # kindle_panel <= 0.4.0 played to the owner's amp (DLNA player) hard-wired: that stays the panel's output
        await output.async_set(LEGACY_MA_PLAYERS[0])
    rt = PanelRuntime(marks=marks, library=PhotoLibrary(hass), output=output)
    entry.runtime_data = rt

    async def get_queue(call: ServiceCall) -> ServiceResponse:
        mass, player_id = _mass_and_player(hass, entry, call.data[ATTR_ENTITY_ID])
        queue = await mass.player_queues.get_active_queue(player_id)
        if queue is None:
            return {
                "queue_id": None,
                "name": None,
                "total": 0,
                "current_index": None,
                "offset": 0,
                "items": [],
            }
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
        cfg = normalize(entry.options.get(OPT_CONFIG))
        fill_net_radio(hass, cfg["media"]["nodes"])
        outputs = ma_players(hass)
        ids = [o["entity_id"] for o in outputs]
        keys = cfg["media"]["output_keys"]
        if keys[0] == POWER_KEY_NONE and all(k == POWER_KEY_NONE for k in keys) and ids:
            cfg["media"]["output_keys"] = [ids[0], *keys[1:]]  # no receiver lists players: F1 = HA's first MA player
        return {
            "seeded": bool(entry.options.get(OPT_SEEDED)),
            "marks_seeded": rt.marks.seeded,
            "config": cfg,
            # the panel's music output; null (or not in `outputs` any more) = the panel opens its output picker
            "music_output": rt.output.output,
            "music_output_valid": rt.output.output in ids,
            "outputs": outputs,
            # what pick_photo uses: an empty source list means Immich favourites
            "effective_sources": effective_sources(cfg["screensaver"]["sources"]),
        }

    async def seed(call: ServiceCall) -> ServiceResponse:
        """The panel's first start: its shipped setup + its own photo marks. Never overwrites HA-side edits:
        it seeds once, and pages already saved in the HA UI keep what was saved there (unless `force`)."""
        result: dict[str, Any] = {"config": "kept"}
        force = call.data["force"]
        if "config" in call.data and (force or not entry.options.get(OPT_SEEDED)):
            try:
                cfg = normalize(call.data["config"])
            except vol.Invalid as err:
                raise ServiceValidationError(f"invalid panel config: {err}") from err
            current = normalize(entry.options.get(OPT_CONFIG))
            kept_pages = [] if force else [p for p in entry.options.get(OPT_EDITED, []) if p in PAGE_KEYS]
            for page in kept_pages:
                for key in PAGE_KEYS[page]:
                    cfg[key] = current[key]
            hass.config_entries.async_update_entry(entry, options={**entry.options, OPT_CONFIG: cfg, OPT_SEEDED: True})
            result["config"] = "seeded"
            if kept_pages:
                result["kept_pages"] = kept_pages
        if "kept" in call.data or "skipped" in call.data:
            added = rt.marks.merge(
                _as_dict(call.data.get("kept", {})),
                _as_dict(call.data.get("skipped", {})),
            )
            rt.marks.seeded = True
            await rt.marks.async_save()
            async_dispatcher_send(hass, SIGNAL_MARKS)
            result.update(kept_added=added[0], skipped_added=added[1])
        return result

    async def pick_photo(call: ServiceCall) -> ServiceResponse:
        cfg = panel_config(entry)["screensaver"]
        sources = effective_sources(cfg["sources"])
        candidates = await rt.library.candidates(sources)
        photo = pick(candidates, rt.marks, cfg["mode"], call.data.get("previous_id"))
        if photo is None:
            reason = "no photos left (all skipped?)" if candidates else "the photo sources have no photos"
            if not candidates and not hass.config_entries.async_loaded_entries(IMMICH_DOMAIN):
                reason = "Immich is not set up (or not loaded) in Home Assistant"
            return {"photo": None, "reason": reason, "candidates": len(candidates)}
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
        # Any id is accepted: the photo may have been picked before an HA restart (the panel keeps one all night) or
        # come from the panel's own Immich fallback; an id that matches no photo is never picked anyway.
        pid = call.data["photo_id"]
        rt.marks.mark(pid, call.data["verdict"])
        await rt.marks.async_save()
        async_dispatcher_send(hass, SIGNAL_MARKS)
        return {"kept": len(rt.marks.kept), "skipped": len(rt.marks.skipped)}

    async def set_output(call: ServiceCall) -> ServiceResponse:
        eid = call.data[ATTR_ENTITY_ID]
        if eid not in [o["entity_id"] for o in ma_players(hass)]:
            raise ServiceValidationError(f"{eid} is not a Music Assistant player")
        await rt.output.async_set(eid)
        hass.bus.async_fire(EVENT_CONFIG_UPDATED, {"entry_id": entry.entry_id, "music_output": eid})
        return {"music_output": eid}

    async def get_marks(call: ServiceCall) -> ServiceResponse:
        return {"kept": dict(rt.marks.kept), "skipped": dict(rt.marks.skipped)}

    hass.services.async_register(DOMAIN, "get_queue", get_queue, GET_QUEUE_SCHEMA, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "play_index", play_index, PLAY_INDEX_SCHEMA)
    hass.services.async_register(DOMAIN, "get_config", get_config, None, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "seed", seed, SEED_SCHEMA, SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, "pick_photo", pick_photo, PICK_SCHEMA, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "mark_photo", mark_photo, MARK_SCHEMA, SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, "get_marks", get_marks, None, SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "set_output", set_output, SET_OUTPUT_SCHEMA, SupportsResponse.OPTIONAL)

    entry.async_on_unload(entry.add_update_listener(_options_updated))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    # No reload: the panel re-reads the config within 30 s; the event is for automations.
    hass.bus.async_fire(EVENT_CONFIG_UPDATED, {"entry_id": entry.entry_id})


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    for svc in (
        "get_queue",
        "play_index",
        "get_config",
        "seed",
        "pick_photo",
        "mark_photo",
        "get_marks",
        "set_output",
    ):
        hass.services.async_remove(DOMAIN, svc)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
