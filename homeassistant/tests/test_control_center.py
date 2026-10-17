"""The panel's control center: config seeding, options pages, screensaver photos with keep/skip."""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
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
