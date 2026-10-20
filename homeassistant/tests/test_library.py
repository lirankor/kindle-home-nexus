"""Bus task 027: the library is a Music Assistant client (library_home / list / search / play / favorite)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from custom_components.kindle_panel import library as lib

DOMAIN = "kindle_panel"
BASE = "http://192.168.1.15:8095"


async def call(hass, svc, **data):
    return await hass.services.async_call(DOMAIN, svc, data, blocking=True, return_response=True)


@pytest.fixture
async def panel(hass: HomeAssistant, tmp_path):
    hass.config.media_dirs = {"local": str(tmp_path)}
    assert await async_setup_component(hass, "media_source", {})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    return hass.config_entries.async_entries(DOMAIN)[0]


def _img(path, provider="jellyfin", remote=False):
    return {
        "metadata": {"images": [{"type": "thumb", "path": path, "provider": provider, "remotely_accessible": remote}]}
    }


def _album(i, fav=False, name=None):
    return {
        "item_id": str(i),
        "provider": "library",
        "uri": f"library://album/{i}",
        "media_type": "album",
        "name": name or f"Album {i}",
        "favorite": fav,
        "year": 1974,
        "artists": [{"name": "Queen"}],
        **_img(f"http://jf/Items/{i}/Images/Primary"),
    }


def _radio(i, fav=False):
    return {
        "item_id": str(i),
        "provider": "library",
        "uri": f"library://radio/{i}",
        "media_type": "radio",
        "name": f"Radio {i}",
        "favorite": fav,
        **_img(f"https://cdn.example/r{i}.png", provider="builtin", remote=True),
    }


class _NoPlayers(list):
    def get(self, _pid):
        return None


class FakeMass:
    """MA's JSON API as the panel uses it (send_command), with a small library."""

    def __init__(self, providers=None):
        self.server_info = SimpleNamespace(base_url=BASE, schema_version=30)
        self.providers = providers or [
            SimpleNamespace(supported_features=["library_albums", "library_artists", "library_tracks", "search"]),
            SimpleNamespace(supported_features=["library_playlists", "library_radios"]),
            SimpleNamespace(supported_features=["library_podcasts", "search"]),
        ]
        self.albums = [_album(i, fav=i in (5, 9)) for i in range(1, 21)]
        self.radios = [_radio(i, fav=i == 2) for i in range(1, 6)]
        self.sent: list[tuple[str, dict]] = []
        self.player_queues = SimpleNamespace(get_active_queue=self._queue, get=lambda _id: None)
        self.players = _NoPlayers()

    async def _queue(self, pid):
        return SimpleNamespace(queue_id=f"q-{pid}")

    def _lib(self, api):
        return {"albums": self.albums, "radios": self.radios}.get(api, [])

    async def send_command(self, cmd, **kw):
        self.sent.append((cmd, kw))
        if cmd.endswith("/count"):
            items = self._lib(cmd.split("/")[1])
            return len([x for x in items if x["favorite"]]) if kw.get("favorite_only") else len(items)
        if cmd.endswith("/library_items") and cmd != "music/genres/library_items":
            items = self._lib(cmd.split("/")[1])
            if kw.get("favorite") is not None:
                items = [x for x in items if x["favorite"] == kw["favorite"]]
            if kw.get("search"):
                items = [x for x in items if kw["search"].lower() in x["name"].lower()]
            o, n = kw.get("offset", 0), kw.get("limit", 500)
            return items[o : o + n]
        if cmd == "music/genres/library_items":
            return [
                {
                    "item_id": "6",
                    "provider": "library",
                    "uri": "library://genre/6",
                    "media_type": "genre",
                    "name": "Blues",
                }
            ]
        if cmd == "music/genres/albums":
            return [self.albums[0], self.albums[1]]
        if cmd == "music/albums/album_tracks":
            return [
                {
                    "item_id": f"t{i}",
                    "provider": "library",
                    "uri": f"library://track/t{i}",
                    "media_type": "track",
                    "name": f"Track {i}",
                    "duration": 180,
                    "artists": [{"name": "Queen"}],
                    "album": {"name": "Album 1", "uri": "library://album/1"},
                }
                for i in range(1, 12)
            ]
        if cmd == "music/item_by_uri":
            return self.albums[0] if kw["uri"] == "library://album/1" else None
        if cmd == "music/recommendations":
            return [
                {
                    "item_id": "in_progress",
                    "provider": "recommendations",
                    "name": "In progress",
                    "enabled_by_default": True,
                },
                {
                    "item_id": "recently_played",
                    "provider": "recommendations",
                    "name": "Recently played",
                    "enabled_by_default": True,
                },
                {
                    "item_id": "random_albums",
                    "provider": "recommendations",
                    "name": "Random albums",
                    "enabled_by_default": False,
                },
                {
                    "item_id": "favorite_radio",
                    "provider": "recommendations",
                    "name": "Favorite Radio stations",
                    "enabled_by_default": False,
                },
                {
                    "item_id": "itunes-top",
                    "provider": "itunes_podcasts",
                    "name": "Trending Podcasts",
                    "enabled_by_default": True,
                },
            ]
        if cmd == "music/recommendations/items":
            return {
                "recently_played": [self.albums[2], {"media_type": "folder", "uri": "x://folder/1", "name": "F"}],
                "favorite_radio": [self.radios[1]],
                "itunes-top": [
                    {
                        "item_id": "p1",
                        "provider": "itunes_podcasts",
                        "uri": "itunes_podcasts://podcast/p1",
                        "media_type": "podcast",
                        "name": "Daily",
                        "publisher": "Kan",
                    }
                ],
            }.get(kw["item_id"], [])
        if cmd == "music/search":
            return {
                "artists": [
                    {
                        "item_id": "1",
                        "provider": "library",
                        "uri": "library://artist/1",
                        "media_type": "artist",
                        "name": "Queen",
                    }
                ],
                "albums": [self.albums[0]],
                "radio": [
                    {
                        "item_id": "r9",
                        "provider": "radiobrowser",
                        "uri": "radiobrowser://radio/r9",
                        "media_type": "radio",
                        "name": "Queen FM",
                    }
                ],
            }
        if cmd == "music/get_library_item":
            return {"item_id": "77"} if kw["item_id"] == "r9" else None
        return None


def _ma_player(hass, entity_id, name, state="idle"):
    er.async_get(hass).async_get_or_create(
        "media_player", "music_assistant", entity_id, suggested_object_id=entity_id.split(".")[1]
    )
    hass.states.async_set(entity_id, state, {"friendly_name": name})


@pytest.fixture
def mass(hass, monkeypatch):
    import custom_components.kindle_panel as kp

    m = FakeMass()
    monkeypatch.setattr(kp, "_mass_client", lambda hass: m)
    monkeypatch.setattr(kp, "_mass_and_player", lambda hass, entry, eid: (m, eid))
    return m


def test_available_tabs_follow_ma_providers() -> None:
    m = FakeMass()
    assert lib.available_tabs(m) == [
        "playlists",
        "radio",
        "genres",
        "albums",
        "artists",
        "tracks",
        "podcasts",
        "search",
    ]
    only_jf = FakeMass(providers=[SimpleNamespace(supported_features=["library_albums", "library_playlists"])])
    assert lib.available_tabs(only_jf) == ["playlists", "genres", "albums"]
    assert lib.available_tabs(None) == lib.LIBRARY_TABS


def test_library_view_keeps_the_owner_order_and_falls_back() -> None:
    m = FakeMass()
    v = lib.library_view({"library_tabs": ["search", "albums", "audiobooks", "radio"], "library_tab": "audiobooks"}, m)
    assert v["tabs"] == ["radio", "albums", "search"]  # owner's order; no audiobook provider
    assert v["tab"] == "radio" and v["missing"] == ["audiobooks"] and v["discover_key"] is True
    assert lib.library_view({}, m)["tab"] == "playlists"


def test_item_view_proxies_every_image_and_reads_the_second_line() -> None:
    v = lib.item_view(_album(3), BASE, 30)
    assert v["sub"] == "Queen · 1974" and v["opens"] is True and v["in_library"] is True
    assert v["image"].startswith(f"{BASE}/imageproxy?path=") and "provider=jellyfin" in v["image"]
    r = lib.item_view(_radio(1), BASE, 30)
    assert r["image"].startswith(f"{BASE}/imageproxy?") and "cdn.example" in r["image"]  # a CDN logo too
    assert r["opens"] is False
    assert lib.item_view({"media_type": "folder", "uri": "x://f/1"}, BASE, 30) is None
    proxied = lib.item_view(
        {**_album(4), "metadata": {"images": [{"type": "thumb", "path": "p", "proxy_id": "ab"}]}}, BASE, 31
    )
    assert proxied["image"] == f"{BASE}/imageproxy/ab?size=256"


def test_parse_uri() -> None:
    assert lib.parse_uri("library://album/197") == ("library", "album", "197")
    with pytest.raises(ValueError):
        lib.parse_uri("album/197")


async def test_get_config_answers_the_library(hass, panel, mass) -> None:
    await call(
        hass,
        "seed",
        config={"media": {"library_tabs": ["albums", "playlists"], "library_tab": "albums", "discover_key": False}},
    )
    r = await call(hass, "get_config")
    assert r["library"]["tabs"] == ["playlists", "albums"] and r["library"]["tab"] == "albums"
    assert r["library"]["discover_key"] is False
    assert r["config"]["media"]["library_tabs"] == ["playlists", "albums"]


async def test_library_home_rows(hass, panel, mass) -> None:
    r = await call(hass, "library_home")
    ids = [row["id"] for row in r["rows"]]
    # MA's default rows + the favourites rows, MA's order; empty rows (In progress, favourite artists) left out,
    # a disabled row (Random albums) left out; favourite albums (synthetic) right after Recently played
    assert ids == ["recently_played", "favorite_albums", "favorite_radio", "itunes-top"]
    assert [i["name"] for i in r["rows"][0]["items"]] == ["Album 3"]  # the folder is dropped
    assert [i["name"] for i in r["rows"][1]["items"]] == ["Album 5", "Album 9"]
    assert r["rows"][3]["items"][0]["sub"] == "Kan"


async def test_library_list_favourites_first_across_pages(hass, panel, mass) -> None:
    p1 = await call(hass, "library_list", section="albums", offset=0, limit=8)
    assert p1["total"] == 20 and p1["favorites"] == 2
    assert [i["name"] for i in p1["items"]][:3] == ["Album 5", "Album 9", "Album 1"]
    assert len(p1["items"]) == 8
    p2 = await call(hass, "library_list", section="albums", offset=8, limit=8)
    # the rest continues where page 1 stopped (6 non-favourites were on page 1)
    assert p2["items"][0]["name"] == "Album 8"
    radios = await call(hass, "library_list", section="radio", offset=0, limit=8)
    assert radios["items"][0]["name"] == "Radio 2" and radios["items"][0]["favorite"] is True
    only = await call(hass, "library_list", section="radio", favorite=True)
    assert [i["name"] for i in only["items"]] == ["Radio 2"] and only["total"] == 1


async def test_library_list_parents_and_genres(hass, panel, mass) -> None:
    t = await call(hass, "library_list", parent="library://album/1", offset=8, limit=8)
    assert t["total"] == 11 and [i["name"] for i in t["items"]] == ["Track 9", "Track 10", "Track 11"]
    assert t["parent"]["name"] == "Album 1" and t["items"][0]["album_uri"] == "library://album/1"
    calls = [c for c, _ in mass.sent if c == "music/albums/album_tracks"]
    await call(hass, "library_list", parent="library://album/1", offset=0, limit=8)
    assert len([c for c, _ in mass.sent if c == "music/albums/album_tracks"]) == len(calls)  # cached
    g = await call(hass, "library_list", section="genres")
    assert g["items"][0]["uri"] == "library://genre/6" and g["items"][0]["opens"] is True
    ga = await call(hass, "library_list", parent="library://genre/6")
    assert [i["name"] for i in ga["items"]] == ["Album 1", "Album 2"]
    assert ("music/genres/albums", {"item_id": "6", "limit": 0, "offset": 0}) in mass.sent
    with pytest.raises(ServiceValidationError):
        await call(hass, "library_list")
    with pytest.raises(ServiceValidationError):
        await call(hass, "library_list", parent="library://track/3")


async def test_library_search_all_types(hass, panel, mass) -> None:
    r = await call(hass, "library_search", query="queen")
    assert [(i["media_type"], i["name"]) for i in r["items"]] == [
        ("artist", "Queen"),
        ("album", "Album 1"),
        ("radio", "Queen FM"),
    ]
    assert r["items"][2]["in_library"] is False


async def test_library_favorite_add_and_remove(hass, panel, mass) -> None:
    assert (await call(hass, "library_favorite", uri="library://album/3", favorite=True))["favorite"] is True
    assert ("music/favorites/add_item", {"item": "library://album/3"}) in mass.sent
    await call(hass, "library_favorite", uri="library://album/3", favorite=False)
    assert ("music/favorites/remove_item", {"media_type": "album", "library_item_id": "3"}) in mass.sent
    # a provider item: removed by its library id
    await call(hass, "library_favorite", uri="radiobrowser://radio/r9", favorite=False)
    assert ("music/favorites/remove_item", {"media_type": "radio", "library_item_id": "77"}) in mass.sent


RX = {
    "id": "amp",
    "type": "receiver",
    "name": "Amp",
    "power_device": "media_player.r_n500",
    "players": ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"],
}


async def test_library_play_options(hass, panel, mass) -> None:
    _ma_player(hass, "media_player.ma_amp_airplay", "R-N500 AirPlay", "playing")
    hass.states.async_set("media_player.r_n500", "on")
    await call(hass, "seed", config={"media": {"music_backend": "ha", "nodes": [RX]}})
    await call(hass, "set_output", entity_id="media_player.ma_amp_airplay")
    r = await call(hass, "library_play", uri="library://album/1", start_item="library://track/t3")
    assert r == {"ok": True, "status": "playing", "player": "media_player.ma_amp_airplay"}
    assert mass.sent[-1] == (
        "player_queues/play_media",
        {"queue_id": "q-media_player.ma_amp_airplay", "media": "library://album/1", "option": "replace",
         "start_item": "library://track/t3"},
    )  # fmt: skip
    r = await call(hass, "library_play", uri="library://track/t4", option="next")
    assert r["status"] == "queued" and mass.sent[-1][1]["option"] == "next"
    with pytest.raises(ServiceValidationError):
        await call(hass, "library_play", uri="nonsense")


async def test_library_play_wakes_the_receiver_then_plays(hass, panel, mass, monkeypatch) -> None:
    import custom_components.kindle_panel as kp

    monkeypatch.setattr(kp, "WAKE_POLL_S", 0.01)
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    hass.states.async_set("media_player.r_n500", "off")
    turned_on = []

    async def turn_on(call):
        turned_on.append(call.data)
        hass.states.async_set("media_player.r_n500", "on")

    hass.services.async_register("media_player", "turn_on", turn_on)
    await call(hass, "seed", config={"media": {"music_backend": "ha", "nodes": [RX]}})
    await call(hass, "set_output", entity_id="media_player.ma_amp_dlna")
    r = await call(hass, "library_play", uri="library://radio/2")
    assert r["status"] == "powering_on" and r["receiver"] == "media_player.r_n500"
    for _ in range(50):
        await asyncio.sleep(0.02)
        await hass.async_block_till_done()
        if any(c == "player_queues/play_media" for c, _ in mass.sent):
            break
    assert turned_on and turned_on[0]["entity_id"] == "media_player.r_n500"
    assert (
        "player_queues/play_media",
        {"queue_id": "q-media_player.ma_amp_dlna", "media": "library://radio/2", "option": "replace"},
    ) in mass.sent


async def test_library_play_refuses_a_held_receiver(hass, panel, mass) -> None:
    _ma_player(hass, "media_player.ma_amp_dlna", "R-N500 DLNA")
    hass.states.async_set("media_player.r_n500", "on", {"held": True})
    await call(hass, "seed", config={"media": {"music_backend": "ha", "nodes": [RX]}})
    await call(hass, "set_output", entity_id="media_player.ma_amp_dlna")
    r = await call(hass, "library_play", uri="library://radio/2")
    assert r["ok"] is False and r["reason"] == "held"
    assert not any(c == "player_queues/play_media" for c, _ in mass.sent)
