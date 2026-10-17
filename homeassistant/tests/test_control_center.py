"""The panel's control center: config seeding, options pages, screensaver photos with keep/skip."""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.exceptions import ServiceValidationError
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kindle_panel.photos import MarkStore, Photo, pick

DOMAIN = "kindle_panel"

HOUSE = {
    "language": "he",
    "tabs": ["lights", "vacuum", "power", "media"],
    "names": {"he": {"Main light": "אור ראשי"}},
    "lights": [
        {
            "entity_id": "light.main_light",
            "name": "Main light",
            "room": "Living room",
            "icon": "lamp_ceiling",
        }
    ],
    "vacuum": {
        "entity_id": "vacuum.robo",
        "rooms": [
            {
                "entity_id": "input_boolean.robo_grid_1",
                "name": "Shower",
                "icon": "shower",
            }
        ],
    },
    "plugs": [
        {
            "entity_id": "switch.tv_plug",
            "name": "TV Plug",
            "power_entity": "sensor.tv_power",
            "energy_to_wh": 1,
        }
    ],
    "screensaver": {"sources": [{"type": "immich_favorites"}], "mode": "curate"},
}


async def call(hass, svc, **data):
    return await hass.services.async_call(DOMAIN, svc, data, blocking=True, return_response=True)


@pytest.fixture
async def panel(hass: HomeAssistant, tmp_path):
    (tmp_path / "photos").mkdir()
    for name in ("a.jpg", "b.jpg", "c.jpg"):
        (tmp_path / "photos" / name).write_bytes(b"\xff\xd8\xff")
    hass.config.media_dirs = {"local": str(tmp_path)}
    assert await async_setup_component(hass, "media_source", {})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    return hass.config_entries.async_entries(DOMAIN)[0]


async def test_fresh_panel_asks_to_be_seeded(hass, panel) -> None:
    r = await call(hass, "get_config")
    assert r["seeded"] is False and r["marks_seeded"] is False
    assert r["config"]["tabs"] == ["lights", "vacuum", "power", "media"] and r["config"]["lights"] == []


async def test_seed_preserves_household_and_marks(hass, panel) -> None:
    r = await call(
        hass,
        "seed",
        config=HOUSE,
        kept={"asset1": "2026-10-01T00:00:00Z"},
        skipped=["asset2"],
    )
    assert r == {"config": "seeded", "kept_added": 1, "skipped_added": 1}
    got = await call(hass, "get_config")
    assert got["seeded"] and got["config"]["lights"][0]["name"] == "Main light"
    assert got["config"]["names"]["he"]["Main light"] == "אור ראשי"
    # a second seed (panel restarted) never overwrites what was edited in HA, and marks merge idempotently
    edited = dict(HOUSE, language="en")
    r = await call(hass, "seed", config=edited, kept=["asset1", "asset3"])
    assert r == {"config": "kept", "kept_added": 1, "skipped_added": 0}
    assert (await call(hass, "get_config"))["config"]["language"] == "he"
    marks = await call(hass, "get_marks")
    assert set(marks["kept"]) == {"asset1", "asset3"} and set(marks["skipped"]) == {"asset2"}
    assert hass.states.get("sensor.kindle_panel_kept_photos").state == "2"
    assert hass.states.get("sensor.kindle_panel_skipped_photos").state == "1"


async def test_seed_without_marks_keeps_asking_for_them(hass, panel) -> None:
    # the panel could not read its marks file (state dir not mounted): config seeded, marks still wanted
    r = await call(hass, "seed", config=HOUSE)
    assert r == {"config": "seeded"}
    got = await call(hass, "get_config")
    assert got["seeded"] is True and got["marks_seeded"] is False
    r = await call(hass, "seed", kept={"asset1": "2026-10-01T00:00:00Z"})
    assert r == {"config": "kept", "kept_added": 1, "skipped_added": 0}
    assert (await call(hass, "get_config"))["marks_seeded"] is True


async def test_page_saved_before_the_first_seed_survives_it(hass, panel) -> None:
    # The owner opens Configure before the panel ever connected and saves only the schedule page.
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "schedule"})
    sched = {
        "radio_duty": False,
        "day_wake_min": 15,
        "night_start": "23:00:00",
        "night_end": "06:30:00",
        "night_wake_min": 120,
        "timezone": "Europe/Berlin",
    }
    res = await hass.config_entries.options.async_configure(flow["flow_id"], sched)
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert (await call(hass, "get_config"))["seeded"] is False  # still waiting for the panel's setup
    r = await call(hass, "seed", config=HOUSE, kept=[])
    assert r["config"] == "seeded" and r["kept_pages"] == ["schedule"]
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["lights"][0]["name"] == "Main light"  # the panel's setup arrived
    assert cfg["schedule"]["night_start"] == "23:00" and cfg["schedule"]["radio_duty"] is False  # the edit stayed


async def test_invalid_input_shows_the_page_again(hass, panel) -> None:
    await call(hass, "seed", config=HOUSE)
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "schedule"})
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "radio_duty": True,
            "day_wake_min": 10,
            "night_start": "00:00:00",
            "night_end": "06:00:00",
            "night_wake_min": 120,
            "timezone": "Mars/Olympus",
        },
    )
    assert res["type"] is FlowResultType.FORM and res["errors"] == {"base": "invalid_config"}
    assert "time zone" in res["description_placeholders"]["error"].lower()
    assert (await call(hass, "get_config"))["config"]["schedule"]["timezone"] == "Europe/Berlin"  # nothing stored


async def test_no_immich_in_ha_says_so(hass, panel) -> None:
    await call(hass, "seed", config=HOUSE)  # screensaver source: Immich favourites, but no Immich entry in HA
    r = await call(hass, "pick_photo")
    assert r["photo"] is None and r["candidates"] == 0 and "Immich" in r["reason"]


async def test_seed_rejects_garbage(hass, panel) -> None:
    with pytest.raises(ServiceValidationError):
        await call(hass, "seed", config={"lights": [{"entity_id": "not an entity"}]})


async def test_options_pages_edit_the_config(hass, panel) -> None:
    await call(hass, "seed", config=HOUSE)
    events = []
    hass.bus.async_listen("kindle_panel_config_updated", lambda e: events.append(e))
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    assert flow["type"] is FlowResultType.MENU
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "lights"})
    assert flow["step_id"] == "lights"
    lights = [
        {
            "entity_id": "light.main_light",
            "name": "Main light",
            "room": "Living room",
            "icon": "lamp_ceiling",
        },
        {
            "entity_id": "light.spots",
            "name": "Spot light",
            "room": "Living room",
            "icon": "spot",
        },
    ]
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "lights": lights,
            "evening_light": "light.main_light",
            "evening_pct": 40,
            "warm_kelvin": 2200,
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    cfg = (await call(hass, "get_config"))["config"]
    assert [x["name"] for x in cfg["lights"]] == ["Main light", "Spot light"]
    assert cfg["plugs"][0]["name"] == "TV Plug"  # other pages untouched
    assert events


async def test_screensaver_page_offers_media_folders(hass, panel) -> None:
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "screensaver"})
    options = flow["data_schema"].schema["sources"].config["options"]
    folder = next(o for o in options if "local" in o["value"])
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "sources": [folder["value"]],
            "mode": "curate",
            "photo_minutes": 10,
            "idle_minutes": 5,
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    src = (await call(hass, "get_config"))["config"]["screensaver"]["sources"]
    assert src[0]["type"] == "media_source"


async def test_pick_and_mark_from_a_local_folder(hass, panel) -> None:
    await call(
        hass,
        "seed",
        config={
            **HOUSE,
            "screensaver": {
                "sources": [
                    {
                        "type": "media_source",
                        "id": "media-source://media_source/local/photos",
                    }
                ]
            },
        },
    )
    seen = set()
    for _ in range(20):
        r = await call(hass, "pick_photo")
        seen.add(r["photo"]["id"])
        assert r["photo"]["url"].startswith("/media/local/photos/")
    assert len(seen) == 3
    a = min(seen)
    await call(hass, "mark_photo", photo_id=a, verdict="skip")
    for _ in range(15):
        assert (await call(hass, "pick_photo"))["photo"]["id"] != a  # skipped: never again
    # F1 after an HA restart (nothing "served" in memory any more) or on a photo from the panel's own Immich fallback
    r = await call(hass, "mark_photo", photo_id="picked-before-restart", verdict="keep")
    assert r == {"kept": 1, "skipped": 1}


async def test_immich_favourites_through_has_immich(hass, panel) -> None:
    pages = {
        1: {
            "assets": {
                "items": [
                    {
                        "id": "p1",
                        "originalFileName": "p1.jpg",
                        "exifInfo": {"exifImageWidth": 3000, "exifImageHeight": 4000},
                    },
                    {
                        "id": "l1",
                        "originalFileName": "l1.jpg",
                        "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000},
                    },
                ],
                "nextPage": None,
            }
        }
    }

    async def do_request(end_point, data=None, method="GET", **kw):
        assert end_point == "search/metadata" and data["isFavorite"] is True
        return pages[data["page"]]

    immich = MockConfigEntry(domain="immich", unique_id="imm1", state=ConfigEntryState.LOADED)
    immich.add_to_hass(hass)
    immich.runtime_data = SimpleNamespace(api=SimpleNamespace(async_do_request=do_request))
    await call(hass, "seed", config=HOUSE, kept=["l1"])  # l1 already kept on the panel before the migration
    r = await call(hass, "pick_photo")
    assert r["photo"]["id"] == "p1"  # curate: not judged yet first
    assert r["photo"]["url"] == "/immich/imm1/p1/preview/image/jpeg"
    await call(hass, "mark_photo", photo_id="p1", verdict="keep")
    ids, prev = [], "p1"
    for _ in range(4):  # the previous photo is never picked twice in a row while there is another
        prev = (await call(hass, "pick_photo", previous_id=prev))["photo"]["id"]
        ids.append(prev)
    assert ids == ["l1", "p1", "l1", "p1"]  # all judged: the kept ones


def test_pick_modes() -> None:
    photos = [Photo(i, f"/{i}", i, "s") for i in ("k", "s", "u")]
    m = MarkStore.__new__(MarkStore)
    m.kept, m.skipped, m.seeded = {"k": ""}, {"s": ""}, True
    rnd = random.Random(1)
    assert {pick(photos, m, "curate", None, rnd).id for _ in range(20)} == {"u"}
    assert {pick(photos, m, "kept_only", None, rnd).id for _ in range(20)} == {"k"}
    assert {pick(photos, m, "all_but_skipped", None, rnd).id for _ in range(30)} == {
        "k",
        "u",
    }
    m.skipped = {"k": "", "s": "", "u": ""}
    assert pick(photos, m, "curate", None, rnd) is None


async def test_screensaver_cards_and_unsplash_fallback(hass, panel) -> None:
    await call(hass, "seed", config=HOUSE)
    cfg = (await call(hass, "get_config"))["config"]["screensaver"]
    assert [c["type"] for c in cfg["cards"]] == ["outdoor", "indoor", "calendar"]  # as the panel always showed
    assert cfg["fallback"] == "unsplash" and cfg["unsplash_query"] == "black and white art"

    async def save(**extra):
        flow = await hass.config_entries.options.async_init(panel.entry_id)
        flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "screensaver"})
        data = {"sources": [], "mode": "curate", "photo_minutes": 10, "idle_minutes": 5, "fallback": "unsplash"}
        return await hass.config_entries.options.async_configure(flow["flow_id"], {**data, **extra})

    cards = [
        {"type": "calendar"},
        {"type": "sensor", "entity_id": "sensor.tv_power", "label": "TV", "icon": "zap"},
    ]
    res = await save(cards=cards, unsplash_query="bauhaus architecture", unsplash_key=" abc123 ")
    assert res["type"] is FlowResultType.CREATE_ENTRY
    s = (await call(hass, "get_config"))["config"]["screensaver"]
    assert s["cards"] == cards and s["unsplash_query"] == "bauhaus architecture" and s["unsplash_key"] == "abc123"

    # the stored key never goes back to the browser; empty keeps it, the checkbox removes it
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "screensaver"})
    assert "abc123" not in repr(flow["data_schema"].schema)
    hass.config_entries.options.async_abort(flow["flow_id"])
    assert (await save(cards=cards))["type"] is FlowResultType.CREATE_ENTRY
    assert (await call(hass, "get_config"))["config"]["screensaver"]["unsplash_key"] == "abc123"
    assert (await save(cards=cards, unsplash_key_clear=True))["type"] is FlowResultType.CREATE_ENTRY
    assert (await call(hass, "get_config"))["config"]["screensaver"].get("unsplash_key") is None

    res = await save(cards=[{"type": "sensor", "label": "no entity"}])  # a sensor card needs an entity
    assert res["type"] is FlowResultType.FORM and res["errors"] == {"base": "invalid_config"}
    res = await save(cards=[{"type": "calendar"}] * 4)  # the panel fits three
    assert res["type"] is FlowResultType.FORM and res["errors"] == {"base": "invalid_config"}


async def test_entry_configured_before_the_seeded_flag_is_not_reseeded(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Kindle Panel", data={}, options={"config": HOUSE})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (await call(hass, "get_config"))["seeded"] is True
    r = await call(hass, "seed", config=dict(HOUSE, language="en"))
    assert r["config"] == "kept"


def _node(cid, title, expand=True, ctype="app", children=None):
    return SimpleNamespace(
        media_content_id=cid, title=title, can_expand=expand, media_content_type=ctype, children=children or []
    )


async def test_discover_sources_walks_only_photo_libraries(hass, monkeypatch) -> None:
    """Q14: Radio Browser, TTS, AI task, camera and image entities are never browsed; Immich albums are offered
    without listing their photos; local folders with images are offered."""
    import asyncio

    from custom_components.kindle_panel import photos

    imm = "media-source://immich/u1"
    tree = {
        None: _node(
            None,
            "Media sources",
            children=[
                _node(f"media-source://{d}", d)
                for d in ("radio_browser", "tts", "ai_task", "camera", "image", "immich", "media_source")
            ],
        ),
        "media-source://immich": _node("", "Immich", children=[_node(imm, "Owner")]),
        imm: _node(imm, "Owner", children=[_node(f"{imm}|albums", "albums")]),
        f"{imm}|albums": _node("", "albums", children=[_node(f"{imm}|albums|a1", "Book pick")]),
        "media-source://media_source": _node(
            "", "My media", children=[_node("media-source://media_source/local/photos", "photos")]
        ),
        "media-source://media_source/local/photos": _node(
            "", "photos", children=[_node("media-source://media_source/local/photos/x.jpg", "x", False, "image/jpeg")]
        ),
    }
    browsed: list[str | None] = []

    async def browse(_hass, cid):
        browsed.append(cid)
        if cid not in tree:
            await asyncio.sleep(30)  # what Radio Browser feels like
        return tree[cid]

    monkeypatch.setattr(photos.media_source, "async_browse_media", browse)
    found = await photos.discover_sources(hass)
    assert found == {
        f"media_source:{imm}|albums|a1": "immich · Owner · albums · Book pick",
        "media_source:media-source://media_source/local/photos": "media_source · photos",
    }
    assert not [c for c in browsed if c and c.split("/")[2] in ("radio_browser", "tts", "ai_task", "camera", "image")]


async def test_discover_sources_is_capped_by_time(hass, monkeypatch) -> None:
    import asyncio
    import time

    from custom_components.kindle_panel import photos

    root = _node(None, "Media sources", children=[_node("media-source://media_source", "My media")])

    async def browse(_hass, cid):
        if cid is None:
            return root
        await asyncio.sleep(30)  # a huge or hanging folder

    monkeypatch.setattr(photos.media_source, "async_browse_media", browse)
    t = time.monotonic()
    assert await photos.discover_sources(hass, budget=0.3) == {}
    assert time.monotonic() - t < 2


async def test_no_sources_means_immich_favourites(hass, panel) -> None:
    """Owner, 2026-10-17: an empty screensaver source list shows Immich favourites (pick, get_config, options page)."""

    async def do_request(end_point, data=None, method="GET", **kw):
        assert end_point == "search/metadata" and data["isFavorite"] is True
        return {"assets": {"items": [{"id": "f1", "originalFileName": "f1.jpg"}], "nextPage": None}}

    immich = MockConfigEntry(domain="immich", unique_id="imm1", state=ConfigEntryState.LOADED)
    immich.add_to_hass(hass)
    immich.runtime_data = SimpleNamespace(api=SimpleNamespace(async_do_request=do_request))
    await call(hass, "seed", config={**HOUSE, "screensaver": {"sources": [], "mode": "curate"}})
    got = await call(hass, "get_config")
    assert got["config"]["screensaver"]["sources"] == []  # stored as left
    assert [s["type"] for s in got["effective_sources"]] == ["immich_favorites"]
    r = await call(hass, "pick_photo")
    assert r["photo"]["id"] == "f1" and r["photo"]["source"]

    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "screensaver"})
    field = next(k for k in flow["data_schema"].schema if k == "sources")
    assert field.default() == ["immich_favorites"]
    assert "immich_favorites" in [o["value"] for o in flow["data_schema"].schema["sources"].config["options"]]
    hass.config_entries.options.async_abort(flow["flow_id"])


# ---------------------------------------------------------------- task 011: scene buttons + Power tab keys

PLUGS3 = [{"entity_id": f"switch.plug_{i}", "name": f"Plug {i}", "energy_to_wh": 1} for i in (1, 2, 3)]


def test_scene_and_key_defaults_reproduce_the_old_screen() -> None:
    from custom_components.kindle_panel.config import normalize

    cfg = normalize({"plugs": PLUGS3, "media": {"movie_on": "script.movie_mode"}})
    assert cfg["scenes"] == [
        {"builtin": "bright", "name": "Bright", "icon": "sun"},
        {"builtin": "evening", "name": "Evening", "icon": "moon"},
        {"entity_id": "script.movie_mode", "name": "Movie", "icon": "film"},
    ]
    assert cfg["power_keys"] == ["switch.plug_1", "switch.plug_2", "switch.plug_3", "all_off"]
    # fewer plugs, no movie script: the gaps stay empty, F4 is still "all off"
    one = normalize({"plugs": PLUGS3[:1]})
    assert [s.get("builtin") for s in one["scenes"]] == ["bright", "evening"]
    assert one["power_keys"] == ["switch.plug_1", "none", "none", "all_off"]
    # saved values are kept as saved; an empty scene list stays empty; short key lists are padded
    kept = normalize({"plugs": PLUGS3, "scenes": [], "power_keys": ["all_off"]})
    assert kept["scenes"] == [] and kept["power_keys"] == ["all_off", "none", "none", "none"]
    assert normalize(kept) == kept  # stable


@pytest.mark.parametrize(
    "scenes",
    [
        [{"name": "Nothing to run"}],
        [{"entity_id": "scene.a", "builtin": "bright", "name": "Both"}],
        [{"entity_id": "light.main_light", "name": "Not a scene"}],
        [{"builtin": "disco", "name": "Unknown built-in"}],
        [{"entity_id": f"scene.s{i}", "name": f"S{i}"} for i in range(4)],  # F4 stays "all off"
    ],
)
def test_bad_scene_buttons_are_refused(scenes) -> None:
    import voluptuous as vol

    from custom_components.kindle_panel.config import normalize

    with pytest.raises(vol.Invalid):
        normalize({"scenes": scenes})


async def test_lights_page_edits_the_scene_buttons(hass, panel) -> None:
    hass.states.async_set("script.movie_mode", "off", {"friendly_name": "Movie mode"})
    hass.states.async_set("scene.reading", "2026-10-17T20:00:00+00:00", {"friendly_name": "Reading"})
    await call(hass, "seed", config={**HOUSE, "media": {"movie_on": "script.movie_mode"}})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "lights"})
    schema = {str(k): v for k, v in flow["data_schema"].schema.items()}
    fields = schema["scenes"].config["fields"]
    offered = [o["value"] for o in fields["runs"]["selector"]["select"]["options"]]
    assert offered[:2] == ["builtin:bright", "builtin:evening"]
    assert "script.movie_mode" in offered and "scene.reading" in offered
    current = next(k for k in flow["data_schema"].schema if str(k) == "scenes").description["suggested_value"]
    assert [r["runs"] for r in current] == ["builtin:bright", "builtin:evening", "script.movie_mode"]

    rows = [
        {"runs": "scene.reading", "name": "Reading", "icon": "book"},
        {"runs": "builtin:evening", "name": "Evening", "icon": "moon"},
    ]
    base = {"lights": HOUSE["lights"], "evening_light": "light.main_light", "evening_pct": 30, "warm_kelvin": 2400}
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {**base, "scenes": rows})
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["scenes"] == [
        {"entity_id": "scene.reading", "name": "Reading", "icon": "book"},
        {"builtin": "evening", "name": "Evening", "icon": "moon"},
    ]
    assert cfg["evening"] == {"entity_id": "light.main_light", "brightness_pct": 30, "warm_kelvin": 2400}
    assert cfg["power_keys"] == ["switch.tv_plug", "none", "none", "all_off"]  # other page untouched

    # only the offered choices pass the form (HA validates the nested select) ...
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "lights"})
    with pytest.raises(InvalidData):
        await hass.config_entries.options.async_configure(
            flow["flow_id"], {**base, "scenes": [{"runs": "light.main_light", "name": "Oops", "icon": "star"}]}
        )
    # ... and a fourth button (F4 stays "all off") brings the page back with the reason, nothing stored
    four = [{"runs": "scene.reading", "name": f"R{i}", "icon": "book"} for i in range(4)]
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {**base, "scenes": four})
    assert res["type"] is FlowResultType.FORM and res["errors"] == {"base": "invalid_config"}
    assert (await call(hass, "get_config"))["config"]["scenes"][0]["entity_id"] == "scene.reading"


async def test_power_page_maps_the_keys(hass, panel) -> None:
    await call(hass, "seed", config={**HOUSE, "plugs": PLUGS3})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "power"})
    keys = {str(k): k for k in flow["data_schema"].schema if str(k).startswith("key_f")}
    assert [keys[f"key_f{i}"].default() for i in (1, 2, 3, 4)] == [
        "switch.plug_1",
        "switch.plug_2",
        "switch.plug_3",
        "all_off",
    ]
    options = [o["value"] for o in flow["data_schema"].schema[keys["key_f1"]].config["options"]]
    assert options == ["switch.plug_1", "switch.plug_2", "switch.plug_3", "all_off", "none"]
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "plugs": PLUGS3,
            "key_f1": "switch.plug_1",
            "key_f2": "switch.plug_3",
            "key_f3": "switch.plug_2",
            "key_f4": "none",
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["power_keys"] == ["switch.plug_1", "switch.plug_3", "switch.plug_2", "none"]
    assert [s.get("builtin") or s.get("entity_id") for s in cfg["scenes"]] == ["bright", "evening"]  # lights untouched


# ---------------------------------------------------------------- task 012: custom tabs + Hebrew name per row


def test_custom_tabs_config() -> None:
    import voluptuous as vol

    from custom_components.kindle_panel.config import normalize

    toggles = [{"entity_id": f"input_boolean.t{i}", "name": f"T{i}"} for i in (1, 2)]
    cfg = normalize(
        {
            "tabs": ["lights", "custom:garden", "custom:gone", "lights", "power"],
            "custom_tabs": {"garden": {"title": "Garden", "toggles": toggles}, "hidden": {"title": "Hidden"}},
        }
    )
    assert cfg["tabs"] == ["lights", "custom:garden", "power"]  # no duplicates, no tab without its block
    garden = cfg["custom_tabs"]["garden"]
    assert garden["icon"] == "star" and garden["toggles"][0]["icon"] == "plug"
    assert garden["keys"] == ["input_boolean.t1", "input_boolean.t2", "none", "all_off"]  # like the Power tab
    assert cfg["custom_tabs"]["hidden"]["keys"] == ["none", "none", "none", "all_off"]  # hidden, kept
    assert normalize(cfg) == cfg
    assert normalize({})["custom_tabs"] == {} and normalize({})["tabs"] == ["lights", "vacuum", "power", "media"]
    bad = [
        {"custom_tabs": {"Bad Id": {"title": "x"}}},
        {"custom_tabs": {"a": {"title": "x", "toggles": [{"entity_id": "sensor.t", "name": "t"}]}}},
        {"custom_tabs": {"a": {"title": "x", "toggles": [*toggles, *toggles, toggles[0]]}}},  # 5 > 4
        {"tabs": ["custom:a"], "custom_tabs": {}},  # no tab left
        {
            "tabs": ["lights", "vacuum", "power", "media", *[f"custom:c{i}" for i in range(3)]],
            "custom_tabs": {f"c{i}": {"title": "c"} for i in range(3)},
        },  # 7 > 6
    ]
    for b in bad:
        with pytest.raises(vol.Invalid):
            normalize(b)


async def test_custom_tab_pages(hass, panel) -> None:
    hass.states.async_set("script.water", "off", {"friendly_name": "Water"})
    await call(hass, "seed", config=HOUSE)
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "custom_tabs"})
    assert flow["step_id"] == "custom_tabs"
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {"custom_tabs": [{"id": "garden", "title": "Garden", "title_he": "גינה", "icon": "leaf"}], "edit": "garden"},
    )
    assert res["type"] is FlowResultType.FORM and res["step_id"] == "custom_tab"
    assert res["description_placeholders"]["title"] == "Garden"
    res = await hass.config_entries.options.async_configure(
        res["flow_id"],
        {
            "toggles": [
                {"entity_id": "input_boolean.pump", "name": "Pump", "name_he": "משאבה", "icon": "zap"},
                {"entity_id": "light.garden", "name": "Garden light", "icon": "bulb"},
            ]
        },
    )
    assert res["type"] is FlowResultType.FORM and res["step_id"] == "custom_tab_keys"
    keys = {str(k): k for k in res["data_schema"].schema if str(k).startswith("key_f")}
    assert [keys[f"key_f{i}"].default() for i in (1, 2, 3, 4)] == [
        "input_boolean.pump",
        "light.garden",
        "none",
        "all_off",
    ]
    offered = [o["value"] for o in res["data_schema"].schema[keys["key_f1"]].config["options"]]
    assert offered == ["input_boolean.pump", "light.garden", "all_off", "none", "script.water"]
    res = await hass.config_entries.options.async_configure(
        res["flow_id"],
        {
            "key_f1": "input_boolean.pump",
            "key_f2": "script.water",
            "key_f3": "all_off",
            "key_f4": "none",
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["tabs"] == ["lights", "vacuum", "power", "media", "custom:garden"]  # new tab added at the end
    g = cfg["custom_tabs"]["garden"]
    assert g["title"] == "Garden" and g["icon"] == "leaf"
    assert [t["entity_id"] for t in g["toggles"]] == ["input_boolean.pump", "light.garden"]
    assert g["keys"] == ["input_boolean.pump", "script.water", "all_off", "none"]
    assert cfg["names"]["he"]["Garden"] == "גינה" and cfg["names"]["he"]["Pump"] == "משאבה"
    assert "name_he" not in g["toggles"][0]

    # the tabs list hides it (setup kept) and offers it again
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "general"})
    tabs_field = next(k for k in flow["data_schema"].schema if str(k) == "tabs")
    options = flow["data_schema"].schema[tabs_field].config["fields"]["tab"]["selector"]["select"]["options"]
    assert {"value": "custom:garden", "label": "Custom: Garden"} in options
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"], {"language": "he", "tabs": [{"tab": "custom:garden"}, {"tab": "lights"}]}
    )
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["tabs"] == ["custom:garden", "lights"]
    assert cfg["names"]["he"]["Garden"] == "גינה"  # row names survive the General page's box
    assert cfg["names"]["he"]["Main light"] == "אור ראשי"

    # deleting the row deletes the tab and its tab-bar entry
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "custom_tabs"})
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {"custom_tabs": []})
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["custom_tabs"] == {} and cfg["tabs"] == ["lights"]


async def test_hebrew_name_per_row(hass, panel) -> None:
    await call(hass, "seed", config={**HOUSE, "names": {"he": {"Main light": "אור ראשי", "Living room": "סלון"}}})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "lights"})
    lights_field = next(k for k in flow["data_schema"].schema if str(k) == "lights")
    assert lights_field.description["suggested_value"][0]["name_he"] == "אור ראשי"
    row = {**HOUSE["lights"][0], "name_he": "מנורה"}
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "lights": [row],
            "scenes": [{"runs": "builtin:bright", "name": "Bright", "icon": "sun"}],
            "evening_light": "light.main_light",
            "evening_pct": 40,
            "warm_kelvin": 2200,
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["names"]["he"] == {"Main light": "מנורה", "Living room": "סלון"}
    assert "name_he" not in cfg["lights"][0]
    # General shows only the names without a row (a light's room label here)
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "general"})
    box = next(k for k in flow["data_schema"].schema if str(k) == "names_he")
    assert box.description["suggested_value"] == {"Living room": "סלון"}
