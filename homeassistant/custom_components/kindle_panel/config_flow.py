"""Config flow: pick the Music Assistant connection to use (automatic when there is one)."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers import selector

from .const import CONF_MA_ENTRY, DOMAIN, MA_DOMAIN


class KindlePanelConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entries = self.hass.config_entries.async_entries(MA_DOMAIN)
        if not entries:
            return self.async_abort(reason="no_music_assistant")
        if user_input is None and len(entries) == 1:
            user_input = {CONF_MA_ENTRY: entries[0].entry_id}
        if user_input is not None:
            return self.async_create_entry(title="Kindle Panel", data=user_input)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_MA_ENTRY): selector.ConfigEntrySelector(
                        selector.ConfigEntrySelectorConfig(integration=MA_DOMAIN)
                    )
                }
            ),
        )
