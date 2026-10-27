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

from .const import DEFAULT_DISCOVER_ROWS, DEFAULT_LIBRARY_TAB, DISCOVER_ROWS, LIBRARY_TABS

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
HOME_ROW_ITEMS = 20
PLAYABLE_TYPES = {"artist", "album", "track", "playlist", "radio", "podcast", "podcast_episode", "audiobook", "genre"}
# what opens a list instead of playing at once (Library; Discover plays everything at once)
CONTAINER_TYPES = {"artist", "album", "playlist", "podcast", "genre"}
SEARCH_TYPES = ["artist", "album", "track", "playlist", "radio", "podcast", "audiobook"]
QUEUE_OPTIONS = {"play", "replace", "next", "replace_next", "add"}
# bus task 031: plain orders for the voice API's pickers (MA's order_by values; default = favourites first + sort_name)
LIST_ORDERS = ["random", "sort_name", "sort_name_desc", "timestamp_added_desc", "year", "random_play_count"]
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
    that MA has a provider for, the tab it opens on, whether Discover has its key and Discover's rows."""
    have = available_tabs(mass)
    chosen = media.get("library_tabs") or list(LIBRARY_TABS)
    tabs = [t for t in LIBRARY_TABS if t in chosen and t in have]
    tab = media.get("library_tab") or DEFAULT_LIBRARY_TAB
    return {
        "tabs": tabs,
        "tab": tab if tab in tabs else (tabs[0] if tabs else None),
        "discover_key": bool(media.get("discover_key", True)),
        # bus task 029: Discover's rows (media.discover_rows), handed back to library_home as `sections`
        "discover_rows": discover_sections(media.get("discover_rows")),
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
        # bus task 031: plain fields for the app's voice API (pickers, Assist): an album's year, the artist names of an
        # album / track and a track's album name
        "year": item.get("year") if mt == "album" and isinstance(item.get("year"), int) else None,
        "artist": _names(item.get("artists")) if mt in ("album", "track") else None,
        "album": _names(item.get("album")) if mt == "track" else None,
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

# Bus task 029: Discover = the rows of media.discover_rows (const.DISCOVER_ROWS order). The library rows are built here
# with the same MA queries MA's Library Recommendations provider uses (which stops at 10 items), so a row holds up to
# `limit` (20) items; the other recommendation rows (Last.fm, MusicBrainz, ...) come as MA returns them.
RECENT_TYPES = ["album", "track", "playlist", "artist", "genre"]
_LIB = "library_items"
# row id -> (MA command, arguments without the limit); the rows MA's Library Recommendations provider has
LIBRARY_ROW_QUERIES: dict[str, tuple[str, dict[str, Any]]] = {
    "recently_added_tracks": (f"music/tracks/{_LIB}", {"order_by": "timestamp_added_desc"}),
    "recently_added_albums": (f"music/albums/{_LIB}", {"order_by": "timestamp_added_desc"}),
    "random_artists": (f"music/artists/{_LIB}", {"order_by": "random_play_count"}),
    "random_albums": (f"music/albums/{_LIB}", {"order_by": "random_play_count"}),
    "recent_favorite_tracks": (f"music/tracks/{_LIB}", {"favorite": True, "order_by": "timestamp_modified_desc"}),
    "favorite_playlists": (f"music/playlists/{_LIB}", {"favorite": True, "order_by": "random"}),
    "favorite_radio": (f"music/radios/{_LIB}", {"favorite": True, "order_by": "play_count_desc"}),
    "recent_artists": ("music/recently_played_items", {"media_types": ["artist"], "user_initiated_only": False}),
    "recent_tracks": ("music/recently_played_items", {"media_types": ["track"], "user_initiated_only": False}),
    "forgotten_tracks": (f"music/tracks/{_LIB}", {"order_by": "last_played", "played_only": True}),
    "forgotten_albums": (f"music/albums/{_LIB}", {"order_by": "last_played", "played_only": True}),
    "forgotten_artists": (f"music/artists/{_LIB}", {"order_by": "last_played", "played_only": True}),
    "most_played_tracks": (f"music/tracks/{_LIB}", {"order_by": "play_count_desc"}),
    "never_played_tracks": (f"music/tracks/{_LIB}", {"order_by": "play_count"}),
    # MA has no Home row for these two: favourite albums / artists from the library (MA's default sort)
    "favorite_albums": (f"music/albums/{_LIB}", {"favorite": True}),
    "favorite_artists": (f"music/artists/{_LIB}", {"favorite": True}),
}
# the panel's own rows (section id = row id) and their names (the app translates known ids)
OWN_ROWS = {
    "recently_played": "Recently played",
    "favorite_playlists": "Favorite playlists",
    "favorite_albums": "Favorite albums",
    "favorite_artists": "Favorite artists",
    "favorite_radio": "Favorite Radio stations",
    "recently_added_albums": "Recently added albums",
    "random_albums": "Random albums",
}
# MA rows that are not "recommendations": the panel's own rows and the podcast / audiobook rows
IN_PROGRESS = "in_progress"
PODCAST_TYPES = {"podcast", "podcast_episode"}
AUDIOBOOK_TYPES = {"audiobook"}
MIN_ROW_ITEMS = 2


def discover_sections(sections: list[str] | None) -> list[str]:
    """The asked rows in Discover's fixed order; none asked = the default (everything but podcasts / audiobooks)."""
    want = set(sections) if sections else set(DEFAULT_DISCOVER_ROWS)
    return [s for s in DISCOVER_ROWS if s in want]


def _is_podcast_row(r: dict[str, Any]) -> bool:
    return "podcast" in str(r.get("provider") or "") or "podcast" in str(r.get("item_id") or "")


async def home(mass: Any, limit: int = HOME_ROW_ITEMS, sections: list[str] | None = None) -> dict[str, Any]:
    """Discover's rows in the asked order (`sections`, see const.DISCOVER_ROWS), each with up to `limit` items; rows
    with fewer than 2 items are left out. Podcast / audiobook items appear only when podcasts / audiobooks are asked."""
    base, schema = _server(mass)
    wanted = discover_sections(sections)
    podcasts, audiobooks = "podcasts" in wanted, "audiobooks" in wanted
    hidden = (set() if podcasts else PODCAST_TYPES) | (set() if audiobooks else AUDIOBOOK_TYPES)

    async def safe(cmd: str, **kw: Any) -> list[dict[str, Any]]:
        try:
            return [i for i in (await mass.send_command(cmd, **kw) or []) if isinstance(i, dict)]
        except Exception:  # noqa: BLE001 - one row failing never hides the others (MA does the same)
            return []

    ma_rows: list[dict[str, Any]] = []
    if "recommendations" in wanted or podcasts or audiobooks:
        ma_rows = await safe("music/recommendations")

    # the plan: (row id, provider, name, coroutine) in Discover's order
    plan: list[tuple[str, str | None, str | None, Any]] = []
    for sec in wanted:
        if sec == "recently_played":
            extra = [t for t, on in (("podcast", podcasts), ("audiobook", audiobooks)) if on]
            kw: dict[str, Any] = {"limit": limit, "media_types": RECENT_TYPES, "user_initiated_only": True}
            if extra:
                kw["always_include_media_types"] = extra
            plan.append((sec, "library", OWN_ROWS[sec], safe("music/recently_played_items", **kw)))
        elif sec in OWN_ROWS:
            cmd, kw = LIBRARY_ROW_QUERIES[sec]
            plan.append((sec, "library", OWN_ROWS[sec], safe(cmd, limit=limit, offset=0, **kw)))
        elif sec == "recommendations":
            for r in ma_rows:
                rid = str(r.get("item_id") or "")
                if rid in OWN_ROWS or rid == IN_PROGRESS or _is_podcast_row(r):
                    continue
                if r.get("provider") == "recommendations" and rid in LIBRARY_ROW_QUERIES:
                    cmd, kw = LIBRARY_ROW_QUERIES[rid]
                    if cmd.endswith(_LIB):
                        kw = {**kw, "offset": 0}
                    coro = safe(cmd, limit=limit, **kw)
                else:
                    coro = safe("music/recommendations/items", provider=r.get("provider"), item_id=rid)
                plan.append((rid, r.get("provider"), r.get("name"), coro))
        elif sec == "podcasts":
            for r in ma_rows:
                if _is_podcast_row(r) or (str(r.get("item_id")) == IN_PROGRESS):
                    rid = str(r.get("item_id"))
                    coro = (
                        safe("music/in_progress_items", limit=limit)
                        if rid == IN_PROGRESS
                        else safe("music/recommendations/items", provider=r.get("provider"), item_id=rid)
                    )
                    plan.append((rid, r.get("provider"), r.get("name"), coro))
        elif sec == "audiobooks" and not podcasts:
            # "In progress" holds podcasts and audiobooks; with podcasts asked it is already in the plan
            r = next((x for x in ma_rows if str(x.get("item_id")) == IN_PROGRESS), None)
            if r is not None:
                plan.append(
                    (IN_PROGRESS, r.get("provider"), r.get("name"), safe("music/in_progress_items", limit=limit))
                )

    got = await asyncio.gather(*(coro for *_, coro in plan))
    rows_out = []
    seen: set[str] = set()
    for (rid, provider, name, _), items in zip(plan, got, strict=True):
        if rid in seen:
            continue
        seen.add(rid)
        views = [v for v in _views(items, base, schema) if v["media_type"] not in hidden][:limit]
        if len(views) >= MIN_ROW_ITEMS:
            rows_out.append({"id": rid, "provider": provider, "name": name, "items": views})
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
    order_by: str | None = None,
    album_artists_only: bool = False,
) -> dict[str, Any]:
    """One page of a library tab (favourites first, MA's default sort) or of what a parent opens (an artist's albums,
    an album's / playlist's tracks, a podcast's episodes, a genre's albums). `order_by` (bus task 031, the voice API's
    pickers) = one plain MA order (e.g. random) over the whole tab instead of favourites first; `album_artists_only`
    = the Artists tab without track-only artists (MA's own filter)."""
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
    if album_artists_only and section == "artists":
        q["album_artists_only"] = True
    if order_by:
        if order_by not in LIST_ORDERS:
            raise ValueError(f"unknown order {order_by!r}")
        items, total = await asyncio.gather(
            _items(mass, api, favorite=favorite, limit=limit, offset=offset, order_by=order_by, **q),
            mass.send_command(
                f"music/{api}/count",
                favorite_only=bool(favorite),
                **({"album_artists_only": True} if q.get("album_artists_only") else {}),
            ),
        )
        return {
            "section": section,
            "parent": None,
            "total": int(total or 0) if not search else offset + len(items) + (1 if len(items) == limit else 0),
            "offset": offset,
            "favorites": 0,
            "items": _views(items, base, schema),
        }
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
