"""Screensaver photos: sources from Home Assistant, the panel's keep/skip marks, the pick.

Sources:
* `immich_favorites`: the favourites of every Immich account set up in HA (HA's own Immich connection).
* `media_source`: any folder of HA's media browser (an Immich album / person / tag, local media, Synology,
  Google Photos, …): its images, one level deep.

Marks (F1 on the panel = keep: looks good on e-ink; F4 = skip: never again) live here, in HA, keyed by a stable
photo id: the Immich asset id for Immich photos (the same photo in favourites and in an album is one photo), the
media-source id otherwise.

Pick modes:
* `curate` (default, as the panel always did): photos not judged yet first; once all are judged, the kept ones.
* `all_but_skipped`: everything except skipped.
* `kept_only`: only kept photos (falls back to unjudged ones while nothing is kept yet).
Skipped photos are never shown in any mode. Portrait photos are weighted up (the panel is portrait).
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from homeassistant.components import media_source
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, IMMICH_DOMAIN, SOURCE_IMMICH_FAVORITES, SOURCE_MEDIA

_LOGGER = logging.getLogger(__name__)
CANDIDATE_TTL = 600  # seconds a source listing is reused
PORTRAIT_WEIGHT = 3
MAX_PAGES = 8


@dataclass
class Photo:
    id: str
    url: str  # HA-relative URL the panel fetches with its HA token
    title: str
    source: str
    portrait: bool | None = None


class MarkStore:
    """kept / skipped photo ids with timestamps, persisted in .storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, 1, f"{DOMAIN}.photo_marks")
        self.kept: dict[str, str] = {}
        self.skipped: dict[str, str] = {}
        self.seeded = False

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.kept = dict(data.get("kept") or {})
        self.skipped = dict(data.get("skipped") or {})
        self.seeded = bool(data.get("seeded"))

    async def async_save(self) -> None:
        await self._store.async_save({"kept": self.kept, "skipped": self.skipped, "seeded": self.seeded})

    def mark(self, photo_id: str, verdict: str) -> None:
        now = datetime.now(UTC).isoformat()
        self.kept.pop(photo_id, None)
        self.skipped.pop(photo_id, None)
        if verdict == "keep":
            self.kept[photo_id] = now
        elif verdict == "skip":
            self.skipped[photo_id] = now

    def merge(self, kept: dict[str, str], skipped: dict[str, str]) -> tuple[int, int]:
        """Add marks from the panel's own history (seeding); existing decisions in HA win."""
        added_k = added_s = 0
        for pid, at in kept.items():
            if pid not in self.kept and pid not in self.skipped:
                self.kept[pid] = at
                added_k += 1
        for pid, at in skipped.items():
            if pid not in self.kept and pid not in self.skipped:
                self.skipped[pid] = at
                added_s += 1
        return added_k, added_s


def pick(
    candidates: list[Photo],
    marks: MarkStore,
    mode: str,
    previous: str | None,
    rnd: random.Random | None = None,
) -> Photo | None:
    rnd = rnd or random.Random()
    pool = [p for p in candidates if p.id not in marks.skipped]
    if not pool:
        return None
    unjudged = [p for p in pool if p.id not in marks.kept]
    kept = [p for p in pool if p.id in marks.kept]
    if mode == "kept_only":
        chosen = kept or unjudged
    elif mode == "all_but_skipped":
        chosen = pool
    else:  # curate
        chosen = unjudged or kept
    if len(chosen) > 1:
        chosen = [p for p in chosen if p.id != previous] or chosen
    weights = [PORTRAIT_WEIGHT if p.portrait else 1 for p in chosen]
    return rnd.choices(chosen, weights=weights, k=1)[0]


def _portrait(exif: dict[str, Any] | None) -> bool | None:
    if not exif:
        return None
    w, h = exif.get("exifImageWidth"), exif.get("exifImageHeight")
    if not w or not h:
        return None
    rotated = str(exif.get("orientation") or "") in ("5", "6", "7", "8")
    return (w < h) != rotated


class PhotoLibrary:
    """Lists candidates per source (cached) and resolves them."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._cache: dict[str, tuple[float, list[Photo]]] = {}
        self._immich_view_ready = False

    async def candidates(self, sources: list[dict[str, Any]]) -> list[Photo]:
        seen: dict[str, Photo] = {}
        for src in sources:
            for p in await self._source(src):
                seen.setdefault(p.id, p)
        return list(seen.values())

    async def _source(self, src: dict[str, Any]) -> list[Photo]:
        key = f"{src.get('type')}:{src.get('id', '')}"
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CANDIDATE_TTL:
            return hit[1]
        try:
            if src.get("type") == SOURCE_IMMICH_FAVORITES:
                photos = await self._immich_favorites()
            elif src.get("type") == SOURCE_MEDIA:
                photos = await self._media_folder(src["id"])
            else:
                photos = []
        except Exception:
            _LOGGER.warning("photo source %s failed", key, exc_info=True)
            photos = hit[1] if hit else []
        self._cache[key] = (time.monotonic(), photos)
        return photos

    async def _ensure_immich_view(self) -> None:
        """HA registers the `/immich/<uid>/<asset>/...` image view lazily, when its Immich media source is first
        instantiated (a browse). Until then every photo URL we hand out answers 404, e.g. after an HA restart. One
        cheap root browse per library instance makes the view exist."""
        if self._immich_view_ready:
            return
        try:
            await media_source.async_browse_media(self.hass, f"media-source://{IMMICH_DOMAIN}")
            self._immich_view_ready = True
        except Exception:  # noqa: BLE001 - a failed browse just means we try again next time
            _LOGGER.debug("immich media source not browsable yet", exc_info=True)

    async def _immich_favorites(self) -> list[Photo]:
        out: list[Photo] = []
        await self._ensure_immich_view()
        for entry in self.hass.config_entries.async_loaded_entries(IMMICH_DOMAIN):
            # aioimmich >= 0.16 (HA 2026.8) moved the raw request onto the `Immich.api` client; older versions
            # (HA 2026.2, the design sandbox) had it on the `Immich` object itself.
            client = entry.runtime_data.api
            api = getattr(client, "api", client)
            for page in range(1, MAX_PAGES + 1):
                res = await api.async_do_request(
                    "search/metadata",
                    data={"isFavorite": True, "type": "IMAGE", "size": 250, "page": page, "withExif": True},
                    method="POST",
                )
                assets = (res or {}).get("assets") or {}
                for a in assets.get("items") or []:
                    out.append(
                        Photo(
                            id=a["id"],
                            url=f"/immich/{entry.unique_id}/{a['id']}/preview/image/jpeg",
                            title=a.get("originalFileName") or a["id"],
                            source="Immich favourites",
                            portrait=_portrait(a.get("exifInfo")),
                        )
                    )
                if not assets.get("nextPage"):
                    break
        return out

    async def _media_folder(self, media_id: str) -> list[Photo]:
        folder = await media_source.async_browse_media(self.hass, media_id)
        out: list[Photo] = []
        for child in folder.children or []:
            ctype = child.media_content_type or ""
            if child.can_expand or not ctype.startswith("image/"):
                continue
            pid, url = self._immich_shortcut(child.media_content_id)
            out.append(
                Photo(
                    id=pid or child.media_content_id,
                    url=url or child.media_content_id,
                    title=child.title,
                    source=folder.title,
                )
            )
        return out

    @staticmethod
    def _immich_shortcut(content_id: str) -> tuple[str | None, str | None]:
        """media-source://immich/<uid>|<collection>|<id>|<asset>|<file>|<mime> -> asset id + preview URL."""
        prefix = f"media-source://{IMMICH_DOMAIN}/"
        if not content_id.startswith(prefix):
            return None, None
        parts = content_id[len(prefix) :].split("|")
        if len(parts) < 4:
            return None, None
        return parts[3], f"/immich/{parts[0]}/{parts[3]}/preview/image/jpeg"

    async def resolve(self, photo: Photo) -> str:
        """A URL the panel can GET from HA (bearer token)."""
        if photo.url.startswith("media-source://"):
            play = await media_source.async_resolve_media(self.hass, photo.url, None)
            return play.url
        return photo.url


# Only these media sources can hold photo folders worth offering. Everything else is skipped without a single
# browse: Radio Browser alone (252 countries, categories, languages) made the page take 393 s on the owner's HA, and
# tts / ai_task / camera / image entities are not photo libraries.
DISCOVER_DOMAINS = (IMMICH_DOMAIN, "media_source")
DISCOVER_BUDGET = 6.0  # seconds for the whole walk; the page opens with what was found by then
DISCOVER_MAX = 400


async def discover_sources(hass: HomeAssistant, budget: float = DISCOVER_BUDGET) -> dict[str, str]:
    """Selectable sources for the options UI: {key: label}. Walks only Immich and local media (image folders),
    three levels deep, within `budget` seconds."""
    found: dict[str, str] = {}
    if hass.config_entries.async_loaded_entries(IMMICH_DOMAIN):
        found[SOURCE_IMMICH_FAVORITES] = "Immich · Favourites"
    deadline = time.monotonic() + budget
    root = await _browse(hass, None, deadline)
    if root is None:
        return found
    for top in root.children or []:
        if _domain(top.media_content_id) in DISCOVER_DOMAINS:
            await _walk(hass, top, [top.title], found, 0, deadline)
    if time.monotonic() >= deadline:
        _LOGGER.info("photo source listing stopped after %.0f s with %d sources", budget, len(found))
    return found


def _domain(content_id: str | None) -> str:
    """media-source://<domain>/... -> <domain>"""
    rest = (content_id or "").removeprefix("media-source://")
    return rest.split("/", 1)[0]


async def _browse(hass: HomeAssistant, content_id: str | None, deadline: float) -> Any | None:
    left = deadline - time.monotonic()
    if left <= 0:
        return None
    try:
        return await asyncio.wait_for(media_source.async_browse_media(hass, content_id), left)
    except Exception:  # noqa: BLE001 - a folder that fails or times out is just not offered
        return None


async def _walk(
    hass: HomeAssistant, node: Any, path: list[str], found: dict[str, str], depth: int, deadline: float
) -> None:
    if not node.can_expand or depth > 3 or len(found) >= DISCOVER_MAX or time.monotonic() >= deadline:
        return
    cid = node.media_content_id or ""
    if cid.startswith(f"media-source://{IMMICH_DOMAIN}/") and cid.count("|") == 2:
        # an Immich album / person / tag: offer it without listing its photos (one API call per album otherwise)
        found[f"{SOURCE_MEDIA}:{cid}"] = " · ".join(path)
        return
    folder = await _browse(hass, node.media_content_id, deadline)
    if folder is None:
        return
    children = folder.children or []
    if any((c.media_content_type or "").startswith("image/") for c in children):
        found[f"{SOURCE_MEDIA}:{node.media_content_id}"] = " · ".join(path)
    for c in children:
        if c.can_expand:
            await _walk(hass, c, [*path, c.title], found, depth + 1, deadline)
