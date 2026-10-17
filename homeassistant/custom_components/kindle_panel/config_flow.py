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

from .config import effective_sources, normalize
from .const import (
    CARD_ICONS,
    CARD_TYPES,
    CONF_MA_ENTRY,
    DOMAIN,
    LANGUAGES,
    LIGHT_ICONS,
    MA_DOMAIN,
    MUSIC_BACKENDS,
    OPT_CONFIG,
    OPT_EDITED,
    PHOTO_FALLBACKS,
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


def _tab_rows(tabs: list[str]) -> list[dict[str, str]]:
    """The tab order as list-editor rows: HA 2026.8's select selector has no reorder, the object list editor has drag handles."""
    return [{"tab": t} for t in tabs]


def _tabs_from_rows(rows: Any, fallback: list[str]) -> list[str]:
    out: list[str] = []
    for row in rows or []:
        t = row.get("tab") if isinstance(row, dict) else None
        if t in TABS and t not in out:
            out.append(t)
    return out or fallback


def _num(lo: float, hi: float, step: float = 1, unit: str | None = None) -> sel.NumberSelector:
    return sel.NumberSelector(
        sel.NumberSelectorConfig(
            min=lo,
            max=hi,
            step=step,
            unit_of_measurement=unit,
            mode=sel.NumberSelectorMode.BOX,
        )
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
        return {
            "type": SOURCE_IMMICH_FAVORITES,
            "title": title or "Immich · Favourites",
        }
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


CARD_LABELS = {
    "outdoor": "Outdoor (weather)",
    "indoor": "Indoor (temperature, humidity)",
    "calendar": "Calendar",
    "sensor": "Sensor (any entity)",
}


class KindlePanelOptionsFlow(OptionsFlow):
    """One menu, one page per area. Every page saves straight into the panel config."""

    def __init__(self) -> None:
        self._cfg: dict[str, Any] | None = None
        self._found: dict[str, str] | None = None  # photo sources, listed once per visit
        self._error: str | None = None

    @property
    def cfg(self) -> dict[str, Any]:
        if self._cfg is None:
            self._cfg = normalize(self.config_entry.options.get(OPT_CONFIG))
        return self._cfg

    def _save(self, page: str) -> ConfigFlowResult | None:
        """Store the config; on invalid input None (the page is shown again with the error and what was typed)."""
        try:
            cfg = normalize(self.cfg)
        except vol.Invalid as err:
            self._error = str(err)
            return None
        self._error = None
        edited = sorted({*self.config_entry.options.get(OPT_EDITED, []), page})
        return self.async_create_entry(data={**self.config_entry.options, OPT_CONFIG: cfg, OPT_EDITED: edited})

    def _form(self, step_id: str, schema: vol.Schema) -> ConfigFlowResult:
        return self.async_show_form(
            step_id=step_id,
            data_schema=schema,
            errors={"base": "invalid_config"} if self._error else None,
            description_placeholders={"error": self._error or ""},
        )

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=[
                "general",
                "lights",
                "vacuum",
                "power",
                "media",
                "screensaver",
                "schedule",
            ],
        )

    async def async_step_general(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["language"] = user_input["language"]
            c["tabs"] = _tabs_from_rows(user_input.get("tabs"), c["tabs"])
            c["sensors"] = {k: user_input.get(k) for k in ("indoor_temperature", "indoor_humidity", "weather")}
            c["names"] = {**c.get("names", {}), "he": user_input.get("names_he") or {}}
            if (done := self._save("general")) is not None:
                return done
        s = c["sensors"]
        return self._form(
            "general",
            vol.Schema(
                {
                    vol.Required("language", default=c["language"]): _select(LANGUAGES, "language"),
                    _opt("tabs", _tab_rows(c["tabs"])): _list(
                        {"tab": {"label": "Tab", "required": True, "selector": {"select": {"options": TABS, "translation_key": "tab"}}}},
                        "tab",
                    ),
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
            if (done := self._save("lights")) is not None:
                return done
        ev = c["evening"]
        return self._form(
            "lights",
            vol.Schema(
                {
                    _opt("lights", c["lights"]): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": "light"}},
                            },
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
            if (done := self._save("vacuum")) is not None:
                return done
        v = c["vacuum"]
        return self._form(
            "vacuum",
            vol.Schema(
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
            if (done := self._save("power")) is not None:
                return done
        return self._form(
            "power",
            vol.Schema(
                {
                    _opt("plugs", c["plugs"]): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": "switch"}},
                            },
                            "name": {"required": True, "selector": {"text": {}}},
                            "power_entity": {"selector": {"entity": {"domain": "sensor"}}},
                            "energy_entity": {"selector": {"entity": {"domain": "sensor"}}},
                            "energy_to_wh": {
                                "selector": {
                                    "number": {
                                        "min": 0.001,
                                        "max": 1000000,
                                        "mode": "box",
                                    }
                                }
                            },
                        },
                        "name",
                    )
                }
            ),
        )

    async def async_step_media(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["media"] = {
                "music_backend": user_input["music_backend"],
                **{k: user_input.get(k) for k in MEDIA_KEYS},
            }
            if (done := self._save("media")) is not None:
                return done
        m = c["media"]
        return self._form(
            "media",
            vol.Schema(
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
        if self._found is None:
            self._found = await discover_sources(self.hass)
        found = dict(self._found)
        shown = effective_sources(s["sources"])  # an empty list means Immich favourites, so that is the default
        current = [_source_key(x) for x in shown]
        for src, key in zip(shown, current, strict=True):  # configured sources stay selectable
            found.setdefault(key, src.get("title") or key)
        if user_input is not None:
            c["screensaver"] = {
                "idle_minutes": int(user_input["idle_minutes"]),
                "photo_minutes": int(user_input["photo_minutes"]),
                "mode": user_input["mode"],
                "sources": [_source_from_key(k, found.get(k)) for k in user_input.get("sources") or []],
                "cards": [
                    {k: v for k, v in card.items() if v not in (None, "")} for card in user_input.get("cards") or []
                ],
                "fallback": user_input["fallback"],
                "unsplash_query": (user_input.get("unsplash_query") or "").strip() or s["unsplash_query"],
                "unsplash_key": None
                if user_input.get("unsplash_key_clear")
                else (user_input.get("unsplash_key") or "").strip() or s.get("unsplash_key"),
            }
            if (done := self._save("screensaver")) is not None:
                return done
        return self._form(
            "screensaver",
            vol.Schema(
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
                    _opt("cards", s["cards"]): _list(
                        {
                            # Labels spelled out here: the frontend does not translate selects nested in an object.
                            "type": {
                                "label": "Card",
                                "required": True,
                                "selector": {
                                    "select": {
                                        "options": [{"value": t, "label": CARD_LABELS[t]} for t in CARD_TYPES],
                                    }
                                },
                            },
                            "entity_id": {"label": "Entity (sensor card)", "selector": {"entity": {}}},
                            "label": {"label": "Label (sensor card)", "selector": {"text": {}}},
                            "icon": {"label": "Icon (sensor card)", "selector": {"select": {"options": CARD_ICONS}}},
                        },
                        "type",
                    ),
                    vol.Required("fallback", default=s["fallback"]): _select(PHOTO_FALLBACKS, "photo_fallback"),
                    vol.Optional("unsplash_query", default=s["unsplash_query"]): sel.TextSelector(),
                    # The stored key is never sent back to the browser: empty keeps it, the checkbox removes it.
                    vol.Optional("unsplash_key"): sel.TextSelector(
                        sel.TextSelectorConfig(type=sel.TextSelectorType.PASSWORD)
                    ),
                    vol.Optional("unsplash_key_clear", default=False): sel.BooleanSelector(),
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
            if (done := self._save("schedule")) is not None:
                return done
        sc = c["schedule"]
        return self._form(
            "schedule",
            vol.Schema(
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
