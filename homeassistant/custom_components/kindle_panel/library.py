"""Bus task 027: the Kindle's library is a Music Assistant client.

Thin wrappers over Music Assistant's own API (the client the music_assistant integration holds), so the panel shows
what the MA app shows: Discover = MA's Home rows (`music/recommendations` + `music/recommendations/items`), the
library tabs = MA's sidebar sections (`music/<type>s/library_items`, favourites first, MA's default sort), genres
(`music/genres/library_items`, a genre opens `music/genres/albums`), search (`music/search`), play (`player_queues/
play_media` with MA's queue options) and the heart (`music/favorites/add_item` / `remove_item`).

Everything works on MA's plain JSON (send_command answers), so the panel needs no MA model classes. Images always go
through MA's image proxy (`/imageproxy`), so a panel that only reaches Home Assistant gets them through
`/api/kindle_panel/ma_image`.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import quote

from .const import DEFAULT_LIBRARY_TAB, LIBRARY_TABS

# tab -> MA media type / API base
TAB_MEDIA_TYPE = {
    "artists": "artist",
    "albums": "album",
    "tracks": "track",
    "playlists": "playlist",
    "radio": "radio",
    "podcasts": "podcast",
    "audiobooks": "audiobook",
    "genres": "genre",
}
API_BASE = {mt: f"{mt}s" for mt in TAB_MEDIA_TYPE.values()}
# provider features that make a tab real (MA's sidebar shows a section only with a provider for it)
TAB_FEATURES = {
    "artists": {"library_artists"},
    "albums": {"library_albums"},
    "tracks": {"library_tracks"},
    "playlists": {"library_playlists"},
    "radio": {"library_radios"},
    "podcasts": {"library_podcasts"},
    "audiobooks": {"library_audiobooks"},
    "search": {"search"},
}
# MA Home rows the Kindle's Discover keeps besides MA's enabled-by-default rows: the favourites rows (the owner asked
# for favourite playlists / radio); empty rows are dropped
FAVOURITE_ROWS = {"favorite_playlists", "favorite_radio", "recent_favorite_tracks"}
# rows the panel adds (MA has no Home row for them): favourite artists / albums from the library
SYNTHETIC_ROWS = (("favorite_artists", "Favorite artists", "artists"), ("favorite_albums", "Favorite albums", "albums"))
HOME_ROW_ITEMS = 20
PLAYABLE_TYPES = {"artist", "album", "track", "playlist", "radio", "podcast", "podcast_episode", "audiobook", "genre"}
# what opens a list instead of playing at once (Library; Discover plays everything at once)
CONTAINER_TYPES = {"artist", "album", "playlist", "podcast", "genre"}
SEARCH_TYPES = ["artist", "album", "track", "playlist", "radio", "podcast", "audiobook"]
QUEUE_OPTIONS = {"play", "replace", "next", "replace_next", "add"}
IMAGE_SIZE = 256
CHILD_CACHE_S = 120.0
GENRE_CACHE_S = 300.0


def _feature_names(p: Any) -> set[str]:
    return {str(getattr(f, "value", f)) for f in (getattr(p, "supported_features", None) or [])}


def available_tabs(mass: Any | None) -> list[str]:
    """The tabs Music Assistant has a provider for, in the owner's order. Genres are MA's own (always there when MA
    has a music library). Without MA: every tab (the panel shows MA's error on use)."""
    if mass is None:
        return list(LIBRARY_TABS)
    feats: set[str] = set()
    for p in getattr(mass, "providers", None) or []:
        if getattr(p, "available", True) is False:
            continue
        feats |= _feature_names(p)
    out = []
    for tab in LIBRARY_TABS:
        if tab == "genres":
            if feats & (TAB_FEATURES["artists"] | TAB_FEATURES["albums"] | TAB_FEATURES["tracks"]):
                out.append(tab)
        elif feats & TAB_FEATURES[tab]:
            out.append(tab)
    return out


def library_view(media: dict[str, Any], mass: Any | None) -> dict[str, Any]:
    """What get_config answers for the panel's library: the tabs the owner chose (media.library_tabs, owner's order)
    that MA has a provider for, the tab it opens on and whether Discover has its key."""
    have = available_tabs(mass)
    chosen = media.get("library_tabs") or list(LIBRARY_TABS)
    tabs = [t for t in LIBRARY_TABS if t in chosen and t in have]
    tab = media.get("library_tab") or DEFAULT_LIBRARY_TAB
    return {
        "tabs": tabs,
        "tab": tab if tab in tabs else (tabs[0] if tabs else None),
        "discover_key": bool(media.get("discover_key", True)),
        "missing": [t for t in LIBRARY_TABS if t in chosen and t not in have],
    }


def parse_uri(uri: str) -> tuple[str, str, str]:
    """`provider://type/item_id` -> (provider, media_type, item_id)."""
    if "://" not in uri:
        raise ValueError(f"not a Music Assistant uri: {uri!r}")
    provider, rest = uri.split("://", 1)
    media_type, _, item_id = rest.partition("/")
    if not provider or not media_type or not item_id:
        raise ValueError(f"not a Music Assistant uri: {uri!r}")
    return provider, media_type, item_id


def _thumb(item: dict[str, Any]) -> dict[str, Any] | None:
    images = ((item.get("metadata") or {}).get("images")) or []
    for img in images:
        if img.get("type") == "thumb" and img.get("path"):
            return img
    img = item.get("image")
    return img if isinstance(img, dict) and img.get("path") else None


def proxy_image_url(
    base_url: str | None, schema: int | None, item: dict[str, Any], size: int = IMAGE_SIZE
) -> str | None:
    """MA's image proxy URL for an item's thumb, also for images MA marks remotely accessible (a radio logo on a
    CDN): the panel can only fetch MA's /imageproxy (through HA)."""
    img = _thumb(item)
    if img is None or not base_url:
        return None
    base = base_url.rstrip("/")
    if img.get("proxy_id") and (schema or 0) >= 31:
        return f"{base}/imageproxy/{img['proxy_id']}?size={size}"
    path = quote(quote(str(img["path"]), safe=""), safe="")
    return f"{base}/imageproxy?path={path}&provider={quote(str(img.get('provider') or ''))}&size={size}"


def _names(v: Any) -> str | None:
    if not v:
        return None
    if isinstance(v, list):
        names = [x.get("name") if isinstance(x, dict) else str(x) for x in v]
        return ", ".join(n for n in names if n) or None
    return v.get("name") if isinstance(v, dict) else str(v)


def _sub(item: dict[str, Any]) -> str | None:
    """The row's second line, as the MA app shows it under the name."""
    mt = item.get("media_type")
    if mt == "album":
        parts = [_names(item.get("artists")), str(item["year"]) if item.get("year") else None]
    elif mt == "track":
        parts = [_names(item.get("artists")), _names(item.get("album"))]
    elif mt == "playlist":
        parts = [item.get("owner")]
    elif mt in ("podcast", "audiobook"):
        parts = [item.get("publisher") or _names(item.get("authors"))]
    elif mt == "podcast_episode":
        parts = [_names(item.get("podcast"))]
    else:
        parts = []
    return " · ".join(str(p) for p in parts if p) or None


def item_view(item: dict[str, Any], base_url: str | None = None, schema: int | None = None) -> dict[str, Any] | None:
    """One MA item as the panel lists it; None for what the panel cannot list (folders, unknown types)."""
    mt = item.get("media_type")
    uri = item.get("uri")
    if mt not in PLAYABLE_TYPES or not uri:
        return None
    provider = item.get("provider")
    duration = item.get("duration")
    return {
        "uri": uri,
        "media_type": mt,
        "name": item.get("name") or "",
        "sub": _sub(item),
        "item_id": str(item.get("item_id") or ""),
        "provider": provider,
        "in_library": provider == "library",
        # None = not known (an ItemMapping); MA's library items carry it
        "favorite": item.get("favorite") if isinstance(item.get("favorite"), bool) else None,
        "duration": duration if isinstance(duration, int | float) and duration > 0 else None,
        "image": proxy_image_url(base_url, schema, item),
        "opens": mt in CONTAINER_TYPES,
        # a track's album (MA plays a track within its album when it is opened from there)
        "album_uri": (item.get("album") or {}).get("uri")
        if mt == "track" and isinstance(item.get("album"), dict)
        else None,
    }


def _views(items: list[dict[str, Any]], base: str | None, schema: int | None) -> list[dict[str, Any]]:
    return [v for v in (item_view(i, base, schema) for i in items if isinstance(i, dict)) if v]


def _server(mass: Any) -> tuple[str | None, int | None]:
    info = getattr(mass, "server_info", None)
    return getattr(info, "base_url", None), getattr(info, "schema_version", None)


class LibraryCache:
    """Short-lived caches: a parent's children (paged by the panel 8 at a time) and the genre list."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[float, Any]] = {}

    def get(self, key: str, ttl: float) -> Any | None:
        hit = self._data.get(key)
        return hit[1] if hit and time.monotonic() - hit[0] < ttl else None

    def put(self, key: str, value: Any) -> Any:
        self._data[key] = (time.monotonic(), value)
        if len(self._data) > 64:
            oldest = sorted(self._data, key=lambda k: self._data[k][0])[:16]
            for k in oldest:
                self._data.pop(k, None)
        return value

    def clear(self) -> None:
        self._data.clear()


# ---------------------------------------------------------------- Discover (MA's Home)


async def home(mass: Any, limit: int = HOME_ROW_ITEMS) -> dict[str, Any]:
    """MA's Home rows in MA's order: the rows MA shows by default plus the favourites rows (and favourite artists /
    albums, which MA has no row for), each with its items; empty rows are left out."""
    base, schema = _server(mass)
    rows = [r for r in (await mass.send_command("music/recommendations") or []) if isinstance(r, dict)]
    keep = [r for r in rows if r.get("enabled_by_default") or r.get("item_id") in FAVOURITE_ROWS]

    async def items_of(r: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            return list(
                await mass.send_command(
                    "music/recommendations/items", provider=r.get("provider"), item_id=r.get("item_id")
                )
                or []
            )
        except Exception:  # noqa: BLE001 - one row failing never hides the others (MA does the same)
            return []

    async def favourites(tab: str) -> list[dict[str, Any]]:
        try:
            return list(
                await mass.send_command(
                    f"music/{API_BASE[TAB_MEDIA_TYPE[tab]]}/library_items", favorite=True, limit=limit, offset=0
                )
                or []
            )
        except Exception:  # noqa: BLE001
            return []

    got = await asyncio.gather(*(items_of(r) for r in keep), *(favourites(tab) for _, _, tab in SYNTHETIC_ROWS))
    out: list[dict[str, Any]] = []
    for r, items in zip(keep, got[: len(keep)], strict=True):
        out.append({"id": str(r.get("item_id")), "provider": r.get("provider"), "name": r.get("name"), "items": items})
    synthetic = [
        {"id": rid, "provider": "library", "name": name, "items": items}
        for (rid, name, _), items in zip(SYNTHETIC_ROWS, got[len(keep) :], strict=True)
    ]
    # the synthetic favourites go right after "Recently played" (else first), like the MA app's favourites rows
    at = next((i + 1 for i, r in enumerate(out) if r["id"] == "recently_played"), 0)
    out[at:at] = synthetic
    rows_out = []
    for r in out:
        views = _views(r["items"], base, schema)[:limit]
        if views:
            rows_out.append({"id": r["id"], "provider": r["provider"], "name": r["name"], "items": views})
    return {"rows": rows_out}


# ---------------------------------------------------------------- library lists


async def _count(mass: Any, api: str, favorite_only: bool) -> int:
    n = await mass.send_command(f"music/{api}/count", favorite_only=favorite_only)
    return int(n or 0)


async def _items(mass: Any, api: str, **kw: Any) -> list[dict[str, Any]]:
    return list(await mass.send_command(f"music/{api}/library_items", **kw) or [])


async def _genres(mass: Any, cache: LibraryCache) -> list[dict[str, Any]]:
    hit = cache.get("genres", GENRE_CACHE_S)
    if hit is not None:
        return hit
    # hide_empty: genres that have music mapped to them (MA's genre page shows the same)
    return cache.put(
        "genres",
        list(await mass.send_command("music/genres/library_items", hide_empty=True, limit=500, offset=0) or []),
    )


async def _children(mass: Any, parent: str, cache: LibraryCache) -> list[dict[str, Any]]:
    hit = cache.get(f"children:{parent}", CHILD_CACHE_S)
    if hit is not None:
        return hit
    provider, mt, item_id = parse_uri(parent)
    ident = {"item_id": item_id, "provider_instance_id_or_domain": provider}
    if mt == "artist":
        items = await mass.send_command("music/artists/artist_albums", in_library_only=False, **ident)
    elif mt == "album":
        items = await mass.send_command("music/albums/album_tracks", in_library_only=False, **ident)
    elif mt == "playlist":
        items = await mass.send_command("music/playlists/playlist_tracks", **ident)
    elif mt == "podcast":
        items = await mass.send_command("music/podcasts/podcast_episodes", **ident)
    elif mt == "genre":
        # a genre opens its albums (MA's genre page; music/genres/albums, the genre's library id)
        items = await mass.send_command("music/genres/albums", item_id=item_id, limit=0, offset=0)
    else:
        raise ValueError(f"{mt} has no list to open")
    return cache.put(f"children:{parent}", list(items or []))


async def item_by_uri(mass: Any, uri: str) -> dict[str, Any] | None:
    try:
        r = await mass.send_command("music/item_by_uri", uri=uri)
    except Exception:  # noqa: BLE001 - the header is optional
        return None
    return r if isinstance(r, dict) else None


async def library_list(
    mass: Any,
    cache: LibraryCache,
    *,
    section: str | None,
    parent: str | None = None,
    favorite: bool | None = None,
    search: str | None = None,
    offset: int = 0,
    limit: int = 8,
) -> dict[str, Any]:
    """One page of a library tab (favourites first, MA's default sort) or of what a parent opens (an artist's albums,
    an album's / playlist's tracks, a podcast's episodes, a genre's albums)."""
    base, schema = _server(mass)
    if parent:
        items = await _children(mass, parent, cache)
        head = await item_by_uri(mass, parent)
        page = items[offset : offset + limit]
        return {
            "section": section,
            "parent": item_view(head, base, schema) if head else None,
            "total": len(items),
            "offset": offset,
            "favorites": 0,
            "items": _views(page, base, schema),
        }
    if section not in TAB_MEDIA_TYPE:
        raise ValueError(f"unknown library section {section!r}")
    if section == "genres":
        genres = await _genres(mass, cache)
        if search:
            genres = [g for g in genres if search.lower() in str(g.get("name") or "").lower()]
        return {
            "section": section,
            "parent": None,
            "total": len(genres),
            "offset": offset,
            "favorites": 0,
            "items": _views(genres[offset : offset + limit], base, schema),
        }
    api = API_BASE[TAB_MEDIA_TYPE[section]]
    q: dict[str, Any] = {"search": search} if search else {}
    if favorite is not None or search:
        # only favourites (or only the rest), or a filter: MA's own paging
        items = await _items(mass, api, favorite=favorite, limit=limit, offset=offset, **q)
        total = (
            await _count(mass, api, bool(favorite))
            if not search
            else offset + len(items) + (1 if len(items) == limit else 0)
        )
        return {
            "section": section,
            "parent": None,
            "total": total,
            "offset": offset,
            "favorites": 0,
            "items": _views(items, base, schema),
        }
    # favourites first, then the rest, both in MA's default sort: two MA lists glued at the favourites count
    favs, total = await asyncio.gather(_count(mass, api, True), _count(mass, api, False))
    page: list[dict[str, Any]] = []
    if offset < favs:
        page = await _items(mass, api, favorite=True, limit=min(limit, favs - offset), offset=offset)
    if len(page) < limit:
        rest_offset = max(0, offset - favs)
        page += await _items(mass, api, favorite=False, limit=limit - len(page), offset=rest_offset)
    return {
        "section": section,
        "parent": None,
        "total": total,
        "offset": offset,
        "favorites": favs,
        "items": _views(page, base, schema),
    }


async def search(mass: Any, query: str, media_types: list[str] | None = None, limit: int = 6) -> dict[str, Any]:
    """MA's search over every media type (or the given ones), as one list in MA's section order."""
    base, schema = _server(mass)
    types = [t for t in (media_types or SEARCH_TYPES) if t in SEARCH_TYPES]
    r = await mass.send_command("music/search", search_query=query, media_types=types, limit=limit) or {}
    keys = {"artist": "artists", "album": "albums", "track": "tracks", "playlist": "playlists", "radio": "radio",
            "podcast": "podcasts", "audiobook": "audiobooks"}  # fmt: skip
    items: list[dict[str, Any]] = []
    for t in types:
        items += list(r.get(keys[t]) or [])[:limit]
    return {"query": query, "items": _views(items, base, schema)}


# ---------------------------------------------------------------- favourites


async def set_favorite(mass: Any, uri: str, favorite: bool) -> dict[str, Any]:
    """The heart: add (MA adds the item to the library first) or remove (by its library id)."""
    provider, mt, item_id = parse_uri(uri)
    if favorite:
        await mass.send_command("music/favorites/add_item", item=uri)
        return {"ok": True, "uri": uri, "favorite": True}
    lib_id = item_id if provider == "library" else None
    if lib_id is None:
        lib = await mass.send_command(
            "music/get_library_item", media_type=mt, item_id=item_id, provider_instance_id_or_domain=provider
        )
        lib_id = str(lib.get("item_id")) if isinstance(lib, dict) and lib.get("item_id") is not None else None
    if lib_id is None:
        return {"ok": True, "uri": uri, "favorite": False}  # not in the library: not a favourite either
    await mass.send_command("music/favorites/remove_item", media_type=mt, library_item_id=lib_id)
    return {"ok": True, "uri": uri, "favorite": False}
