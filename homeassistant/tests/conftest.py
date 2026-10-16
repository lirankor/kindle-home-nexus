import pytest

import custom_components.kindle_panel  # noqa: F401 - make the namespace package known to the loader

pytest_plugins = ["pytest_homeassistant_custom_component"]


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
