"""Measured weather reference for the season (data/site/weather_analogue.json, built by tools/make_weather_analogue.py).

Curiosity REMS daily reports from Gale crater for the same solar longitude as the scenario. The demo site has
no station, so this is an analogue from another site at a similar latitude. Read once at start; the dashboard
shows it with that label.
"""
import json
import os

from . import SITE_DIR

PATH = os.path.join(SITE_DIR, "weather_analogue.json")


def load_weather(path=PATH):
    """The analogue summary as a dict, or None when the file is missing or unreadable."""
    try:
        with open(path, encoding="utf8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and "ground_max_c" in d else None
