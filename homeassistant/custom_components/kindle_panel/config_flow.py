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

from .config import default_power_keys, effective_sources, normalize
from .const import (
    CARD_ICONS,
    CARD_TYPES,
    CONF_MA_ENTRY,
    CUSTOM_PREFIX,
    DOMAIN,
    LANGUAGES,
    LIGHT_ICONS,
    MA_DOMAIN,
    MUSIC_BACKENDS,
    OPT_CONFIG,
    OPT_EDITED,
    PHOTO_FALLBACKS,
    PHOTO_MODES,
    POWER_KEY_ALL_OFF,
    POWER_KEY_COUNT,
    POWER_KEY_NONE,
    ROOM_ICONS,
    SCENE_ICONS,
    SOURCE_IMMICH_FAVORITES,
    SOURCE_MEDIA,
    TOGGLE_DOMAINS,
    TOGGLE_ICONS,
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


TAB_LABELS = {"lights": "Lights", "vacuum": "Vacuum", "power": "Power", "media": "Media"}


def _tab_rows(tabs: list[str]) -> list[dict[str, str]]:
    """The tab order as list-editor rows: HA 2026.8's select selector has no reorder, the object list editor has drag handles."""
    return [{"tab": t} for t in tabs]


def _tabs_from_rows(rows: Any, known: list[str], fallback: list[str]) -> list[str]:
    out: list[str] = []
    for row in rows or []:
        t = row.get("tab") if isinstance(row, dict) else None
        if t in known and t not in out:
            out.append(t)
    return out or fallback


# ---- Hebrew names: one optional column per row (stored in names.he, keyed by the English name, as before)


def _he(cfg: dict[str, Any], name: str | None) -> str | None:
    return cfg["names"].get("he", {}).get(name or "") or None


def _with_he(cfg: dict[str, Any], rows: list[dict[str, Any]], key: str = "name") -> list[dict[str, Any]]:
    """Rows for a list editor, each with its Hebrew name (empty fields are left out)."""
    out = []
    for row in rows:
        r = dict(row)
        if he := _he(cfg, r.get(key)):
            r[f"{key}_he"] = he
        out.append(r)
    return out


def _take_he(cfg: dict[str, Any], rows: Any, key: str = "name") -> list[dict[str, Any]]:
    """Rows without their Hebrew column; the Hebrew names go to names.he (an emptied field removes the entry)."""
    he = dict(cfg["names"].get("he", {}))
    out = []
    for row in rows or []:
        r = {k: v for k, v in dict(row).items() if v not in (None, "")}
        value = str(r.pop(f"{key}_he", "") or "").strip()
        name = str(r.get(key) or "").strip()
        if name:
            if value:
                he[name] = value
            else:
                he.pop(name, None)
        out.append(r)
    cfg["names"] = {**cfg["names"], "he": he}
    return out


def _row_names(cfg: dict[str, Any]) -> set[str]:
    """English names that have a row (and so a Hebrew column) somewhere in the options."""
    names = {x["name"] for key in ("lights", "plugs", "scenes") for x in cfg[key]}
    names |= {r["name"] for r in cfg["vacuum"]["rooms"]}
    for tab in cfg["custom_tabs"].values():
        names.add(tab["title"])
        names |= {t["name"] for t in tab["toggles"]}
    return names


NAME_HE = {"label": "Hebrew name", "selector": {"text": {}}}


def _runs_options(hass: Any) -> dict[str, str]:
    """Every HA scene and script, for a scene button or a soft key."""
    out: dict[str, str] = {}
    for st in sorted(hass.states.async_all(["scene", "script"]), key=lambda x: x.entity_id):
        kind = "Scene" if st.domain == "scene" else "Script"
        out[st.entity_id] = f"{kind}: {st.name} ({st.entity_id})"
    return out


def _key_select(choices: dict[str, str]) -> sel.SelectSelector:
    return sel.SelectSelector(
        sel.SelectSelectorConfig(
            options=[sel.SelectOptionDict(value=k, label=v) for k, v in choices.items()],
            mode=sel.SelectSelectorMode.DROPDOWN,
        )
    )


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


def _scene_rows(scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stored scene buttons as list-editor rows ("runs": the HA scene or script)."""
    return [{"runs": s["entity_id"], "name": s["name"], "icon": s.get("icon", "star")} for s in scenes]


def _scenes_from_rows(rows: Any) -> list[dict[str, Any]]:
    return [
        {
            "entity_id": str(row.get("runs") or ""),  # empty or wrong: normalize() refuses it and the page shows why
            "name": (row.get("name") or "").strip(),
            "icon": row.get("icon") or "star",
        }
        for row in rows or []
    ]


def _power_key_field(i: int) -> str:
    return f"key_f{i + 1}"


class KindlePanelOptionsFlow(OptionsFlow):
    """One menu, one page per area. Every page saves straight into the panel config."""

    def __init__(self) -> None:
        self._cfg: dict[str, Any] | None = None
        self._found: dict[str, str] | None = None  # photo sources, listed once per visit
        self._error: str | None = None
        self._tab_id: str | None = None  # the custom tab being edited

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

    def _form(self, step_id: str, schema: vol.Schema, **placeholders: str) -> ConfigFlowResult:
        return self.async_show_form(
            step_id=step_id,
            data_schema=schema,
            errors={"base": "invalid_config"} if self._error else None,
            description_placeholders={"error": self._error or "", **placeholders},
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
                "custom_tabs",
                "screensaver",
                "schedule",
            ],
        )

    async def async_step_general(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        tab_labels = {
            **TAB_LABELS,
            **{f"{CUSTOM_PREFIX}{k}": f"Custom: {v['title']}" for k, v in c["custom_tabs"].items()},
        }
        covered = _row_names(c)
        if user_input is not None:
            c["language"] = user_input["language"]
            c["tabs"] = _tabs_from_rows(user_input.get("tabs"), list(tab_labels), c["tabs"])
            c["sensors"] = {k: user_input.get(k) for k in ("indoor_temperature", "indoor_humidity", "weather")}
            # Names with a row keep what their row says; the box holds the others (light rooms, media devices, ...).
            kept = {k: v for k, v in c["names"].get("he", {}).items() if k in covered}
            c["names"] = {**c.get("names", {}), "he": {**kept, **(user_input.get("names_he") or {})}}
            if (done := self._save("general")) is not None:
                return done
        s = c["sensors"]
        others = {k: v for k, v in c["names"].get("he", {}).items() if k not in covered}
        return self._form(
            "general",
            vol.Schema(
                {
                    vol.Required("language", default=c["language"]): _select(LANGUAGES, "language"),
                    _opt("tabs", _tab_rows(c["tabs"])): _list(
                        {
                            "tab": {
                                "label": "Tab",
                                "required": True,
                                "selector": {
                                    "select": {"options": [{"value": k, "label": v} for k, v in tab_labels.items()]}
                                },
                            }
                        },
                        "tab",
                    ),
                    _opt("indoor_temperature", s.get("indoor_temperature")): _entity("sensor"),
                    _opt("indoor_humidity", s.get("indoor_humidity")): _entity("sensor"),
                    _opt("weather", s.get("weather")): _entity("weather"),
                    _opt("names_he", others): sel.ObjectSelector(),
                }
            ),
        )

    async def async_step_lights(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        c = self.cfg
        if user_input is not None:
            c["lights"] = _take_he(c, user_input.get("lights"))
            c["scenes"] = _scenes_from_rows(_take_he(c, user_input.get("scenes")))
            if (done := self._save("lights")) is not None:
                return done
        # What a scene button can run: every HA scene and script (configured ones stay listed).
        runs = _runs_options(self.hass)
        rows = _with_he(c, _scene_rows(c["scenes"]))
        for row in rows:
            runs.setdefault(row["runs"], row["runs"])
        return self._form(
            "lights",
            vol.Schema(
                {
                    _opt("lights", _with_he(c, c["lights"])): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": "light"}},
                            },
                            "name": {"required": True, "selector": {"text": {}}},
                            "name_he": NAME_HE,
                            "room": {"selector": {"text": {}}},
                            "icon": {"selector": {"select": {"options": LIGHT_ICONS}}},
                        },
                        "name",
                    ),
                    _opt("scenes", rows): _list(
                        {
                            # Labels spelled out here: the frontend does not translate fields nested in an object.
                            "runs": {
                                "label": "Runs",
                                "required": True,
                                "selector": {
                                    "select": {
                                        "options": [{"value": k, "label": v} for k, v in runs.items()],
                                        "mode": "dropdown",
                                    }
                                },
                            },
                            "name": {"label": "Name", "required": True, "selector": {"text": {}}},
                            "name_he": NAME_HE,
                            "icon": {"label": "Icon", "selector": {"select": {"options": SCENE_ICONS}}},
                        },
                        "name",
                    ),
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
                "rooms": _take_he(c, user_input.get("rooms")),
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
                    _opt("rooms", _with_he(c, v.get("rooms") or [])): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": ["input_boolean", "switch"]}},
                            },
                            "name": {"required": True, "selector": {"text": {}}},
                            "name_he": NAME_HE,
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
            c["plugs"] = _take_he(c, user_input.get("plugs"))
            c["power_keys"] = [user_input.get(_power_key_field(i)) or POWER_KEY_NONE for i in range(POWER_KEY_COUNT)]
            if (done := self._save("power")) is not None:
                return done
        # F1..F4: a plug, all plugs off, or nothing. Plugs added on this page are offered once it was saved and reopened.
        choices = {p["entity_id"]: f"Plug: {p['name']}" for p in c["plugs"]}
        choices[POWER_KEY_ALL_OFF] = "All plugs off"
        choices[POWER_KEY_NONE] = "Nothing"
        for key in c["power_keys"]:
            choices.setdefault(key, f"{key} (not in the plug list)")
        key_select = _key_select(choices)
        return self._form(
            "power",
            vol.Schema(
                {
                    _opt("plugs", _with_he(c, c["plugs"])): _list(
                        {
                            "entity_id": {
                                "required": True,
                                "selector": {"entity": {"domain": "switch"}},
                            },
                            "name": {"required": True, "selector": {"text": {}}},
                            "name_he": NAME_HE,
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
                    ),
                    **{vol.Required(_power_key_field(i), default=k): key_select for i, k in enumerate(c["power_keys"])},
                }
            ),
        )

    async def async_step_custom_tabs(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Create, rename and delete custom tabs; their order and presence on the screen is the tabs list (General)."""
        c = self.cfg
        if user_input is not None:
            old = c["custom_tabs"]
            blocks: dict[str, Any] = {}
            for row in _take_he(c, user_input.get("custom_tabs"), "title"):
                tid = str(row.get("id") or "").strip()
                blocks[tid] = {
                    **old.get(tid, {"toggles": []}),
                    "title": row.get("title") or tid,
                    "icon": row.get("icon") or "star",
                }
            c["custom_tabs"] = blocks
            # a deleted tab takes its Hebrew names along (unless another row still uses them)
            gone = {
                n for t, b in old.items() if t not in blocks for n in (b["title"], *(x["name"] for x in b["toggles"]))
            }
            still = _row_names(c)
            c["names"] = {
                **c["names"],
                "he": {k: v for k, v in c["names"].get("he", {}).items() if k not in gone or k in still},
            }
            # a new tab shows up at the end of the tab bar; a deleted one leaves it (normalize drops its entry)
            c["tabs"] = [*c["tabs"], *[f"{CUSTOM_PREFIX}{t}" for t in blocks if t not in old]]
            edit = user_input.get("edit")
            if edit and edit in blocks:
                try:  # the toggles page saves both pages together
                    self._cfg = normalize(c)
                except vol.Invalid as err:
                    self._error = str(err)
                else:
                    self._error = None
                    self._tab_id = edit
                    return await self.async_step_custom_tab()
            elif (done := self._save("custom_tabs")) is not None:
                return done
        rows = _with_he(
            c, [{"id": k, "title": v["title"], "icon": v["icon"]} for k, v in c["custom_tabs"].items()], "title"
        )
        return self._form(
            "custom_tabs",
            vol.Schema(
                {
                    _opt("custom_tabs", rows): _list(
                        {
                            "id": {
                                "label": "Id (a-z, 0-9, _; keep it once chosen)",
                                "required": True,
                                "selector": {"text": {}},
                            },
                            "title": {"label": "Title", "required": True, "selector": {"text": {}}},
                            "title_he": {"label": "Hebrew title", "selector": {"text": {}}},
                            "icon": {"label": "Icon", "selector": {"select": {"options": TOGGLE_ICONS}}},
                        },
                        "title",
                    ),
                    vol.Optional("edit"): sel.SelectSelector(
                        sel.SelectSelectorConfig(
                            options=[
                                sel.SelectOptionDict(value=k, label=v["title"]) for k, v in c["custom_tabs"].items()
                            ],
                            mode=sel.SelectSelectorMode.DROPDOWN,
                            custom_value=True,  # the id of a tab created on this very page
                        )
                    ),
                }
            ),
        )

    def _custom_tab(self) -> dict[str, Any] | None:
        tid = self._tab_id
        return self.cfg["custom_tabs"].get(tid) if tid else None

    async def async_step_custom_tab(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """One custom tab, first page: its toggles (the keys page after it offers them)."""
        c = self.cfg
        if (tab := self._custom_tab()) is None:
            return self.async_abort(reason="custom_tab_gone")
        if user_input is not None:
            untouched = tab.get("keys") == default_power_keys(tab["toggles"])
            tab["toggles"] = _take_he(c, user_input.get("toggles"))
            if untouched:  # keys still at their default follow the toggles
                tab.pop("keys", None)
            try:
                self._cfg = normalize(c)
            except vol.Invalid as err:
                self._error = str(err)
            else:
                self._error = None
                return await self.async_step_custom_tab_keys()
        return self._form(
            "custom_tab",
            vol.Schema(
                {
                    _opt("toggles", _with_he(c, tab["toggles"])): _list(
                        {
                            "entity_id": {
                                "label": "Entity",
                                "required": True,
                                "selector": {"entity": {"domain": TOGGLE_DOMAINS}},
                            },
                            "name": {"label": "Name", "required": True, "selector": {"text": {}}},
                            "name_he": NAME_HE,
                            "icon": {"label": "Icon", "selector": {"select": {"options": TOGGLE_ICONS}}},
                        },
                        "name",
                    ),
                }
            ),
            title=tab["title"],
        )

    async def async_step_custom_tab_keys(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """One custom tab, second page: what F1..F4 do. Saves the custom tab pages of this visit."""
        if (tab := self._custom_tab()) is None:
            return self.async_abort(reason="custom_tab_gone")
        if user_input is not None:
            tab["keys"] = [user_input.get(_power_key_field(i)) or POWER_KEY_NONE for i in range(POWER_KEY_COUNT)]
            if (done := self._save("custom_tabs")) is not None:
                return done
        choices = {t["entity_id"]: f"Toggle: {t['name']}" for t in tab["toggles"]}
        choices[POWER_KEY_ALL_OFF] = "All toggles of this tab off"
        choices[POWER_KEY_NONE] = "Nothing"
        choices |= _runs_options(self.hass)
        for key in tab["keys"]:
            choices.setdefault(key, f"{key} (not available)")
        key_select = _key_select(choices)
        return self._form(
            "custom_tab_keys",
            vol.Schema({vol.Required(_power_key_field(i), default=k): key_select for i, k in enumerate(tab["keys"])}),
            title=tab["title"],
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
