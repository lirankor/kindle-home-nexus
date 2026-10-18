"""Kindle Panel: the Home Assistant side of the kindle-home-nexus e-ink panel.

* The panel's whole configuration (tabs, entities, names, screensaver, schedule) is edited in the HA UI and read by
  the panel with `kindle_panel.get_config`. On its first start the panel seeds it with what it shipped with
  (`kindle_panel.seed`), including the photo marks it already collected.
* Screensaver photos come from HA (Immich favourites through HA's Immich connection, or any media-browser folder);
  the panel's F1 keep / F4 skip decisions are stored here (`pick_photo`, `mark_photo`).
* Music Assistant queues the HA integration does not pass on: `get_queue` (the whole queue) and `play_index`.
* The panel's music output (one MA player or MA group per panel, picked on the panel): `set_output`, stored here;
  `get_config` answers it with every MA player HA has (`music_output`, `outputs`: name, state, what it plays, player
  or group) plus the MA players HA has no entity for (`outputs_unexposed`, MA's "Expose to Home Assistant" is off).
* `move_queue`: Music Assistant's transfer_queue from the panel's output (or `source_player`) to another player, then
  that player becomes the panel's output (bus task 021). It checks the target first (available, its receiver not held,
  e.g. by a running movie-mode script) and, when MA's transfer fails anyway, puts the music back on the source and
  answers `{ok: false, error}` with the output unchanged (bus task 022).
* Picker rows hide what cannot be chosen (unavailable, or no HA entity) unless the panel option
  `media.show_unavailable_outputs` is on; each row carries `group_with` / `group_members` / `synced_to` (entity ids,
  from MA's `can_group_with` / sync state) for the picker's sync key, which calls HA's media_player.join / unjoin
  (bus task 022).
* `/api/kindle_panel/ma_image?url=…` (HA auth): Music Assistant's image proxy through HA, so cover art reaches a panel
  that can only talk to HA (bus task 021). Only the loaded MA server's /imageproxy URLs are fetched.
The panel only ever talks to Home Assistant.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import voluptuous as vol
from aiohttp import ClientError, ClientTimeout, web
from homeassistant.components.http import HomeAssistantView
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
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from yarl import URL

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
MOVE_QUEUE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): vol.All(cv.entity_id, cv.entity_domain("media_player")),
        # left out: the panel's current output
        vol.Optional("source_player"): vol.All(cv.entity_id, cv.entity_domain("media_player")),
        vol.Optional("auto_play", default=True): cv.boolean,
    }
)
MA_IMAGE_MAX_BYTES = 8 * 1024 * 1024
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


def _mass_client(hass: HomeAssistant) -> Any | None:
    """The music_assistant integration's client (its first loaded entry), None when MA is not loaded."""
    for e in hass.config_entries.async_loaded_entries(MA_DOMAIN):
        mass = getattr(getattr(e, "runtime_data", None), "mass", None)
        if mass is not None:
            return mass
    return None


def _enum(v: Any) -> str | None:
    return None if v is None else str(getattr(v, "value", v))


def _ma_kind(p: Any) -> str:
    """ "group" for an MA group player (sync group / universal group), else "player"."""
    if _enum(getattr(p, "type", None)) == "group" or getattr(p, "static_group_members", None):
        return "group"
    return "player"


def _now_line(st: Any) -> str | None:
    """What an HA media_player plays, in one line ("Title · Artist")."""
    if st is None:
        return None
    a = st.attributes
    parts = [x for x in (a.get("media_title"), a.get("media_artist")) if x]
    return " · ".join(str(x) for x in parts) or None


# MA player types that can play (MA's transfer_queue refuses the others: displays, visualisers, lights, protocols)
MA_PLAYBACK_TYPES = {"player", "stereo_pair", "group"}


def _ma_entity_ids(hass: HomeAssistant) -> dict[str, str]:
    """MA player id -> HA entity id, for every MA media_player HA has (enabled)."""
    return {
        e.unique_id: e.entity_id
        for e in er.async_get(hass).entities.values()
        if e.platform == MA_DOMAIN and e.domain == "media_player" and e.disabled_by is None
    }


def _sync_fields(p: Any, self_id: str, by_ma: dict[str, str]) -> dict[str, Any]:
    """Sync (MA: players that can play the same thing in sync) as HA entity ids: `group_with` = the players this one
    can be joined with (MA's can_group_with, only those HA has), `group_members` = the players synced to it when it
    leads a sync group (itself first, like HA's group_members), `synced_to` = the leader it follows (or None)."""
    can = [by_ma[x] for x in (getattr(p, "can_group_with", None) or []) if x in by_ma and by_ma[x] != self_id]
    members = [by_ma[x] for x in (getattr(p, "group_members", None) or []) if x in by_ma]
    leader = getattr(p, "synced_to", None)
    return {
        "group_with": sorted(set(can)),
        "group_members": members if len(members) > 1 else [],
        "synced_to": by_ma.get(leader) if leader else None,
    }


def ma_players(hass: HomeAssistant, mass: Any | None = None) -> list[dict[str, Any]]:
    """Every Music Assistant media_player HA has (players and MA groups), names from HA, in entity id order, with
    its state, what it plays (`now`) and `kind` player | group (from MA's own player list when MA is loaded), plus
    what it can sync with (`group_with`, `group_members`, `synced_to`; empty without MA)."""
    out = []
    by_ma = _ma_entity_ids(hass) if mass is not None else {}
    for e in sorted(er.async_get(hass).entities.values(), key=lambda x: x.entity_id):
        if e.platform != MA_DOMAIN or e.domain != "media_player" or e.disabled_by is not None:
            continue
        st = hass.states.get(e.entity_id)
        name = (st.name if st else None) or e.name or e.original_name or e.entity_id
        p = mass.players.get(e.unique_id) if mass is not None else None
        row: dict[str, Any] = {
            "entity_id": e.entity_id,
            "name": name,
            "state": st.state if st else "unavailable",
            "now": _now_line(st),
            "kind": _ma_kind(p) if p is not None else "player",
        }
        if p is not None and row["kind"] == "group":
            members = getattr(p, "group_members", None) or getattr(p, "static_group_members", None) or []
            row["members"] = [m for m in members if m != e.unique_id]
        row.update(
            _sync_fields(p, e.entity_id, by_ma)
            if p is not None
            else {"group_with": [], "group_members": [], "synced_to": None}
        )
        out.append(row)
    return out


def visible_outputs(
    outputs: list[dict[str, Any]], unexposed: list[dict[str, Any]], current: str | None, show_unavailable: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """What the picker lists (bus task 022): only what can be chosen, i.e. no `unavailable` player and no MA player
    without an HA entity (MA's web clients come and go with a browser tab). The panel's own output always stays listed.
    `show_unavailable_outputs` brings the rest back (greyed by the panel) for debugging."""
    if show_unavailable:
        return outputs, unexposed
    return [o for o in outputs if o["state"] != "unavailable" or o["entity_id"] == current], []


def receiver_held(hass: HomeAssistant, cfg: dict[str, Any], target_entity: str, target_ma_id: str) -> str | None:
    """The receiver behind an MA player is held (yamaha_netbridge `held`: a hold entity, e.g. a running movie-mode
    script, is on): the receiver's entity id, else None. Looked up through the panel's receiver nodes (`players`) and
    through MA's "Home Assistant media players" provider, whose player id is the HA entity it plays to."""
    candidates = [
        n.get("power_device")
        for n in cfg.get("media", {}).get("nodes", [])
        if n.get("type") == "receiver" and target_entity in (n.get("players") or [])
    ]
    if target_ma_id.startswith("media_player."):
        candidates.append(target_ma_id)
    for eid in candidates:
        st = hass.states.get(eid or "")
        if st is not None and st.attributes.get("held") is True:
            return st.entity_id
    return None


def ma_unexposed(hass: HomeAssistant, mass: Any | None) -> list[dict[str, Any]]:
    """MA players HA has no entity for (MA's per-player "Expose to Home Assistant" is off): listed so the picker
    shows what MA has, but not playable from HA until that setting is on."""
    if mass is None:
        return []
    known = {
        e.unique_id
        for e in er.async_get(hass).entities.values()
        if e.platform == MA_DOMAIN and e.domain == "media_player"
    }
    out = []
    for p in mass.players:
        if p.player_id in known or not getattr(p, "enabled", True):
            continue
        if (_enum(getattr(p, "type", None)) or "player") not in MA_PLAYBACK_TYPES:
            continue
        cm = getattr(p, "current_media", None)
        now = " · ".join(x for x in (getattr(cm, "title", None), getattr(cm, "artist", None)) if x) or None
        out.append(
            {
                "player_id": p.player_id,
                "name": getattr(p, "display_name", None) or p.name or p.player_id,
                "state": (_enum(getattr(p, "playback_state", None)) or "unknown")
                if getattr(p, "available", True)
                else "unavailable",
                "now": now,
                "kind": _ma_kind(p),
                "hidden_in_ma": bool(getattr(p, "hide_in_ui", False)),
            }
        )
    return sorted(out, key=lambda x: str(x["name"]).lower())


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


async def _restore_source(mass: Any, source_queue_id: str, source_id: str, target_id: str, was_playing: bool) -> str:
    """Undo a failed transfer_queue: MA had already moved the items to the target (and cleared the source) when the
    target refused to start, so move them back; when they never left, resume the source. Returns what was done."""
    try:
        target_queue = await mass.player_queues.get_active_queue(target_id)
        if target_queue is not None and target_queue.items:
            await mass.player_queues.transfer_queue(target_queue.queue_id, source_id, was_playing)
            return "moved_back"
        source_queue = await mass.player_queues.get_active_queue(source_id)
        if was_playing and source_queue is not None and source_queue.items:
            await mass.player_queues.resume(source_queue.queue_id)
            return "resumed"
    except Exception:  # noqa: BLE001 - best effort; the error of the move itself is what the panel shows
        return "failed"
    return "nothing"


# ---------------------------------------------------------------- Music Assistant images through HA


def ma_image_allowed(url: URL, ma_urls: list[str]) -> bool:
    """Only the image proxy of a loaded Music Assistant server (same scheme, host and port): no open proxy."""
    if url.scheme not in ("http", "https") or not url.path.startswith("/imageproxy"):
        return False
    for raw in ma_urls:
        try:
            ma = URL(raw)
        except ValueError:
            continue
        if (ma.scheme, ma.host, ma.port) == (url.scheme, url.host, url.port):
            return True
    return False


class MaImageView(HomeAssistantView):
    """GET /api/kindle_panel/ma_image?url=<MA imageproxy URL>: the image bytes (HA auth required). The panel runs
    where only HA is reachable (MA's port is not open to it), so cover art goes through HA."""

    url = "/api/kindle_panel/ma_image"
    name = "api:kindle_panel:ma_image"
    requires_auth = True

    async def get(self, request: web.Request) -> web.StreamResponse:
        hass: HomeAssistant = request.app["hass"]
        try:
            url = URL(request.query.get("url", ""))
        except ValueError:
            return web.Response(status=400)
        ma_urls = [str(e.data.get("url") or "") for e in hass.config_entries.async_loaded_entries(MA_DOMAIN)]
        if not ma_image_allowed(url, ma_urls):
            return web.Response(status=403)
        session = async_get_clientsession(hass)
        try:
            async with session.get(url, timeout=ClientTimeout(total=15)) as r:
                if r.status != 200:
                    return web.Response(status=404 if r.status == 404 else 502)
                ctype = r.headers.get("Content-Type", "")
                if not ctype.startswith("image/"):
                    return web.Response(status=502)
                # read to the end: StreamReader.read(n) returns only what has arrived so far (a cut-off cover)
                body = bytearray()
                async for chunk in r.content.iter_chunked(65536):
                    body += chunk
                    if len(body) > MA_IMAGE_MAX_BYTES:
                        return web.Response(status=413)
        except (ClientError, TimeoutError):
            return web.Response(status=504)
        return web.Response(
            body=bytes(body), content_type=ctype.split(";")[0], headers={"Cache-Control": "max-age=3600"}
        )


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
        mass = _mass_client(hass)
        all_outputs = ma_players(hass, mass)
        ids = [o["entity_id"] for o in all_outputs]
        outputs, unexposed = visible_outputs(
            all_outputs,
            ma_unexposed(hass, mass),
            rt.output.output,
            bool(cfg["media"].get("show_unavailable_outputs")),
        )
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
            # MA players without an HA entity (MA: Expose to Home Assistant off): only with show_unavailable_outputs
            "outputs_unexposed": unexposed,
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

    async def move_queue(call: ServiceCall) -> ServiceResponse:
        """Move the music: MA's transfer_queue from the panel's output (or `source_player`) to `entity_id`, which then
        becomes the panel's output. MA moves the whole queue and the position and stops the source.

        Bus task 022: MA's transfer stops and clears the source *before* the target starts, so a target that refuses
        (a receiver held by a running movie-mode script) used to leave nothing playing anywhere. Now the target is
        checked first, and a failed transfer is undone (the queue goes back to the source and plays on there); both
        answer `{ok: false, error, music_output}` with the panel's output unchanged."""
        target = call.data[ATTR_ENTITY_ID]
        source = call.data.get("source_player") or rt.output.output
        if not source:
            raise ServiceValidationError("the panel has no output to move the music from")
        if source == target:
            raise ServiceValidationError("the music is already on that player")
        mass, target_id = _mass_and_player(hass, entry, target)
        _, source_id = _mass_and_player(hass, entry, source)
        source_queue = await mass.player_queues.get_active_queue(source_id)
        if source_queue is None or not source_queue.items:
            raise ServiceValidationError(f"{source} has nothing to move")
        refused = {"ok": False, "music_output": rt.output.output, "moved_from": None, "target": target}
        st = hass.states.get(target)
        if st is None or st.state == "unavailable":
            return {**refused, "reason": "unavailable", "error": f"{target} is not available"}
        if held := receiver_held(hass, panel_config(entry), target, target_id):
            return {
                **refused,
                "reason": "held",
                "error": f"the receiver is held by another owner ({held}: a hold entity is on)",
            }
        was_playing = _enum(getattr(source_queue, "state", None)) == "playing"
        try:
            await mass.player_queues.transfer_queue(source_queue.queue_id, target_id, call.data["auto_play"])
        except Exception as err:  # noqa: BLE001 - MA's errors are plain exceptions; the music must not be lost
            restored = await _restore_source(mass, source_queue.queue_id, source_id, target_id, was_playing)
            return {**refused, "reason": "failed", "error": str(err) or type(err).__name__, "restored": restored}
        await rt.output.async_set(target)
        hass.bus.async_fire(EVENT_CONFIG_UPDATED, {"entry_id": entry.entry_id, "music_output": target})
        return {"ok": True, "music_output": target, "moved_from": source, "items": source_queue.items}

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
    hass.services.async_register(DOMAIN, "move_queue", move_queue, MOVE_QUEUE_SCHEMA, SupportsResponse.OPTIONAL)
    if not hass.data.get(f"{DOMAIN}_ma_image_view"):
        hass.http.register_view(MaImageView())
        hass.data[f"{DOMAIN}_ma_image_view"] = True

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
        "move_queue",
    ):
        hass.services.async_remove(DOMAIN, svc)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
