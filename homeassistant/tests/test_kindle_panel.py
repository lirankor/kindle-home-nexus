"""kindle_panel against a fake Music Assistant client."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

DOMAIN = "kindle_panel"
PLAYER = "media_player.ma_amp_dlna"


def track(i: int):
    album = SimpleNamespace(name="Hotel California", uri=f"jellyfin://album/alb{i // 10}")
    # synced into MA's library: library:// uri, the Jellyfin id only in the provider mapping
    m = SimpleNamespace(
        uri=f"library://track/{100 + i}",
        name=f"Song {i}",
        artists=[SimpleNamespace(name="Eagles")],
        album=album,
        provider_mappings=[SimpleNamespace(provider_domain="jellyfin", item_id=f"t{i}")],
    )
    return SimpleNamespace(queue_item_id=f"q{i}", name=f"Eagles - Song {i}", duration=200 + i, media_item=m)


class FakeQueues:
    def __init__(self) -> None:
        self.played: list[tuple[str, int]] = []
        self.queue = SimpleNamespace(
            queue_id="queue1", display_name="80s", items=40, current_index=5, shuffle_enabled=False
        )

    async def get_active_queue(self, player_id):
        assert player_id == "player1"
        return self.queue

    async def get_queue_items(self, queue_id, limit=500, offset=0):
        return [track(i) for i in range(offset, min(offset + limit, self.queue.items))]

    async def play_index(self, queue_id, index):
        self.played.append((queue_id, index))


@pytest.fixture
async def setup(hass: HomeAssistant):
    queues = FakeQueues()
    mass = SimpleNamespace(
        player_queues=queues, get_media_item_image_url=lambda qi: f"http://ma/img/{qi.queue_item_id}"
    )
    ma = MockConfigEntry(domain="music_assistant", data={"url": "http://ma"}, state=ConfigEntryState.LOADED)
    ma.add_to_hass(hass)
    ma.runtime_data = SimpleNamespace(mass=mass)
    er.async_get(hass).async_get_or_create(
        "media_player", "music_assistant", "player1", config_entry=ma, suggested_object_id="ma_amp_dlna"
    )
    with patch("homeassistant.components.music_assistant.async_setup", return_value=True):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
        assert result["type"] is FlowResultType.CREATE_ENTRY  # one MA connection: picked automatically
        await hass.async_block_till_done()
    return queues


async def test_get_queue_returns_whole_queue_paged(hass: HomeAssistant, setup) -> None:
    r = await hass.services.async_call(
        DOMAIN, "get_queue", {"entity_id": PLAYER, "offset": 0, "limit": 25}, blocking=True, return_response=True
    )
    assert r["total"] == 40 and r["current_index"] == 5 and r["name"] == "80s"
    assert len(r["items"]) == 25
    it = r["items"][7]
    assert it["index"] == 7 and it["jellyfin_id"] == "t7" and it["id"] == "107"
    assert it["title"] == "Song 7" and it["artist"] == "Eagles"
    assert it["album_id"] == "alb0" and it["image"] == "http://ma/img/q7"
    r2 = await hass.services.async_call(
        DOMAIN, "get_queue", {"entity_id": PLAYER, "offset": 25, "limit": 25}, blocking=True, return_response=True
    )
    assert [i["index"] for i in r2["items"]] == list(range(25, 40))


async def test_play_index(hass: HomeAssistant, setup) -> None:
    await hass.services.async_call(DOMAIN, "play_index", {"entity_id": PLAYER, "index": 12}, blocking=True)
    assert setup.played == [("queue1", 12)]
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "play_index", {"entity_id": PLAYER, "index": 40}, blocking=True)


async def test_rejects_non_ma_entities(hass: HomeAssistant, setup) -> None:
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN, "get_queue", {"entity_id": "media_player.r_n500"}, blocking=True, return_response=True
        )


async def test_works_without_music_assistant(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
