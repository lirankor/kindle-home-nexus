"""Kept / skipped photo counts, so the curation is visible in HA."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SIGNAL_MARKS, KindlePanelConfigEntry
from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant, entry: KindlePanelConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    async_add_entities([MarkCount(entry, "kept"), MarkCount(entry, "skipped")])


class MarkCount(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "photos"

    def __init__(self, entry: KindlePanelConfigEntry, kind: str) -> None:
        self._entry = entry
        self._kind = kind
        self._attr_translation_key = f"photos_{kind}"
        self._attr_unique_id = f"{entry.entry_id}_photos_{kind}"
        self._attr_icon = "mdi:image-check" if kind == "kept" else "mdi:image-remove"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)}, name="Kindle Panel", manufacturer="kindle-home-nexus"
        )

    @property
    def native_value(self) -> int:
        marks = self._entry.runtime_data.marks
        return len(marks.kept if self._kind == "kept" else marks.skipped)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_MARKS, self._update))

    @callback
    def _update(self) -> None:
        self.async_write_ha_state()
