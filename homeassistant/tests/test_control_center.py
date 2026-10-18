"""The panel's control center: config seeding, options pages, screensaver photos with keep/skip."""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest
import voluptuous as vol
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
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


TV_NODE = {"id": "tv", "type": "tv", "name": "Sony TV", "entity": "media_player.tv", "movie_on": "script.movie_mode"}


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

    cfg = normalize({"plugs": PLUGS3, "media": {"nodes": [TV_NODE]}})
    assert cfg["scenes"] == [
        {"entity_id": "scene.bright", "name": "Bright", "icon": "sun"},
        {"entity_id": "scene.evening", "name": "Evening", "icon": "moon"},
        {"entity_id": "script.movie_mode", "name": "Movie", "icon": "film"},
    ]
    assert cfg["power_keys"] == ["switch.plug_1", "switch.plug_2", "switch.plug_3", "all_off"]
    # fewer plugs, no movie script: the gaps stay empty, F4 is still "all off"
    one = normalize({"plugs": PLUGS3[:1]})
    assert [s["entity_id"] for s in one["scenes"]] == ["scene.bright", "scene.evening"]
    assert one["power_keys"] == ["switch.plug_1", "none", "none", "all_off"]
    # saved values are kept as saved; an empty scene list stays empty; short key lists are padded
    kept = normalize({"plugs": PLUGS3, "scenes": [], "power_keys": ["all_off"]})
    assert kept["scenes"] == [] and kept["power_keys"] == ["all_off", "none", "none", "none"]
    assert normalize(kept) == kept  # stable


@pytest.mark.parametrize(
    "scenes",
    [
        [{"name": "Nothing to run"}],
        [{"entity_id": "light.main_light", "name": "Not a scene"}],
        [{"builtin": "disco", "name": "Unknown built-in"}],
        [{"entity_id": "scene.a", "name": "Extra", "colour": "red"}],
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
    await call(hass, "seed", config={**HOUSE, "media": {"nodes": [TV_NODE]}})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "lights"})
    schema = {str(k): v for k, v in flow["data_schema"].schema.items()}
    fields = schema["scenes"].config["fields"]
    offered = [o["value"] for o in fields["runs"]["selector"]["select"]["options"]]
    assert offered == ["scene.reading", "script.movie_mode", "scene.bright", "scene.evening"]  # configured stay listed
    current = next(k for k in flow["data_schema"].schema if str(k) == "scenes").description["suggested_value"]
    assert [r["runs"] for r in current] == ["scene.bright", "scene.evening", "script.movie_mode"]

    rows = [
        {"runs": "scene.reading", "name": "Reading", "icon": "book"},
        {"runs": "script.movie_mode", "name": "Movie", "icon": "film"},
    ]
    base = {"lights": HOUSE["lights"]}
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {**base, "scenes": rows})
    assert res["type"] is FlowResultType.CREATE_ENTRY
    cfg = (await call(hass, "get_config"))["config"]
    assert cfg["scenes"] == [
        {"entity_id": "scene.reading", "name": "Reading", "icon": "book"},
        {"entity_id": "script.movie_mode", "name": "Movie", "icon": "film"},
    ]
    assert "evening" not in cfg
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
    assert [s["entity_id"] for s in cfg["scenes"]] == ["scene.bright", "scene.evening"]  # lights untouched


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
    # bus task 020: no icon stored (auto: the entity's HA icon, else the default the app applies at draw time)
    assert "icon" not in garden and "icon" not in garden["toggles"][0]
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
    assert "Garden" not in cfg["names"]["he"] and "Pump" not in cfg["names"]["he"]  # its Hebrew names went too
    assert cfg["names"]["he"]["Main light"] == "אור ראשי"


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
            "scenes": [{"runs": "scene.bright", "name": "Bright", "icon": "sun"}],
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


def test_configs_with_built_in_scenes_still_load() -> None:
    """kindle_panel <= 0.3.0 saved built-in Bright / Evening rows and an `evening` block (task 013)."""
    from custom_components.kindle_panel.config import normalize

    old = {
        "scenes": [
            {"builtin": "bright", "name": "Bright", "icon": "sun"},
            {"builtin": "evening", "name": "Evening", "icon": "moon"},
            {"entity_id": "script.movie_mode", "name": "Movie", "icon": "film"},
        ],
        "evening": {"entity_id": "light.main_light", "brightness_pct": 40, "warm_kelvin": 2200},
    }
    cfg = normalize(old)
    assert [s["entity_id"] for s in cfg["scenes"]] == ["scene.bright", "scene.evening", "script.movie_mode"]
    assert "evening" not in cfg and "builtin" not in cfg["scenes"][0]
    assert old["scenes"][0] == {"builtin": "bright", "name": "Bright", "icon": "sun"}  # input untouched


# ---- bus task 014: Media tab = typed device nodes, music output picked on the panel ----
OWNER_V1_MEDIA = {
    "music_backend": "ha",
    "amp_player": "media_player.r_n500_main",
    "amp_volume": "number.r_n500_main_volume_db",
    "dlna_player": "media_player.yamaha_r_n500",
    "amp_plug": "switch.media_plug",
    "amp_plug_power": "sensor.media_plug_power",
    "tv": "media_player.bravia",
    "movie_on": "script.movie_mode",
    "movie_off": "script.movie_mode_off",
    "movie_active": "input_boolean.movie_mode_active",
    "ynca_entry_id": "01M0ZMQXMTWAAW7BXTBCXD1YZR",
}


def test_version_1_media_becomes_two_nodes() -> None:
    from custom_components.kindle_panel.config import normalize

    old = {"version": 1, "plugs": PLUGS3, "media": dict(OWNER_V1_MEDIA)}
    cfg = normalize(old)
    assert cfg["version"] == 2
    m = cfg["media"]
    assert m["music_backend"] == "ha"
    assert m["nodes"] == [
        {
            "id": "amp",
            "type": "receiver",
            "name": "Yamaha R-N500",
            "power_device": "media_player.r_n500",
            "volume": "number.r_n500_main_volume_db",
            "plug": "switch.media_plug",
            "plug_power": "sensor.media_plug_power",
            "stream_output": "select.r_n500_stream_output",
            "players": ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
            "dlna_player": "media_player.yamaha_r_n500",
            "ynca_entry_id": "01M0ZMQXMTWAAW7BXTBCXD1YZR",
        },
        {
            "id": "tv",
            "type": "tv",
            "name": "Sony TV",
            "entity": "media_player.bravia",
            "movie_on": "script.movie_mode",
            "movie_off": "script.movie_mode_off",
            "movie_active": "input_boolean.movie_mode_active",
        },
    ]
    assert m["keys"] == ["music", "amp", "tv", "none"]
    assert m["output_keys"] == ["media_player.ma_amp_dlna", "none", "none", "none"]
    assert "amp_player" not in m and old["media"]["amp_player"]  # input untouched
    assert [s["entity_id"] for s in cfg["scenes"]][-1] == "script.movie_mode"  # Movie scene still found
    assert normalize(cfg) == cfg  # stable
    # the app backend keeps the amp's own player as its power device, no MA players
    app = normalize({"media": {**OWNER_V1_MEDIA, "music_backend": "app"}})["media"]
    assert app["nodes"][0]["power_device"] == "media_player.r_n500_main" and "players" not in app["nodes"][0]
    fresh = normalize({})
    assert fresh["media"]["nodes"] == [] and fresh["media"]["keys"] == ["music", "none", "none", "none"]


@pytest.mark.parametrize(
    "media",
    [
        {"nodes": [{"id": "a", "type": "projector", "name": "P", "entity": "media_player.p"}]},
        {"nodes": [{"id": "a", "type": "receiver", "name": "No device"}]},
        {"nodes": [{"id": "a", "type": "tv", "name": "T", "entity": "switch.tv"}]},
        {"nodes": [{"id": "Bad Id", "type": "tv", "name": "T", "entity": "media_player.tv"}]},
        {"nodes": [TV_NODE, TV_NODE]},
        {"nodes": [TV_NODE], "keys": ["music", "kitchen"]},
        {"nodes": [TV_NODE], "keys": ["light.x"]},
        {"output_keys": ["switch.x"]},
    ],
)
def test_bad_media_nodes_and_keys_are_refused(media) -> None:
    import voluptuous as vol

    from custom_components.kindle_panel.config import normalize

    with pytest.raises(vol.Invalid):
        normalize({"media": media})


def _ma_player(hass, entity_id: str, name: str) -> None:
    from homeassistant.helpers import entity_registry as er

    reg = er.async_get(hass)
    reg.async_get_or_create("media_player", "music_assistant", entity_id, suggested_object_id=entity_id.split(".")[1])
    hass.states.async_set(entity_id, "idle", {"friendly_name": name})


async def test_music_output_is_stored_per_panel(hass, panel) -> None:
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500")
    _ma_player(hass, "media_player.ma_kitchen", "Kitchen")
    await call(hass, "seed", config=HOUSE)
    r = await call(hass, "get_config")
    assert r["music_output"] is None and r["music_output_valid"] is False  # not chosen: the panel opens its picker
    assert [o["entity_id"] for o in r["outputs"]] == ["media_player.ma_amp_dlna", "media_player.ma_kitchen"]
    assert r["outputs"][1]["name"] == "Kitchen"
    # no receiver lists MA players: the picker's F1 is HA's first MA player
    assert r["config"]["media"]["output_keys"] == ["media_player.ma_amp_dlna", "none", "none", "none"]
    assert await call(hass, "set_output", entity_id="media_player.ma_kitchen") == {
        "music_output": "media_player.ma_kitchen"
    }
    r = await call(hass, "get_config")
    assert r["music_output"] == "media_player.ma_kitchen" and r["music_output_valid"] is True
    from homeassistant.exceptions import ServiceValidationError

    with pytest.raises(ServiceValidationError):
        await call(hass, "set_output", entity_id="media_player.tv")  # not a Music Assistant player
    # the player disappears from HA: still stored, but not valid any more (the panel asks again)
    from homeassistant.helpers import entity_registry as er

    er.async_get(hass).async_remove("media_player.ma_kitchen")
    r = await call(hass, "get_config")
    assert r["music_output"] == "media_player.ma_kitchen" and r["music_output_valid"] is False


async def test_upgraded_owner_panel_starts_on_the_amp(hass: HomeAssistant) -> None:
    """A v1 config with music through HA: after the upgrade the panel's output is the amp's DLNA player."""
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    entry = MockConfigEntry(
        domain=DOMAIN, data={}, options={"config": {**HOUSE, "version": 1, "media": OWNER_V1_MEDIA}, "seeded": True}
    )
    entry.add_to_hass(hass)
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500")
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    r = await call(hass, "get_config")
    assert r["music_output"] == "media_player.ma_amp_dlna" and r["music_output_valid"] is True
    assert [n["id"] for n in r["config"]["media"]["nodes"]] == ["amp", "tv"]


async def test_media_page_edits_nodes_and_keys(hass, panel) -> None:
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500")
    hass.states.async_set("script.movie_mode", "off", {"friendly_name": "Movie mode"})
    await call(
        hass,
        "seed",
        config={
            **HOUSE,
            "media": {"music_backend": "ha", **{k: v for k, v in OWNER_V1_MEDIA.items() if k != "music_backend"}},
        },
    )
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    schema = {str(k): k for k in flow["data_schema"].schema}
    assert list(schema)[:2] == ["music_backend", "nodes"]
    rows = schema["nodes"].description["suggested_value"]
    assert rows[0]["entity"] == "media_player.r_n500" and rows[1]["entity"] == "media_player.bravia"
    keys = {str(k): v for k, v in flow["data_schema"].schema.items()}
    offered = [o["value"] for o in keys["key_f1"].config["options"]]
    assert offered[:5] == ["music", "amp", "tv", "all_off", "none"] and "script.movie_mode" in offered
    # output picker keys: an MA player (picks it) or a script (runs it; bus task 015)
    assert [o["value"] for o in keys["out_f1"].config["options"]] == [
        "none",
        "media_player.ma_amp_dlna",
        "script.movie_mode",
    ]
    # rename the TV (with a Hebrew name), drop the amp, swap the keys
    tv = {**rows[1], "name": "Projector", "name_he": "מקרן", "volume": "number.ignored_for_a_tv"}
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "music_backend": "ha",
            "nodes": [tv],
            "key_f1": "tv",
            "key_f2": "script.movie_mode",
            "key_f3": "none",
            "key_f4": "music",
            "out_f1": "none",
            "out_f2": "media_player.ma_amp_dlna",
            "out_f3": "none",
            "out_f4": "none",
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    m = (await call(hass, "get_config"))["config"]["media"]
    assert m["nodes"] == [
        {
            "id": "tv",
            "type": "tv",
            "name": "Projector",
            "entity": "media_player.bravia",
            "movie_on": "script.movie_mode",
            "movie_off": "script.movie_mode_off",
            "movie_active": "input_boolean.movie_mode_active",
        }
    ]
    assert m["keys"] == ["tv", "script.movie_mode", "none", "music"]
    assert m["output_keys"] == ["none", "media_player.ma_amp_dlna", "none", "none"]
    assert (await call(hass, "get_config"))["config"]["names"]["he"]["Projector"] == "מקרן"
    # a key naming a node that is gone is refused with the reason
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "music_backend": "ha",
            "nodes": [],
            "key_f1": "tv",
            "key_f2": "none",
            "key_f3": "none",
            "key_f4": "none",
            "out_f1": "none",
            "out_f2": "none",
            "out_f3": "none",
            "out_f4": "none",
        },
    )
    assert res["type"] is FlowResultType.FORM and "names no node" in res["description_placeholders"]["error"]


RX_NODE = {"id": "amp", "type": "receiver", "name": "Yamaha R-N500", "power_device": "media_player.r_n500"}
RX_SOURCES = ["Spotify", "NET RADIO", "SERVER", "AirPlay", "PHONO", "CD", "LINE1", "LINE3"]


def test_node_inputs_and_script_output_keys() -> None:
    """Bus task 015: input rows rename / hide entries of the device's source_list; picker keys may be scripts."""
    import voluptuous as vol

    from custom_components.kindle_panel.config import normalize

    rows = [
        {"input": "CD", "name": "Bluetooth & TV", "name_he": "בלוטות׳ וטלוויזיה"},
        {"input": "LINE3", "hidden": True},
        {"input": "PHONO", "name": "", "name_he": None, "hidden": False},  # changes nothing: dropped
    ]
    cfg = normalize(
        {"media": {"nodes": [{**RX_NODE, "inputs": rows}], "output_keys": ["script.amp_dlna", "media_player.x"]}}
    )
    m = cfg["media"]
    assert m["nodes"][0]["inputs"] == [
        {"input": "CD", "name": "Bluetooth & TV", "name_he": "בלוטות׳ וטלוויזיה"},
        {"input": "LINE3", "hidden": True},
    ]
    assert m["output_keys"] == ["script.amp_dlna", "media_player.x", "none", "none"]
    assert normalize(cfg) == cfg
    # a TV node takes input rows too
    tv = normalize({"media": {"nodes": [{**TV_NODE, "inputs": [{"input": "HDMI 1", "name": "Console"}]}]}})
    assert tv["media"]["nodes"][0]["inputs"] == [{"input": "HDMI 1", "name": "Console"}]
    for bad in (
        [{"input": "CD", "name": "A"}, {"input": "CD", "hidden": True}],  # one input, two rows
        [{"name": "no input"}],
    ):
        with pytest.raises(vol.Invalid):
            normalize({"media": {"nodes": [{**RX_NODE, "inputs": bad}]}})
    with pytest.raises(vol.Invalid):
        normalize({"media": {"output_keys": ["light.x"]}})


async def test_media_inputs_page(hass, panel) -> None:
    hass.states.async_set("media_player.r_n500", "off", {"source_list": RX_SOURCES})
    await call(hass, "seed", config={**HOUSE, "media": {"music_backend": "ha", "nodes": [RX_NODE]}})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    keys = {str(k): v for k, v in flow["data_schema"].schema.items()}
    assert [o["value"] for o in keys["inputs_for"].config["options"]] == ["amp"]
    rows = {str(k): k for k in flow["data_schema"].schema}["nodes"].description["suggested_value"]
    page = {"music_backend": "ha", "nodes": rows, **{f"key_f{i}": "none" for i in range(1, 5)}}
    page |= {f"out_f{i}": "none" for i in range(1, 5)}
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {**page, "inputs_for": "amp"})
    assert res["type"] is FlowResultType.FORM and res["step_id"] == "media_inputs"
    assert res["description_placeholders"]["name"] == "Yamaha R-N500"
    schema = {str(k): k for k in res["data_schema"].schema}
    # every input of the receiver, live and in its own order
    assert [r["input"] for r in schema["inputs"].description["suggested_value"]] == RX_SOURCES
    edited = [
        {"input": "CD", "name": "Bluetooth & TV", "name_he": "בלוטות׳ וטלוויזיה"},
        {"input": "LINE3", "hidden": True},
        {"input": "SERVER"},
    ]
    res = await hass.config_entries.options.async_configure(res["flow_id"], {"inputs": edited})
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    node = (await call(hass, "get_config"))["config"]["media"]["nodes"][0]
    assert node["inputs"] == edited[:2]
    # the node editor does not show the rows, and saving it keeps them
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    rows = {str(k): k for k in flow["data_schema"].schema}["nodes"].description["suggested_value"]
    assert "inputs" not in rows[0]
    res = await hass.config_entries.options.async_configure(flow["flow_id"], {**page, "nodes": rows})
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert (await call(hass, "get_config"))["config"]["media"]["nodes"][0]["inputs"] == edited[:2]
    # the inputs page again: saved rows filled in, an input the receiver no longer lists is kept at the end
    hass.states.async_set("media_player.r_n500", "off", {"source_list": ["SERVER", "CD"]})
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"], {**page, "nodes": rows, "inputs_for": "amp"}
    )
    shown = {str(k): k for k in res["data_schema"].schema}["inputs"].description["suggested_value"]
    assert shown == [
        {"input": "SERVER", "icon": "auto"},
        {"input": "CD", "name": "Bluetooth & TV", "name_he": "בלוטות׳ וטלוויזיה", "icon": "auto"},
        {"input": "LINE3", "hidden": True, "icon": "auto"},
    ]


async def test_receiver_node_finds_the_net_radio_select(hass, panel) -> None:
    """0.6.0: a receiver node without `net_radio` gets yamaha_netbridge's station select from its device."""
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    from custom_components.kindle_panel.config import normalize

    other = MockConfigEntry(domain="yamaha_netbridge", data={})
    other.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id, identifiers={("yamaha_netbridge", "X")}
    )
    reg = er.async_get(hass)
    reg.async_get_or_create(
        "media_player", "yamaha_netbridge", "X_media_player", suggested_object_id="r_n500", device_id=dev.id
    )
    reg.async_get_or_create(
        "select", "yamaha_netbridge", "X_stream_output", suggested_object_id="r_n500_stream_output", device_id=dev.id
    )
    reg.async_get_or_create(
        "select",
        "yamaha_netbridge",
        "X_net_radio_station",
        suggested_object_id="r_n500_net_radio_station",
        device_id=dev.id,
    )
    media = {
        "music_backend": "ha",
        "nodes": [
            {"id": "amp", "type": "receiver", "name": "Amp", "power_device": "media_player.r_n500"},
            {"id": "amp2", "type": "receiver", "name": "Other", "power_device": "media_player.nope"},
        ],
    }
    await call(hass, "seed", config={**HOUSE, "media": media})
    nodes = (await call(hass, "get_config"))["config"]["media"]["nodes"]
    assert nodes[0]["net_radio"] == "select.r_n500_net_radio_station"
    assert "net_radio" not in nodes[1]  # no device, nothing guessed
    # an explicit select wins and is a valid node field
    assert (
        normalize({**HOUSE, "media": {**media, "nodes": [{**media["nodes"][0], "net_radio": "select.x"}]}})["media"][
            "nodes"
        ][0]["net_radio"]
        == "select.x"
    )


# ---- bus task 019: one icon pack for every icon field


def test_icon_pack_equals_the_app_json() -> None:
    """kindle_panel's ICONS is the app's src/data/icons.json (names), sorted; every name used before is still there."""
    import json
    from pathlib import Path

    from custom_components.kindle_panel.const import ICON_AUTO, ICONS

    pack = json.loads((Path(__file__).parents[2] / "src" / "data" / "icons.json").read_text())
    assert ICONS == sorted(pack)
    assert 60 <= len(ICONS) <= 80
    before = {
        *("lamp_ceiling", "spot", "strip", "lamp", "bulb"),
        *("shower", "baby", "door", "utensils", "home", "bath", "bed", "sofa", "room"),
        *("sun", "moon", "film", "book", "star", "sparkles", "power"),
        *("plug", "fan", "tv", "zap", "leaf"),
        *("thermometer", "droplets", "gauge", "wind", "battery"),
    }
    assert before <= set(ICONS)
    # the app's row defaults (src/lib/icons.ts ICON_DEFAULTS) are pack names; "auto" is not one
    assert {"bulb", "room", "star", "plug", "gauge", "speaker", "tv"} <= set(ICONS)
    assert ICON_AUTO not in ICONS


def test_icon_fields_take_the_whole_pack_and_auto_is_stored_as_no_icon() -> None:
    import voluptuous as vol

    from custom_components.kindle_panel.config import normalize

    rx = {**RX_NODE, "inputs": [{"input": "CD", "icon": "bluetooth"}, {"input": "PHONO", "name": "Records"}]}
    cfg = normalize(
        {
            **HOUSE,
            "vacuum": {"rooms": [{"entity_id": "input_boolean.robo_grid_5", "name": "Guest toilet", "icon": "toilet"}]},
            "lights": [{"entity_id": "light.desk", "name": "Desk", "icon": "lamp_desk"}],
            "scenes": [{"entity_id": "scene.coffee", "name": "Coffee", "icon": "coffee"}],
            "media": {"nodes": [rx, TV_NODE | {"entity": "media_player.tv", "icon": "monitor"}]},
            "screensaver": {"cards": [{"type": "sensor", "entity_id": "sensor.boiler", "icon": "water_heater"}]},
        }
    )
    assert cfg["vacuum"]["rooms"][0]["icon"] == "toilet"
    assert cfg["lights"][0]["icon"] == "lamp_desk" and cfg["scenes"][0]["icon"] == "coffee"
    assert cfg["screensaver"]["cards"][0]["icon"] == "water_heater"
    # bus task 020: no pack default is filled in (the app applies it at draw time, after the entity's own HA icon)
    assert "icon" not in cfg["plugs"][0]
    amp, tv = cfg["media"]["nodes"]
    assert "icon" not in amp and tv["icon"] == "monitor"
    # an input row may carry only an icon (kept); no icon = none (nothing added)
    assert amp["inputs"] == [{"input": "CD", "icon": "bluetooth"}, {"input": "PHONO", "name": "Records"}]
    assert normalize(cfg) == cfg  # stable
    old = normalize({**HOUSE, "media": {"nodes": [RX_NODE, TV_NODE]}})
    assert ["icon" in n for n in old["media"]["nodes"]] == [False, False]
    assert old["vacuum"]["rooms"][0]["icon"] == "shower"
    # stored values are left alone, even ones equal to the old seeded defaults (indistinguishable from a choice)
    kept = normalize({**HOUSE, "plugs": [{**HOUSE["plugs"][0], "icon": "plug"}]})
    assert kept["plugs"][0]["icon"] == "plug"
    # "auto" and an empty field are accepted everywhere and stored as no icon
    auto = normalize(
        {
            **HOUSE,
            "lights": [{"entity_id": "light.desk", "name": "Desk", "icon": "auto"}],
            "scenes": [{"entity_id": "scene.coffee", "name": "Coffee", "icon": ""}],
            "plugs": [{"entity_id": "switch.x", "name": "X", "icon": "auto"}],
            "custom_tabs": {
                "g": {"title": "G", "icon": "auto", "toggles": [{"entity_id": "fan.x", "name": "F", "icon": "auto"}]}
            },
            "media": {"nodes": [{**RX_NODE, "icon": "auto", "inputs": [{"input": "CD", "icon": "auto"}]}]},
            "screensaver": {"cards": [{"type": "sensor", "entity_id": "sensor.boiler", "icon": "auto"}]},
        }
    )
    rows = [
        auto["lights"][0],
        auto["scenes"][0],
        auto["plugs"][0],
        auto["custom_tabs"]["g"],
        auto["custom_tabs"]["g"]["toggles"][0],
        auto["media"]["nodes"][0],
        auto["screensaver"]["cards"][0],
    ]
    assert all("icon" not in r for r in rows)
    assert "inputs" not in auto["media"]["nodes"][0]  # an input row with only "auto" changes nothing: dropped
    for bad in (
        {"plugs": [{"entity_id": "switch.x", "name": "X", "icon": "nope"}]},
        {"lights": [{"entity_id": "light.x", "name": "X", "icon": "nope"}]},
        {"media": {"nodes": [{**TV_NODE, "icon": "nope"}]}},
        {"media": {"nodes": [{**RX_NODE, "inputs": [{"input": "CD", "icon": "nope"}]}]}},
    ):
        with pytest.raises(vol.Invalid):
            normalize(bad)


async def test_every_icon_column_offers_the_whole_pack(hass, panel) -> None:
    from custom_components.kindle_panel.const import ICON_AUTO, ICON_AUTO_LABEL, ICONS

    offered = [{"value": ICON_AUTO, "label": ICON_AUTO_LABEL}, *({"value": n, "label": n} for n in ICONS)]
    shown = {
        ("lights", "lights", "lamp_ceiling"),
        ("lights", "scenes", "sun"),  # the seeded scene buttons keep their seeded icons
        ("vacuum", "rooms", "shower"),
        ("power", "plugs", ICON_AUTO),
        ("custom_tabs", "custom_tabs", ICON_AUTO),
        ("media", "nodes", ICON_AUTO),
        ("screensaver", "cards", ICON_AUTO),
    }
    hass.states.async_set("media_player.r_n500", "off", {"source_list": ["CD", "PHONO"]})
    await call(
        hass,
        "seed",
        config={
            **HOUSE,
            "custom_tabs": {"g": {"title": "G"}},
            "media": {"music_backend": "ha", "nodes": [RX_NODE, TV_NODE]},
        },
    )
    pages = {
        "lights": ["lights", "scenes"],
        "vacuum": ["rooms"],
        "power": ["plugs"],
        "custom_tabs": ["custom_tabs"],
        "media": ["nodes"],
        "screensaver": ["cards"],
    }
    seen = 0
    for page, lists in pages.items():
        flow = await hass.config_entries.options.async_init(panel.entry_id)
        flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": page})
        schema = {str(k): v for k, v in flow["data_schema"].schema.items()}
        for name in lists:
            fields = schema[name].config["fields"]
            sel = fields["icon"]["selector"]["select"]
            assert sel["options"] == offered and sel["mode"] == "dropdown" and sel["custom_value"] is False, (
                page,
                name,
            )
            assert sel["sort"] is False  # auto stays first
            # rows without an icon of their own show "auto"
            rows = {str(k): k for k in flow["data_schema"].schema}[name].description["suggested_value"]
            assert all(r["icon"] for r in rows) and (page, name, rows[0]["icon"]) in shown, (page, name, rows[0])
            seen += 1
        hass.config_entries.options.async_abort(flow["flow_id"])
    assert seen == 7
    # the inputs page of the receiver
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    nodes = {str(k): k for k in flow["data_schema"].schema}["nodes"].description["suggested_value"]
    flow = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "music_backend": "ha",
            "nodes": nodes,
            **{f"key_f{i}": "none" for i in range(1, 5)},
            **{f"out_f{i}": "none" for i in range(1, 5)},
            "inputs_for": "amp",
        },
    )
    assert flow["step_id"] == "media_inputs"
    fields = {str(k): v for k, v in flow["data_schema"].schema.items()}["inputs"].config["fields"]
    assert fields["icon"]["selector"]["select"]["options"] == offered
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"], {"inputs": [{"input": "CD", "icon": "bluetooth"}, {"input": "PHONO", "icon": ICON_AUTO}]}
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    amp = (await call(hass, "get_config"))["config"]["media"]["nodes"][0]
    assert amp["inputs"] == [{"input": "CD", "icon": "bluetooth"}] and "icon" not in amp


async def test_rooms_round_trip_keeps_rows_identical(hass, panel) -> None:
    """Re-submitting the Vacuum page with its suggested rows changes nothing (the field check of task 019)."""
    await call(hass, "seed", config=HOUSE)
    before = (await call(hass, "get_config"))["config"]
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "vacuum"})
    schema = {str(k): k for k in flow["data_schema"].schema}
    rows = schema["rooms"].description["suggested_value"]
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"], {"entity_id": before["vacuum"]["entity_id"], "rooms": rows}
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    after = (await call(hass, "get_config"))["config"]
    assert after["vacuum"]["rooms"] == before["vacuum"]["rooms"] and after["names"] == before["names"]


async def test_auto_rows_round_trip_unchanged(hass, panel) -> None:
    """Bus task 020: rows without an icon show "auto"; re-submitting the Power and Media pages with their suggested rows
    stores nothing new (auto = no icon), and a stored explicit icon stays."""
    await call(
        hass,
        "seed",
        config={
            **HOUSE,
            "plugs": [{**HOUSE["plugs"][0], "icon": "plug"}, {"entity_id": "switch.lamp", "name": "Lamp"}],
            "media": {"music_backend": "ha", "nodes": [RX_NODE, TV_NODE], "keys": ["tv", "amp", "none", "music"]},
        },
    )
    before = (await call(hass, "get_config"))["config"]
    for page in ("power", "media"):
        flow = await hass.config_entries.options.async_init(panel.entry_id)
        flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": page})
        sugg = {str(k): k.description["suggested_value"] for k in flow["data_schema"].schema if k.description}
        dflt = {str(k): k.default() for k in flow["data_schema"].schema if not isinstance(k.default, vol.Undefined)}
        if page == "power":
            assert [r["icon"] for r in sugg["plugs"]] == ["plug", "auto"]
        else:
            assert [r["icon"] for r in sugg["nodes"]] == ["auto", "auto"]
        res = await hass.config_entries.options.async_configure(flow["flow_id"], {**dflt, **sugg})
        assert res["type"] is FlowResultType.CREATE_ENTRY, res
        await hass.async_block_till_done()
    after = (await call(hass, "get_config"))["config"]
    assert after == before


# ---------------------------------------------------------------- bus task 021: picker = MA's players, move, art


class _FakePlayers:
    def __init__(self, players):
        self._p = {p.player_id: p for p in players}

    def get(self, pid):
        return self._p.get(pid)

    def __iter__(self):
        return iter(self._p.values())


def _mp(pid, name, *, type_="player", state="idle", members=(), title=None, artist=None, hidden=False, enabled=True):
    return SimpleNamespace(
        player_id=pid,
        name=name,
        display_name=name,
        type=SimpleNamespace(value=type_),
        playback_state=SimpleNamespace(value=state),
        available=True,
        enabled=enabled,
        hide_in_ui=hidden,
        group_members=list(members),
        static_group_members=list(members) if type_ == "group" else [],
        current_media=SimpleNamespace(title=title, artist=artist) if title else None,
    )


async def test_picker_lists_ma_players_groups_and_unexposed(hass, panel, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    _ma_player(hass, "media_player.ma_amp_airplay", "R-N500 AirPlay")
    _ma_player(hass, "media_player.ma_house", "Whole house")
    hass.states.async_set(
        "media_player.ma_amp_airplay",
        "playing",
        {"friendly_name": "R-N500 AirPlay", "media_title": "Holiday", "media_artist": "Scorpions"},
    )
    mass = SimpleNamespace(
        players=_FakePlayers(
            [
                _mp("media_player.ma_amp_dlna", "R-N500 DLNA"),
                _mp("media_player.ma_amp_airplay", "R-N500 AirPlay", state="playing", title="Holiday"),
                _mp("media_player.ma_house", "Whole house", type_="group", members=["a", "b"]),
                _mp("updcd23cf6", "TV"),
                _mp("pixel", "Pixel phone", hidden=True, title="Song", artist="Band", state="playing"),
                _mp("disp", "Kitchen display", type_="display"),
                _mp("off", "Old speaker", enabled=False),
            ]
        )
    )
    monkeypatch.setattr(kp, "_mass_client", lambda hass: mass)
    await call(hass, "seed", config={**HOUSE, "media": {"show_unavailable_outputs": True}})
    r = await call(hass, "get_config")
    rows = {o["entity_id"]: o for o in r["outputs"]}
    assert rows["media_player.ma_amp_airplay"]["now"] == "Holiday · Scorpions"
    assert rows["media_player.ma_amp_airplay"]["state"] == "playing"
    assert rows["media_player.ma_amp_dlna"]["now"] is None and rows["media_player.ma_amp_dlna"]["kind"] == "player"
    assert rows["media_player.ma_house"]["kind"] == "group" and rows["media_player.ma_house"]["members"] == ["a", "b"]
    un = r["outputs_unexposed"]
    # no display, no disabled player; bus task 023: no player MA hides (Pixel phone), not even for debugging
    assert [u["name"] for u in un] == ["TV"]
    assert un[0] == {
        "player_id": "updcd23cf6",
        "name": "TV",
        "state": "idle",
        "now": None,
        "kind": "player",
        "hidden_in_ma": False,
    }


async def test_picker_without_music_assistant_loaded(hass, panel) -> None:
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    await call(hass, "seed", config=HOUSE)
    r = await call(hass, "get_config")
    assert r["outputs"][0]["kind"] == "player" and r["outputs_unexposed"] == []


async def test_move_queue_transfers_and_switches_the_output(hass, panel, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    _ma_player(hass, "media_player.ma_amp_airplay", "R-N500 AirPlay")
    moved = []

    class Queues:
        async def get_active_queue(self, pid):
            return SimpleNamespace(queue_id=f"q-{pid}", items=26 if pid == "media_player.ma_amp_airplay" else 0)

        async def transfer_queue(self, src, dst, auto_play):
            moved.append((src, dst, auto_play))

    mass = SimpleNamespace(player_queues=Queues())
    monkeypatch.setattr(kp, "_mass_and_player", lambda hass, entry, eid: (mass, eid))
    await call(hass, "seed", config=HOUSE)
    await call(hass, "set_output", entity_id="media_player.ma_amp_airplay")
    r = await call(hass, "move_queue", entity_id="media_player.ma_amp_dlna")
    assert moved == [("q-media_player.ma_amp_airplay", "media_player.ma_amp_dlna", True)]
    assert r == {
        "ok": True,
        "music_output": "media_player.ma_amp_dlna",
        "moved_from": "media_player.ma_amp_airplay",
        "items": 26,
    }
    assert (await call(hass, "get_config"))["music_output"] == "media_player.ma_amp_dlna"
    # nothing to move from the (now idle, empty) DLNA queue; same player refused
    with pytest.raises(ServiceValidationError):
        await call(hass, "move_queue", entity_id="media_player.ma_amp_airplay")
    with pytest.raises(ServiceValidationError):
        await call(hass, "move_queue", entity_id="media_player.ma_amp_dlna")
    assert len(moved) == 1


def test_ma_image_only_from_the_ma_server() -> None:
    from yarl import URL

    from custom_components.kindle_panel import ma_image_allowed

    ma = ["http://192.168.1.15:8095"]
    assert ma_image_allowed(URL("http://192.168.1.15:8095/imageproxy/abc?size=0"), ma)
    assert not ma_image_allowed(URL("http://192.168.1.15:8095/api/players"), ma)
    assert not ma_image_allowed(URL("http://192.168.1.15:8123/imageproxy/abc"), ma)
    assert not ma_image_allowed(URL("http://evil.example/imageproxy/abc"), ma)
    assert not ma_image_allowed(URL("file:///etc/passwd"), ma)
    assert not ma_image_allowed(URL("http://192.168.1.15:8095/imageproxy/x"), [])


async def test_ma_image_view_needs_auth_and_proxies(
    hass, panel, hass_client, hass_client_no_auth, aioclient_mock
) -> None:
    entry = MockConfigEntry(domain="music_assistant", data={"url": "http://192.168.1.15:8095"})
    entry.add_to_hass(hass)
    entry.mock_state(hass, ConfigEntryState.LOADED)
    img = "http://192.168.1.15:8095/imageproxy/abc?size=0"
    aioclient_mock.get(img, content=b"\xff\xd8\xffjpeg", headers={"Content-Type": "image/jpeg"})
    anon = await hass_client_no_auth()
    assert (await anon.get("/api/kindle_panel/ma_image", params={"url": img})).status == 401
    client = await hass_client()
    r = await client.get("/api/kindle_panel/ma_image", params={"url": img})
    assert r.status == 200 and r.content_type == "image/jpeg" and await r.read() == b"\xff\xd8\xffjpeg"
    bad = await client.get("/api/kindle_panel/ma_image", params={"url": "http://192.168.1.15:8123/api/states"})
    assert bad.status == 403
    entry.mock_state(hass, ConfigEntryState.NOT_LOADED)  # no real music_assistant unload at teardown


# ---------------------------------------------------------------- bus task 022: hide unavailable, sync, safe move


def _sp(pid, name, *, can=(), members=(), synced_to=None, available=True, state="idle"):
    p = _mp(pid, name, state=state)
    p.can_group_with = list(can)
    p.group_members = list(members)
    p.synced_to = synced_to
    p.available = available
    return p


async def test_picker_hides_unavailable_and_unexposed_by_default(hass, panel, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    _ma_player(hass, "media_player.ma_gone", "Gone speaker")
    hass.states.async_set("media_player.ma_gone", "unavailable", {"friendly_name": "Gone speaker"})
    mass = SimpleNamespace(
        players=_FakePlayers(
            [
                _sp("media_player.ma_amp_dlna", "R-N500 DLNA"),
                _sp("media_player.ma_gone", "Gone speaker", available=False),
                _sp("web1", "Web (Chrome on Android)", available=False),
            ]
        )
    )
    monkeypatch.setattr(kp, "_mass_client", lambda hass: mass)
    await call(hass, "seed", config=HOUSE)
    r = await call(hass, "get_config")
    assert [o["entity_id"] for o in r["outputs"]] == ["media_player.ma_amp_dlna"]
    assert r["outputs_unexposed"] == []
    assert r["config"]["media"]["show_unavailable_outputs"] is False
    # the panel's own output stays listed even while it is unavailable (the label must not vanish)
    await call(hass, "set_output", entity_id="media_player.ma_gone")
    r = await call(hass, "get_config")
    assert [o["entity_id"] for o in r["outputs"]] == ["media_player.ma_amp_dlna", "media_player.ma_gone"]
    assert r["music_output_valid"] is True
    # debugging option: everything back
    await call(hass, "seed", config={**HOUSE, "media": {"show_unavailable_outputs": True}}, force=True)
    r = await call(hass, "get_config")
    assert len(r["outputs"]) == 2 and [u["name"] for u in r["outputs_unexposed"]] == ["Web (Chrome on Android)"]


async def test_picker_rows_carry_sync_groups_as_entity_ids(hass, panel, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    for eid, name in [
        ("media_player.ma_amp_dlna", "R-N500 DLNA"),
        ("media_player.ma_amp_airplay", "R-N500 AirPlay"),
        ("media_player.tv_3", "TV"),
    ]:
        _ma_player(hass, eid, name)
    reg = __import__("homeassistant.helpers.entity_registry", fromlist=["x"]).async_get(hass)
    # MA ids differ from entity ids for universal players: map through the registry's unique_id
    reg.async_update_entity("media_player.ma_amp_airplay", new_unique_id="up2e612fa9")
    reg.async_update_entity("media_player.tv_3", new_unique_id="updcd23cf6")
    mass = SimpleNamespace(
        players=_FakePlayers(
            [
                _sp("media_player.ma_amp_dlna", "R-N500 DLNA"),
                _sp("up2e612fa9", "R-N500 AirPlay", can=["updcd23cf6", "pixel"], members=["up2e612fa9", "updcd23cf6"]),
                _sp("updcd23cf6", "TV", can=["up2e612fa9", "pixel"], synced_to="up2e612fa9"),
            ]
        )
    )
    monkeypatch.setattr(kp, "_mass_client", lambda hass: mass)
    await call(hass, "seed", config=HOUSE)
    rows = {o["entity_id"]: o for o in (await call(hass, "get_config"))["outputs"]}
    assert rows["media_player.ma_amp_airplay"]["group_with"] == ["media_player.tv_3"]  # pixel: no HA entity
    assert rows["media_player.ma_amp_airplay"]["group_members"] == ["media_player.ma_amp_airplay", "media_player.tv_3"]
    assert rows["media_player.tv_3"]["synced_to"] == "media_player.ma_amp_airplay"
    assert (
        rows["media_player.ma_amp_dlna"]["group_with"] == [] and rows["media_player.ma_amp_dlna"]["synced_to"] is None
    )


class _MoveQueues:
    """MA's transfer_queue as it really behaves: it clears the source and loads the target BEFORE starting it."""

    def __init__(self, fail_on=None):
        self.items = {"media_player.ma_amp_airplay": 26, "media_player.ma_amp_dlna": 0}
        self.fail_on = fail_on
        self.calls = []

    async def get_active_queue(self, pid):
        n = self.items.get(pid, 0)
        st = "playing" if pid == "media_player.ma_amp_airplay" and n else "idle"
        return SimpleNamespace(queue_id=pid, items=n, state=SimpleNamespace(value=st))

    async def transfer_queue(self, src, dst, auto_play):
        self.calls.append(("transfer", src, dst, auto_play))
        self.items[dst], self.items[src] = self.items[src], 0
        if dst == self.fail_on:
            raise RuntimeError("the receiver is held by another owner (hold entity is on)")

    async def resume(self, qid):
        self.calls.append(("resume", qid))


async def _move_setup(hass, monkeypatch, queues, nodes=None):
    import custom_components.kindle_panel as kp

    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    _ma_player(hass, "media_player.ma_amp_airplay", "R-N500 AirPlay")
    mass = SimpleNamespace(player_queues=queues)
    monkeypatch.setattr(kp, "_mass_and_player", lambda hass, entry, eid: (mass, eid))
    cfg = {**HOUSE, "media": {"music_backend": "ha", "nodes": nodes or []}}
    await call(hass, "seed", config=cfg)
    await call(hass, "set_output", entity_id="media_player.ma_amp_airplay")


RX_AMP_022 = {
    "id": "amp",
    "type": "receiver",
    "name": "Amp",
    "power_device": "media_player.r_n500",
    "players": ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
}


async def test_move_refused_up_front_when_the_receiver_is_held(hass, panel, monkeypatch) -> None:
    q = _MoveQueues()
    await _move_setup(hass, monkeypatch, q, nodes=[RX_AMP_022])
    hass.states.async_set("media_player.r_n500", "on", {"held": True})
    r = await call(hass, "move_queue", entity_id="media_player.ma_amp_dlna")
    assert r["ok"] is False and r["reason"] == "held" and "media_player.r_n500" in r["error"]
    assert r["music_output"] == "media_player.ma_amp_airplay"
    assert q.calls == [] and q.items["media_player.ma_amp_airplay"] == 26  # nothing touched
    assert (await call(hass, "get_config"))["music_output"] == "media_player.ma_amp_airplay"


async def test_move_refused_when_the_target_is_unavailable(hass, panel, monkeypatch) -> None:
    q = _MoveQueues()
    await _move_setup(hass, monkeypatch, q)
    hass.states.async_set("media_player.ma_amp_dlna", "unavailable")
    r = await call(hass, "move_queue", entity_id="media_player.ma_amp_dlna")
    assert r["ok"] is False and r["reason"] == "unavailable" and q.calls == []


async def test_failed_move_puts_the_music_back_and_keeps_the_output(hass, panel, monkeypatch) -> None:
    """The 2026-10-18 16:52 case: MA cleared AirPlay, loaded DLNA, DLNA refused to start (receiver held)."""
    q = _MoveQueues(fail_on="media_player.ma_amp_dlna")
    await _move_setup(hass, monkeypatch, q)  # no receiver node: the pre-check cannot see the hold
    r = await call(hass, "move_queue", entity_id="media_player.ma_amp_dlna")
    assert r["ok"] is False and r["reason"] == "failed" and r["restored"] == "moved_back"
    assert "held by another owner" in r["error"]
    assert q.calls == [
        ("transfer", "media_player.ma_amp_airplay", "media_player.ma_amp_dlna", True),
        ("transfer", "media_player.ma_amp_dlna", "media_player.ma_amp_airplay", True),
    ]
    assert q.items == {"media_player.ma_amp_airplay": 26, "media_player.ma_amp_dlna": 0}
    assert (await call(hass, "get_config"))["music_output"] == "media_player.ma_amp_airplay"


def test_tv_movie_active_takes_the_movie_script() -> None:
    from custom_components.kindle_panel.config import normalize

    node = {**TV_NODE, "movie_active": "script.movie_mode"}
    assert normalize({"media": {"nodes": [node]}})["media"]["nodes"][0]["movie_active"] == "script.movie_mode"
    old = {**TV_NODE, "movie_active": "input_boolean.movie_mode_active"}  # other households: still fine
    assert normalize({"media": {"nodes": [old]}})["media"]["nodes"][0]["movie_active"].startswith("input_boolean.")


# ---------------------------------------------------------------- bus task 023: hidden outputs, sync answers


async def test_picker_hides_ma_hidden_players_and_the_option_list(hass, panel, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    for eid, name in [
        ("media_player.ma_amp_airplay", "R-N500 AirPlay"),
        ("media_player.ma_amp_dlna", "R-N500 DLNA"),
        ("media_player.pixel_phone", "Pixel phone"),
        ("media_player.tv_3", "TV"),
    ]:
        _ma_player(hass, eid, name)
    pixel = _sp("media_player.pixel_phone", "Pixel phone")
    pixel.hide_in_ui = True  # MA: Hide player
    mass = SimpleNamespace(
        players=_FakePlayers(
            [
                _sp("media_player.ma_amp_airplay", "R-N500 AirPlay"),
                _sp("media_player.ma_amp_dlna", "R-N500 DLNA"),
                pixel,
                _sp("media_player.tv_3", "TV"),
            ]
        )
    )
    monkeypatch.setattr(kp, "_mass_client", lambda hass: mass)
    await call(hass, "seed", config=HOUSE)
    r = await call(hass, "get_config")
    assert r["config"]["media"]["hidden_outputs"] == []
    assert [o["entity_id"] for o in r["outputs"]] == [
        "media_player.ma_amp_airplay",
        "media_player.ma_amp_dlna",
        "media_player.tv_3",
    ]
    # the owner's list hides more; the debugging option does not bring hidden players back
    media = {"hidden_outputs": ["media_player.ma_amp_dlna"], "show_unavailable_outputs": True}
    await call(hass, "seed", config={**HOUSE, "media": media}, force=True)
    r = await call(hass, "get_config")
    assert [o["entity_id"] for o in r["outputs"]] == ["media_player.ma_amp_airplay", "media_player.tv_3"]
    # the panel's own output is always listed, hidden or not
    await call(hass, "set_output", entity_id="media_player.pixel_phone")
    r = await call(hass, "get_config")
    assert "media_player.pixel_phone" in [o["entity_id"] for o in r["outputs"]]
    assert r["music_output_valid"] is True
    # unknown MA data (MA not loaded): visible
    monkeypatch.setattr(kp, "_mass_client", lambda hass: None)
    await call(hass, "seed", config=HOUSE, force=True)
    r = await call(hass, "get_config")
    assert len(r["outputs"]) == 4


def test_hidden_outputs_option_validates_entity_ids() -> None:
    from custom_components.kindle_panel.config import normalize

    assert normalize({"media": {"hidden_outputs": "media_player.pixel_phone"}})["media"]["hidden_outputs"] == [
        "media_player.pixel_phone"
    ]
    with pytest.raises(vol.Invalid):
        normalize({"media": {"hidden_outputs": ["not an entity"]}})


async def test_options_flow_saves_hidden_outputs(hass, panel) -> None:
    _ma_player(hass, "media_player.pixel_phone", "Pixel phone")
    await call(hass, "seed", config=HOUSE)
    flow = await hass.config_entries.options.async_init(panel.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "media"})
    field = {str(k): v for k, v in flow["data_schema"].schema.items()}["hidden_outputs"]
    assert field.config["multiple"] is True and field.config["integration"] == "music_assistant"
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"],
        {
            "music_backend": "ha",
            "nodes": [],
            **{f"key_f{i}": "none" for i in range(1, 5)},
            **{f"out_f{i}": "none" for i in range(1, 5)},
            "hidden_outputs": ["media_player.pixel_phone"],
        },
    )
    assert res["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert (await call(hass, "get_config"))["config"]["media"]["hidden_outputs"] == ["media_player.pixel_phone"]


async def _sync_setup(hass, monkeypatch, *, join_error=None, joins=True):
    """AirPlay (the panel's output) can sync with the TV, the DLNA player with nothing; a fake media_player.join
    adds the member to MA's group (or raises / does nothing)."""
    import custom_components.kindle_panel as kp

    for eid, name in [
        ("media_player.ma_amp_airplay", "R-N500 AirPlay"),
        ("media_player.ma_amp_dlna", "R-N500 DLNA"),
        ("media_player.tv_3", "TV"),
    ]:
        _ma_player(hass, eid, name)
    air = _sp("media_player.ma_amp_airplay", "R-N500 AirPlay", can=["media_player.tv_3"], state="playing")
    mass = SimpleNamespace(
        players=_FakePlayers([air, _sp("media_player.ma_amp_dlna", "R-N500 DLNA"), _sp("media_player.tv_3", "TV")])
    )
    monkeypatch.setattr(kp, "_mass_and_player", lambda hass, entry, eid: (mass, eid))
    monkeypatch.setattr(kp, "SYNC_CONFIRM_S", 0.02)
    monkeypatch.setattr(kp, "SYNC_POLL_S", 0.01)
    calls = []

    async def join(call):
        calls.append(("join", call.data["entity_id"], call.data["group_members"]))
        if join_error:
            raise HomeAssistantError(join_error)
        if joins:
            air.group_members = [air.player_id, *call.data["group_members"]]

    async def unjoin(call):
        calls.append(("unjoin", call.data["entity_id"]))
        air.group_members = []

    hass.services.async_register("media_player", "join", join)
    hass.services.async_register("media_player", "unjoin", unjoin)
    await call(hass, "seed", config=HOUSE)
    await call(hass, "set_output", entity_id="media_player.ma_amp_airplay")
    return calls


async def test_sync_output_joins_and_unjoins(hass, panel, monkeypatch) -> None:
    calls = await _sync_setup(hass, monkeypatch)
    r = await call(hass, "sync_output", entity_id="media_player.tv_3")
    assert r["ok"] is True and r["leader"] == "media_player.ma_amp_airplay"
    assert r["group_members"] == ["media_player.ma_amp_airplay", "media_player.tv_3"]
    r = await call(hass, "sync_output", entity_id="media_player.tv_3", join=False)
    assert r["ok"] is True
    assert calls == [
        ("join", "media_player.ma_amp_airplay", ["media_player.tv_3"]),
        ("unjoin", "media_player.tv_3"),
    ]


async def test_sync_output_answers_why_not(hass, panel, monkeypatch) -> None:
    calls = await _sync_setup(hass, monkeypatch)
    r = await call(hass, "sync_output", entity_id="media_player.ma_amp_dlna")
    assert r["ok"] is False and r["reason"] == "cannot" and calls == []  # not in can_group_with: nothing called
    hass.states.async_set("media_player.tv_3", "unavailable")
    r = await call(hass, "sync_output", entity_id="media_player.tv_3")
    assert r["ok"] is False and r["reason"] == "unavailable" and calls == []
    with pytest.raises(ServiceValidationError):
        await call(hass, "sync_output", entity_id="media_player.ma_amp_airplay")


async def test_sync_output_reports_a_refused_join(hass, panel, monkeypatch) -> None:
    await _sync_setup(hass, monkeypatch, join_error="TV is off")
    r = await call(hass, "sync_output", entity_id="media_player.tv_3")
    assert r == {
        "ok": False,
        "entity_id": "media_player.tv_3",
        "leader": "media_player.ma_amp_airplay",
        "join": True,
        "reason": "failed",
        "error": "TV is off",
    }


async def test_sync_output_reports_a_join_ma_ignored(hass, panel, monkeypatch) -> None:
    await _sync_setup(hass, monkeypatch, joins=False)
    r = await call(hass, "sync_output", entity_id="media_player.tv_3")
    assert r["ok"] is False and r["reason"] == "not_joined"
