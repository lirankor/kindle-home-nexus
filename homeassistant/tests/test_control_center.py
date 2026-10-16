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
    "lights": [{"entity_id": "light.main_light", "name": "Main light", "room": "Living room", "icon": "lamp_ceiling"}],
    "vacuum": {
        "entity_id": "vacuum.robo",
        "rooms": [{"entity_id": "input_boolean.robo_grid_1", "name": "Shower", "icon": "shower"}],
    },
    "plugs": [{"entity_id": "switch.tv_plug", "name": "TV Plug", "power_entity": "sensor.tv_power", "energy_to_wh": 1}],
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
    r = await call(hass, "seed", config=HOUSE, kept={"asset1": "2026-10-01T00:00:00Z"}, skipped=["asset2"])
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
        {"entity_id": "light.main_light", "name": "Main light", "room": "Living room", "icon": "lamp_ceiling"},
        {"entity_id": "light.spots", "name": "Spot light", "room": "Living room", "icon": "spot"},
    ]
    res = await hass.config_entries.options.async_configure(
        flow["flow_id"], {"lights": lights, "evening_light": "light.main_light", "evening_pct": 40, "warm_kelvin": 2200}
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
        flow["flow_id"], {"sources": [folder["value"]], "mode": "curate", "photo_minutes": 10, "idle_minutes": 5}
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
            "screensaver": {"sources": [{"type": "media_source", "id": "media-source://media_source/local/photos"}]},
        },
    )
    seen = set()
    for _ in range(20):
        r = await call(hass, "pick_photo")
        seen.add(r["photo"]["id"])
        assert r["photo"]["url"].startswith("/media/local/photos/")
    assert len(seen) == 3
    a = sorted(seen)[0]
    await call(hass, "mark_photo", photo_id=a, verdict="skip")
    for _ in range(15):
        assert (await call(hass, "pick_photo"))["photo"]["id"] != a  # skipped: never again
    with pytest.raises(ServiceValidationError):
        await call(hass, "mark_photo", photo_id="never-shown", verdict="keep")


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
    ids = {(await call(hass, "pick_photo", previous_id=None))["photo"]["id"] for _ in range(10)}
    assert ids == {"p1", "l1"}  # all judged: the kept ones


def test_pick_modes() -> None:
    photos = [Photo(i, f"/{i}", i, "s") for i in ("k", "s", "u")]
    m = MarkStore.__new__(MarkStore)
    m.kept, m.skipped, m.seeded = {"k": ""}, {"s": ""}, True
    rnd = random.Random(1)
    assert {pick(photos, m, "curate", None, rnd).id for _ in range(20)} == {"u"}
    assert {pick(photos, m, "kept_only", None, rnd).id for _ in range(20)} == {"k"}
    assert {pick(photos, m, "all_but_skipped", None, rnd).id for _ in range(30)} == {"k", "u"}
    m.skipped = {"k": "", "s": "", "u": ""}
    assert pick(photos, m, "curate", None, rnd) is None
