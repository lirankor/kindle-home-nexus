"""Config flow (add the panel) and options flow (the panel's control center in the HA UI)."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector as sel

from .config import normalize
from .const import (
    CONF_MA_ENTRY,
    DOMAIN,
    LANGUAGES,
    LIGHT_ICONS,
    MA_DOMAIN,
    MUSIC_BACKENDS,
    OPT_CONFIG,
    PHOTO_MODES,
    ROOM_ICONS,
    SOURCE_IMMICH_FAVORITES,
    SOURCE_MEDIA,
    TABS,
)
from .photos import discover_sources


class KindlePanelConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        ma = self.hass.config_entries.async_entries(MA_DOMAIN)
        if user_input is None and len(ma) <= 1:
            user_input = {CONF_MA_ENTRY: ma[0].entry_id} if ma else {}
        if user_input is not None:
            # An empty panel config: the panel seeds it with its own setup on its next start.
            return self.async_create_entry(title="Kindle Panel", data=user_input, options={OPT_CONFIG: {}})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_MA_ENTRY): sel.ConfigEntrySelector(
                        sel.ConfigEntrySelectorConfig(integration=MA_DOMAIN)
                    )
                }
            ),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return KindlePanelOptionsFlow()


def _entity(domain: str | list[str]) -> sel.EntitySelector:
    return sel.EntitySelector(sel.EntitySelectorConfig(domain=domain))


def _select(options: list[str], key: str, multiple: bool = False) -> sel.SelectSelector:
    return sel.SelectSelector(sel.SelectSelectorConfig(options=options, translation_key=key, multiple=multiple))


def _num(lo: float, hi: float, step: float = 1, unit: str | None = None) -> sel.NumberSelector:
    return sel.NumberSelector(
        sel.NumberSelectorConfig(min=lo, max=hi, step=step, unit_of_measurement=unit, mode=sel.NumberSelectorMode.BOX)
    )


def _list(fields: dict[str, Any], label: str) -> sel.ObjectSelector:
    return sel.ObjectSelector(sel.ObjectSelectorConfig(fields=fields, multiple=True, label_field=label))


def _opt(key: str, value: Any) -> vol.Optional:
    """An optional field pre-filled with the current value (no default for empty values)."""
    if value in (None, "", [], {}):
        return vol.Optional(key)
    return vol.Optional(key, description={"suggested_value": value})


def _source_key(src: dict[str, Any]) -> str:
    return SOURCE_IMMICH_FAVORITES if src["type"] == SOURCE_IMMICH_FAVORITES else f"{SOURCE_MEDIA}:{src['id']}"


def _source_from_key(key: str, title: str | None) -> dict[str, Any]:
    if key == SOURCE_IMMICH_FAVORITES:
        return {"type": SOURCE_IMMICH_FAVORITES, "title": title or "Immich · Favourites"}
    return {"type": SOURCE_MEDIA, "id": key.split(":", 1)[1], "title": title or key}


MEDIA_KEYS = (
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


class KindlePanelOptionsFlow(OptionsFlow):
    """One menu, one page per area. Every page saves straight into the panel config."""

    def __init__(self) -> None:
        self._cfg: dict[str, Any] | None = None

    @property
    def cfg(self) -> dict[str, Any]:
        if self._cfg is None:
            self._cfg = normalize(self.config_entry.options.get(OPT_CONFIG))
        return self._cfg

    def _save(self) -> ConfigFlowResult:
        return self.async_create_entry(data={**self.config_entry.options, OPT_CONFIG: normalize(self.cfg)})

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=["general", "lights", "vacuum", "power", "media", "screensaver", "schedule"],
        )

    async def async_step_general(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["language"] = user_input["language"]
            c["tabs"] = user_input["tabs"]
            c["sensors"] = {k: user_input.get(k) for k in ("indoor_temperature", "indoor_humidity", "weather")}
            c["names"] = {**c.get("names", {}), "he": user_input.get("names_he") or {}}
            return self._save()
        s = c["sensors"]
        return self.async_show_form(
            step_id="general",
            data_schema=vol.Schema(
                {
                    vol.Required("language", default=c["language"]): _select(LANGUAGES, "language"),
                    vol.Required("tabs", default=c["tabs"]): _select(TABS, "tab", multiple=True),
                    _opt("indoor_temperature", s.get("indoor_temperature")): _entity("sensor"),
                    _opt("indoor_humidity", s.get("indoor_humidity")): _entity("sensor"),
                    _opt("weather", s.get("weather")): _entity("weather"),
                    _opt("names_he", c["names"].get("he")): sel.ObjectSelector(),
                }
            ),
        )

    async def async_step_lights(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["lights"] = user_input.get("lights") or []
            c["evening"] = {
                "entity_id": user_input.get("evening_light"),
                "brightness_pct": int(user_input.get("evening_pct", 40)),
                "warm_kelvin": int(user_input.get("warm_kelvin", 2200)),
            }
            return self._save()
        ev = c["evening"]
        return self.async_show_form(
            step_id="lights",
            data_schema=vol.Schema(
                {
                    _opt("lights", c["lights"]): _list(
                        {
                            "entity_id": {"required": True, "selector": {"entity": {"domain": "light"}}},
                            "name": {"required": True, "selector": {"text": {}}},
                            "room": {"selector": {"text": {}}},
                            "icon": {"selector": {"select": {"options": LIGHT_ICONS}}},
                        },
                        "name",
                    ),
                    _opt("evening_light", ev.get("entity_id")): _entity("light"),
                    vol.Optional("evening_pct", default=ev["brightness_pct"]): _num(1, 100, 1, "%"),
                    vol.Optional("warm_kelvin", default=ev["warm_kelvin"]): _num(1500, 7000, 100, "K"),
                }
            ),
        )

    async def async_step_vacuum(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["vacuum"] = {
                "entity_id": user_input.get("entity_id"),
                "battery_entity": user_input.get("battery_entity"),
                "rooms_script": user_input.get("rooms_script"),
                "rooms": user_input.get("rooms") or [],
            }
            return self._save()
        v = c["vacuum"]
        return self.async_show_form(
            step_id="vacuum",
            data_schema=vol.Schema(
                {
                    _opt("entity_id", v.get("entity_id")): _entity("vacuum"),
                    _opt("battery_entity", v.get("battery_entity")): _entity("sensor"),
                    _opt("rooms_script", v.get("rooms_script")): _entity("script"),
                    _opt("rooms", v.get("rooms")): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": ["input_boolean", "switch"]}},
                            },
                            "name": {"required": True, "selector": {"text": {}}},
                            "icon": {"selector": {"select": {"options": ROOM_ICONS}}},
                        },
                        "name",
                    ),
                }
            ),
        )

    async def async_step_power(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["plugs"] = user_input.get("plugs") or []
            return self._save()
        return self.async_show_form(
            step_id="power",
            data_schema=vol.Schema(
                {
                    _opt("plugs", c["plugs"]): _list(
                        {
                            "entity_id": {"required": True, "selector": {"entity": {"domain": "switch"}}},
                            "name": {"required": True, "selector": {"text": {}}},
                            "power_entity": {"selector": {"entity": {"domain": "sensor"}}},
                            "energy_entity": {"selector": {"entity": {"domain": "sensor"}}},
                            "energy_to_wh": {"selector": {"number": {"min": 0.001, "max": 1000000, "mode": "box"}}},
                        },
                        "name",
                    )
                }
            ),
        )

    async def async_step_media(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["media"] = {"music_backend": user_input["music_backend"], **{k: user_input.get(k) for k in MEDIA_KEYS}}
            return self._save()
        m = c["media"]
        return self.async_show_form(
            step_id="media",
            data_schema=vol.Schema(
                {
                    vol.Required("music_backend", default=m["music_backend"]): _select(MUSIC_BACKENDS, "music_backend"),
                    _opt("amp_player", m.get("amp_player")): _entity("media_player"),
                    _opt("amp_volume", m.get("amp_volume")): _entity("number"),
                    _opt("dlna_player", m.get("dlna_player")): _entity("media_player"),
                    _opt("amp_plug", m.get("amp_plug")): _entity("switch"),
                    _opt("amp_plug_power", m.get("amp_plug_power")): _entity("sensor"),
                    _opt("tv", m.get("tv")): _entity("media_player"),
                    _opt("movie_on", m.get("movie_on")): _entity("script"),
                    _opt("movie_off", m.get("movie_off")): _entity("script"),
                    _opt("movie_active", m.get("movie_active")): _entity("input_boolean"),
                    _opt("ynca_entry_id", m.get("ynca_entry_id")): sel.TextSelector(),
                }
            ),
        )

    async def async_step_screensaver(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        s = c["screensaver"]
        found = await discover_sources(self.hass)
        current = [_source_key(x) for x in s["sources"]]
        for src, key in zip(s["sources"], current, strict=True):  # configured sources stay selectable
            found.setdefault(key, src.get("title") or key)
        if user_input is not None:
            c["screensaver"] = {
                "idle_minutes": int(user_input["idle_minutes"]),
                "photo_minutes": int(user_input["photo_minutes"]),
                "mode": user_input["mode"],
                "sources": [_source_from_key(k, found.get(k)) for k in user_input.get("sources") or []],
            }
            return self._save()
        return self.async_show_form(
            step_id="screensaver",
            data_schema=vol.Schema(
                {
                    vol.Optional("sources", default=current): sel.SelectSelector(
                        sel.SelectSelectorConfig(
                            options=[sel.SelectOptionDict(value=k, label=v) for k, v in found.items()],
                            multiple=True,
                        )
                    ),
                    vol.Required("mode", default=s["mode"]): _select(PHOTO_MODES, "photo_mode"),
                    vol.Required("photo_minutes", default=s["photo_minutes"]): _num(1, 240, 1, "min"),
                    vol.Required("idle_minutes", default=s["idle_minutes"]): _num(1, 120, 1, "min"),
                }
            ),
        )

    async def async_step_schedule(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["schedule"] = {
                "radio_duty": bool(user_input["radio_duty"]),
                "day_wake_min": int(user_input["day_wake_min"]),
                "night_start": str(user_input["night_start"])[:5],
                "night_end": str(user_input["night_end"])[:5],
                "night_wake_min": int(user_input["night_wake_min"]),
                "timezone": user_input["timezone"],
            }
            return self._save()
        sc = c["schedule"]
        return self.async_show_form(
            step_id="schedule",
            data_schema=vol.Schema(
                {
                    vol.Required("radio_duty", default=sc["radio_duty"]): sel.BooleanSelector(),
                    vol.Required("day_wake_min", default=sc["day_wake_min"]): _num(1, 120, 1, "min"),
                    vol.Required("night_start", default=sc["night_start"]): sel.TimeSelector(),
                    vol.Required("night_end", default=sc["night_end"]): sel.TimeSelector(),
                    vol.Required("night_wake_min", default=sc["night_wake_min"]): _num(10, 720, 10, "min"),
                    vol.Required("timezone", default=sc["timezone"]): sel.TextSelector(),
                }
            ),
        )
