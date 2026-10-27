// Bus task 027: the library through Home Assistant: kindle_panel's library_* services are thin wrappers over Music
// Assistant (Discover = MA's Home rows, tabs = MA's library sections, search, play with MA's queue options, the heart).
// Covers come back as MA image proxy URLs and become "ma:" tokens for /media/img (fetched through HA).
import { HomeError, ha } from "./home.server";
import { artToken, forgetMusicState } from "./media-ha.server";
import type {
  DiscoverRow,
  LibHomeResult,
  LibItem,
  LibListResult,
  LibMediaType,
  LibPlayOption,
  LibPlayResult,
  LibSearchResult,
  LibraryTab,
} from "./library";
import { LIBRARY_PAGE_SIZE } from "./library";

/** kindle_panel's item (library.py item_view). */
export type PanelLibItem = {
  uri: string;
  media_type: LibMediaType;
  name: string;
  sub?: string | null;
  item_id?: string;
  provider?: string | null;
  in_library?: boolean;
  favorite?: boolean | null;
  duration?: number | null;
  image?: string | null;
  opens?: boolean;
  album_uri?: string | null;
  /** kindle_panel >= 0.12.0: an album's year, an album's / track's artists, a track's album. */
  year?: number | null;
  artist?: string | null;
  album?: string | null;
};

/** The second line of a row. The provider name ("Music Assistant" under every playlist) says nothing: dropped. */
const libSub = (i: PanelLibItem): string | null => {
  const sub = (i.sub ?? "").trim();
  if (!sub) return null;
  const generic = sub.toLowerCase() === "music assistant" || sub === (i.provider ?? "").trim();
  return generic ? null : sub;
};

export const libItemFrom = (i: PanelLibItem): LibItem => ({
  uri: i.uri,
  mediaType: i.media_type,
  name: i.name ?? "",
  sub: libSub(i),
  favorite: typeof i.favorite === "boolean" ? i.favorite : null,
  opens: !!i.opens,
  art: artToken([], i.image ?? null),
  inLibrary: !!i.in_library,
  durationS: typeof i.duration === "number" && i.duration > 0 ? i.duration : null,
  albumUri: i.album_uri ?? null,
});

async function panelService<T>(
  name: string,
  data: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<T> {
  const r = await ha<{ service_response?: T }>(
    "POST",
    `/api/services/kindle_panel/${name}?return_response`,
    data,
    timeoutMs,
  );
  if (r.service_response === undefined) throw new HomeError(`kindle_panel.${name} gave no answer`);
  return r.service_response;
}

/** HA answers 400 for an unknown service or field (kindle_panel < 0.12.0) or a refused call. */
const errorText = (e: unknown) =>
  e instanceof HomeError && e.status === 400
    ? "kindle_panel 0.12.0 needed (or Music Assistant refused)"
    : e instanceof Error
      ? e.message
      : String(e);

/** Discover's rows; `sections` = the panel's media.discover_rows (bus task 029), left out = the panel's default. */
export async function readLibraryHome(sections?: DiscoverRow[]): Promise<LibHomeResult> {
  try {
    const r = await panelService<{ rows: { id: string; name: string; items: PanelLibItem[] }[] }>(
      "library_home",
      sections?.length ? { sections } : {},
    );
    return {
      ok: true,
      rows: (r.rows ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        items: row.items.map(libItemFrom),
      })),
    };
  } catch (e) {
    return { ok: false, error: errorText(e), rows: [] };
  }
}

export async function readLibraryList(q: {
  section?: Exclude<LibraryTab, "search"> | undefined;
  parent?: string | undefined;
  favorite?: boolean | undefined;
  offset: number;
  limit?: number | undefined;
}): Promise<LibListResult> {
  try {
    const r = await panelService<{
      total: number;
      offset: number;
      favorites?: number;
      parent?: PanelLibItem | null;
      items: PanelLibItem[];
    }>("library_list", {
      ...(q.parent ? { parent: q.parent } : { section: q.section }),
      ...(q.favorite === undefined ? {} : { favorite: q.favorite }),
      offset: q.offset,
      limit: q.limit ?? LIBRARY_PAGE_SIZE,
    });
    return {
      ok: true,
      total: r.total ?? 0,
      offset: r.offset ?? q.offset,
      favorites: r.favorites ?? 0,
      parent: r.parent ? libItemFrom(r.parent) : null,
      items: (r.items ?? []).map(libItemFrom),
    };
  } catch (e) {
    return {
      ok: false,
      error: errorText(e),
      total: 0,
      offset: q.offset,
      favorites: 0,
      parent: null,
      items: [],
    };
  }
}

// ---- Bus task 031: the voice API (/api/voice/search|list) reads Music Assistant through the same services ----
/** One page of MA items as kindle_panel answers them (raw: the voice API keeps uri, year and MA's image URL). */
export async function panelLibraryList(q: {
  section?: Exclude<LibraryTab, "search"> | undefined;
  parent?: string | undefined;
  offset?: number | undefined;
  limit: number;
  orderBy?: "random" | "sort_name" | undefined;
  albumArtistsOnly?: boolean | undefined;
  search?: string | undefined;
}): Promise<{ total: number; items: PanelLibItem[] }> {
  const r = await panelService<{ total: number; items: PanelLibItem[] }>("library_list", {
    ...(q.parent ? { parent: q.parent } : { section: q.section }),
    offset: q.offset ?? 0,
    limit: q.limit,
    ...(q.orderBy ? { order_by: q.orderBy } : {}),
    ...(q.albumArtistsOnly ? { album_artists_only: true } : {}),
    ...(q.search ? { search: q.search } : {}),
  });
  return { total: r.total ?? 0, items: r.items ?? [] };
}
export async function panelLibrarySearch(
  query: string,
  mediaTypes: LibMediaType[],
  limit: number,
): Promise<PanelLibItem[]> {
  const r = await panelService<{ items: PanelLibItem[] }>("library_search", {
    query,
    media_types: mediaTypes,
    limit,
  });
  return r.items ?? [];
}

export async function searchLibrary(query: string): Promise<LibSearchResult> {
  try {
    const r = await panelService<{ items: PanelLibItem[] }>("library_search", { query, limit: 6 });
    return { ok: true, query, items: (r.items ?? []).map(libItemFrom) };
  } catch (e) {
    return { ok: false, error: errorText(e), query, items: [] };
  }
}

/** Plays on the panel's player (kindle_panel's stored output); play now wakes its receiver first. */
export async function playLibraryItem(p: {
  uri: string;
  option: LibPlayOption;
  startItem?: string | undefined;
}): Promise<LibPlayResult> {
  try {
    const r = await panelService<{ ok: boolean; status?: LibPlayResult["status"]; error?: string }>(
      "library_play",
      { uri: p.uri, option: p.option, ...(p.startItem ? { start_item: p.startItem } : {}) },
      30_000,
    );
    forgetMusicState();
    return r.ok
      ? { ok: true, ...(r.status ? { status: r.status } : {}) }
      : { ok: false, error: r.error ?? "refused" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function favouriteLibraryItem(
  uri: string,
  favorite: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await panelService("library_favorite", { uri, favorite });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
