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
    CARD_TYPES,
    CUSTOM_ID,
    CUSTOM_PREFIX,
    DEFAULT_CARDS,
    DEFAULT_UNSPLASH_QUERY,
    ICON_AUTO,
    ICONS,
    LANGUAGES,
    LEGACY_BUILTIN_SCENES,
    LEGACY_MA_PLAYERS,
    LEGACY_MEDIA_KEYS,
    LEGACY_POWER_DEVICE,
    LEGACY_STREAM_OUTPUT,
    MAX_CARDS,
    MAX_CUSTOM_TABS,
    MAX_INPUT_ROWS,
    MAX_NODES,
    MAX_SCENES,
    MAX_TABS,
    MAX_TOGGLES,
    MEDIA_KEY_MUSIC,
    MUSIC_BACKENDS,
    NODE_TYPES,
    PHOTO_FALLBACKS,
    PHOTO_MODES,
    POWER_KEY_ALL_OFF,
    POWER_KEY_COUNT,
    POWER_KEY_NONE,
    SOURCE_IMMICH_FAVORITES,
    SOURCE_MEDIA,
    TABS,
    TOGGLE_DOMAINS,
)

CONFIG_VERSION = 2  # 2: media = typed device nodes + F-keys + output-picker keys (0.5.0, bus task 014); 0.5.1 adds
# optional node `inputs` rows and scripts on output-picker keys, both backward compatible (no version bump)
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _hhmm(v: Any) -> str:
    s = str(v).strip()
    if not HHMM.match(s):
        raise vol.Invalid("expected HH:MM")
    return s


# Every icon field takes a name of the one pack (bus task 019) or "auto" (bus task 020); a name the pack does not have
# is refused. "auto" and an empty field mean the entity's own HA icon and are stored as no icon (None, dropped below):
# the loader fills no pack default in, the app applies the row type's default at draw time.
_PACK = vol.In(ICONS)


def ICON(v: Any) -> str | None:  # used like the voluptuous validator it replaced
    return None if v in (None, "", ICON_AUTO) else _PACK(v)


def _no_icon(row: dict[str, Any]) -> dict[str, Any]:
    """A validated row without an icon of its own carries no `icon` key at all."""
    if row.get("icon") is None:
        row.pop("icon", None)
    return row


def _opt_entity(v: Any) -> str | None:
    return None if v in (None, "") else cv.entity_id(v)


LIGHT = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("name"): cv.string,
            vol.Optional("room", default=""): str,
            vol.Optional("icon"): ICON,
        }
    ),
    _no_icon,
)
ROOM = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("name"): cv.string,
            vol.Optional("icon"): ICON,
        }
    ),
    _no_icon,
)
PLUG = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("name"): cv.string,
            vol.Optional("power_entity"): _opt_entity,
            vol.Optional("energy_entity"): _opt_entity,
            vol.Optional("energy_to_wh", default=1): vol.Coerce(float),
            vol.Optional("icon"): ICON,
        }
    ),
    _no_icon,
)


SCENE = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): vol.All(cv.entity_id, cv.entity_domain(["scene", "script"])),
            vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
            vol.Optional("icon"): ICON,
        }
    ),
    _no_icon,
)


def _scene(v: Any) -> dict[str, Any]:
    """A Lights tab scene button: an HA scene or script."""
    return SCENE(v)


def _migrate(config: dict[str, Any]) -> dict[str, Any]:
    """Configs saved by kindle_panel <= 0.3.0: built-in Bright / Evening rows run the HA scenes that replaced them; the
    `evening` block (light, brightness, warm white) is gone (it lives in scene.evening now) and is dropped."""
    scenes = config.get("scenes")
    if isinstance(scenes, list):
        config["scenes"] = [
            {**{k: v for k, v in row.items() if k != "builtin"}, "entity_id": LEGACY_BUILTIN_SCENES[row["builtin"]]}
            if isinstance(row, dict) and row.get("builtin") in LEGACY_BUILTIN_SCENES and not row.get("entity_id")
            else row
            for row in scenes
        ]
    config.pop("evening", None)
    if isinstance(config.get("media"), dict) and needs_media_migration(config):
        config["media"] = migrate_media(config["media"])
    if config:
        config["version"] = CONFIG_VERSION
    return config


def needs_media_migration(config: dict[str, Any] | None) -> bool:
    """A config saved by kindle_panel <= 0.4.0: flat amp/tv fields under media, no nodes yet."""
    media = (config or {}).get("media")
    return isinstance(media, dict) and "nodes" not in media and any(media.get(k) for k in LEGACY_MEDIA_KEYS)


def migrate_media(old: dict[str, Any]) -> dict[str, Any]:
    """Version 1 -> 2: the amp fields become the receiver node `amp`, the TV fields the node `tv` (English names as
    before, so their Hebrew names in names.he still apply). With music played by HA, the receiver is the one the HA
    package had hard-wired (yamaha_netbridge's media_player, its stream select and its two MA players)."""
    ha = old.get("music_backend") == "ha"
    nodes: list[dict[str, Any]] = []
    power = LEGACY_POWER_DEVICE if ha else old.get("amp_player")
    if power:
        amp: dict[str, Any] = {"id": "amp", "type": "receiver", "name": "Yamaha R-N500", "power_device": power}
        for new, key in (
            ("volume", "amp_volume"),
            ("plug", "amp_plug"),
            ("plug_power", "amp_plug_power"),
            ("dlna_player", "dlna_player"),
            ("ynca_entry_id", "ynca_entry_id"),
        ):
            if old.get(key):
                amp[new] = old[key]
        if ha:
            amp["stream_output"] = LEGACY_STREAM_OUTPUT
            amp["players"] = list(LEGACY_MA_PLAYERS)
        nodes.append(amp)
    if old.get("tv"):
        tv: dict[str, Any] = {"id": "tv", "type": "tv", "name": "Sony TV", "entity": old["tv"]}
        for key in ("movie_on", "movie_off", "movie_active"):
            if old.get(key):
                tv[key] = old[key]
        nodes.append(tv)
    return {
        "music_backend": old.get("music_backend", "app"),
        "nodes": nodes,
        # the old Media footer had no music key; the new default: F1 music, F2 amp, F3 TV
        "output_keys": [LEGACY_MA_PLAYERS[0]] if ha else [],
    }


def _node_entity(domain: str) -> Any:
    if domain == "text":
        return vol.Any(None, str)
    if domain.endswith("[]"):
        d = domain[:-2]
        return vol.All(cv.ensure_list, [vol.All(cv.entity_id, cv.entity_domain(d))])
    return vol.Any(None, vol.All(cv.entity_id, cv.entity_domain(domain)))


INPUT_ROW = vol.Schema(
    {
        # the input as the device's media_player lists it in source_list (the receiver's own title)
        vol.Required("input"): vol.All(cv.string, vol.Strip, vol.Length(min=1, max=64)),
        vol.Optional("name"): vol.Any(None, vol.All(cv.string, vol.Strip, vol.Length(max=40))),
        vol.Optional("name_he"): vol.Any(None, vol.All(cv.string, vol.Strip, vol.Length(max=40))),
        vol.Optional("hidden", default=False): cv.boolean,
        # an icon pack name; none / auto (the default: an input has no entity) shows no icon on the input list
        vol.Optional("icon"): ICON,
    },
    extra=vol.REMOVE_EXTRA,
)


def _inputs(v: Any) -> list[dict[str, Any]]:
    """A node's input rows: renames / hidden inputs of its entity's source_list. Rows that change nothing are dropped;
    an input named twice is refused."""
    rows = [INPUT_ROW(r) for r in cv.ensure_list(v or [])]
    out: list[dict[str, Any]] = []
    for r in rows:
        row = {k: x for k, x in r.items() if x not in (None, "", False)}
        if len(row) == 1:
            continue  # only the input: nothing renamed, not hidden
        if any(o["input"] == row["input"] for o in out):
            raise vol.Invalid(f"input {row['input']!r} has two rows")
        out.append(row)
    if len(out) > MAX_INPUT_ROWS:
        raise vol.Invalid(f"at most {MAX_INPUT_ROWS} input rows")
    return out


def _node(v: Any) -> dict[str, Any]:
    """A Media tab node: {id, type, name, <the type's entity>, <the type's optional fields>, inputs} (see NODE_TYPES)."""
    if not isinstance(v, dict):
        raise vol.Invalid("a media node is an object")
    kind = v.get("type")
    if kind not in NODE_TYPES:
        raise vol.Invalid(f"unknown media node type {kind!r} (known: {', '.join(NODE_TYPES)})")
    t = NODE_TYPES[kind]
    field, domain = t["entity"]
    schema = vol.Schema(
        {
            vol.Required("id"): _custom_id,
            vol.Required("type"): kind,
            vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
            vol.Required(field, msg=f"a {kind} node needs {field}"): vol.All(cv.entity_id, cv.entity_domain(domain)),
            **{vol.Optional(k): _node_entity(d) for k, d in t["optional"].items()},
            vol.Optional("inputs"): _inputs,
            vol.Optional("icon"): ICON,
        },
        extra=vol.REMOVE_EXTRA,
    )
    # no icon / auto: the entity's HA icon, else the type's default (applied by the app)
    return {k: x for k, x in schema(v).items() if x not in (None, "", [])}


def _media_key(v: Any) -> str:
    if v in (None, "", POWER_KEY_NONE):
        return POWER_KEY_NONE
    s = str(v).strip()
    if s in (POWER_KEY_ALL_OFF, MEDIA_KEY_MUSIC) or re.match(CUSTOM_ID, s):
        return s  # a node id is checked against the nodes in normalize()
    return vol.All(cv.entity_id, cv.entity_domain("script"))(s)


def _output_key(v: Any) -> str:
    """Output picker F1..F4: none, a Music Assistant player / group, or a script (run instead of picking)."""
    if v in (None, "", POWER_KEY_NONE):
        return POWER_KEY_NONE
    return vol.All(cv.entity_id, cv.entity_domain(["media_player", "script"]))(v)


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
TOGGLE = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): vol.All(cv.entity_id, cv.entity_domain(TOGGLE_DOMAINS)),
            vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
            vol.Optional("icon"): ICON,
        }
    ),
    _no_icon,
)
CUSTOM_TAB = vol.All(
    vol.Schema(
        {
            vol.Required("title"): vol.All(cv.string, vol.Length(min=1, max=24)),
            # a tab has no entity: no icon / auto draws the custom tab default
            vol.Optional("icon"): ICON,
            vol.Optional("toggles", default=[]): vol.All([TOGGLE], vol.Length(max=MAX_TOGGLES)),
            # F1..F4: a toggle of this tab, a scene or script, all_off (every toggle of this tab off) or none
            vol.Optional("keys"): KEYS,
        }
    ),
    _no_icon,
)


def _custom_tabs(v: dict[str, Any]) -> dict[str, Any]:
    return {_custom_id(k): CUSTOM_TAB(t) for k, t in v.items()}


def _card(v: Any) -> dict[str, Any]:
    card = _no_icon(CARD_BASE(v))
    if card["type"] == "sensor" and not card.get("entity_id"):
        raise vol.Invalid("a sensor card needs an entity")
    return card


CARD_BASE = vol.Schema(
    {
        vol.Required("type"): vol.In(CARD_TYPES),
        vol.Optional("entity_id"): _opt_entity,
        vol.Optional("label"): vol.Any(None, str),
        vol.Optional("icon"): ICON,
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
                vol.Optional("nodes", default=[]): vol.All(cv.ensure_list, [_node], vol.Length(max=MAX_NODES)),
                # No defaults here: normalize() derives them from the nodes while the key is absent.
                vol.Optional("keys"): vol.Any(
                    None, vol.All(cv.ensure_list, [_media_key], vol.Length(max=POWER_KEY_COUNT))
                ),
                vol.Optional("output_keys"): vol.Any(
                    None, vol.All(cv.ensure_list, [_output_key], vol.Length(max=POWER_KEY_COUNT))
                ),
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
    """The default scene buttons: the HA scenes Bright and Evening (see the README for their YAML) and Movie (the
    movie-mode script). A missing scene shows as a button that HA answers with an error."""
    rows: list[dict[str, Any]] = [
        {"entity_id": "scene.bright", "name": "Bright", "icon": "sun"},
        {"entity_id": "scene.evening", "name": "Evening", "icon": "moon"},
    ]
    if movie := next((n.get("movie_on") for n in cfg.get("media", {}).get("nodes", []) if n.get("movie_on")), None):
        rows.append({"entity_id": movie, "name": "Movie", "icon": "film"})
    return rows


def default_power_keys(plugs: list[dict[str, Any]]) -> list[str]:
    """F1..F3 the first three entities of a tab's list, F4 all of them off: the Power tab as it always was (custom
    tabs start the same way)."""
    keys = [p["entity_id"] for p in plugs[: POWER_KEY_COUNT - 1]]
    return [*keys, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - 1 - len(keys)), POWER_KEY_ALL_OFF]


def default_media_keys(nodes: list[dict[str, Any]]) -> list[str]:
    """F1 the music screen, F2 the first receiver, F3 the first TV, F4 nothing (owner, 2026-10-18)."""
    first = {t: next((n["id"] for n in nodes if n["type"] == t), POWER_KEY_NONE) for t in ("receiver", "tv")}
    return [MEDIA_KEY_MUSIC, first["receiver"], first["tv"], POWER_KEY_NONE]


def default_output_keys(nodes: list[dict[str, Any]]) -> list[str]:
    """F1 = the first MA player of the first receiver that lists any (the panel adds HA's first MA player otherwise)."""
    first = next((n["players"][0] for n in nodes if n.get("players")), POWER_KEY_NONE)
    return [first, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - 1)]


def _pad(keys: list[str]) -> list[str]:
    return [*keys, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - len(keys))][:POWER_KEY_COUNT]


def _keys(keys: list[str] | None, rows: list[dict[str, Any]]) -> list[str]:
    if keys is None:
        return default_power_keys(rows)
    return [*keys, *[POWER_KEY_NONE] * (POWER_KEY_COUNT - len(keys))]


def normalize(config: dict[str, Any] | None) -> dict[str, Any]:
    """Validated config with every default filled in (raises vol.Invalid)."""
    cfg = CONFIG_SCHEMA(_migrate(copy.deepcopy(config or {})))
    if cfg.get("scenes") is None:
        cfg["scenes"] = default_scenes(cfg)
    cfg["power_keys"] = _keys(cfg.get("power_keys"), cfg["plugs"])
    for tab in cfg["custom_tabs"].values():
        tab["keys"] = _keys(tab.get("keys"), tab["toggles"])
    media = cfg["media"]
    ids = [n["id"] for n in media["nodes"]]
    if len(set(ids)) != len(ids):
        raise vol.Invalid("two media nodes have the same id")
    media["keys"] = _pad(media["keys"]) if media.get("keys") is not None else default_media_keys(media["nodes"])
    for key in media["keys"]:
        if re.match(CUSTOM_ID, key) and key not in (POWER_KEY_NONE, POWER_KEY_ALL_OFF, MEDIA_KEY_MUSIC) + tuple(ids):
            raise vol.Invalid(f"media key {key!r} names no node")
    media["output_keys"] = (
        _pad(media["output_keys"]) if media.get("output_keys") else default_output_keys(media["nodes"])
    )
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
