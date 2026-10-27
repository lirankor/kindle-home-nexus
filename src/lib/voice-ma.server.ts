// Bus task 031: the voice API's music reads from Music Assistant (MUSIC_BACKEND=ha) through kindle_panel's
// library_list / library_search: ids = MA uris (library://album/143), `art` = MA image proxy URLs (HA fetches them;
// the Kindle gets them through /media/img?item=). No zod here, so vitest can test it (src/lib/voice-ma.test.ts).
import { panelLibraryList, panelLibrarySearch } from "./library-ha.server";
import type { PanelLibItem } from "./library-ha.server";
import { MA_MIXES, matchScore } from "./voice-match";
import type { Candidate, VoiceKind } from "./voice-match";

/** Music Assistant's answer as voice candidates (MUSIC_BACKEND=ha): id = the MA uri, art = MA's image proxy URL. */
export const maCandidate = (i: PanelLibItem, query: string): Candidate | null => {
  const kind = i.media_type;
  if (kind !== "artist" && kind !== "album" && kind !== "track" && kind !== "playlist") return null;
  return {
    kind,
    id: i.uri,
    title: i.name,
    ...(kind === "album" || kind === "track" ? { artist: i.artist ?? null } : {}),
    ...(kind === "track" ? { album: i.album ?? null } : {}),
    ...(kind === "album" ? { year: i.year ?? null } : {}),
    art: i.image ?? null,
    score: matchScore(i.name, query),
  };
};
export async function maCandidates(query: string, kind: VoiceKind | "auto", limit: number) {
  const types =
    kind === "auto" || kind === "mix"
      ? (["artist", "album", "track", "playlist"] as const)
      : ([kind] as const);
  const items = await panelLibrarySearch(query, [...types], limit);
  return items.map((i) => maCandidate(i, query)).filter((c): c is Candidate => c !== null);
}
/** An MA artist's albums (uri), oldest first like the Jellyfin discography; MA has no per-album track count here. */
export async function maArtistAlbums(artistUri: string) {
  const { items } = await panelLibraryList({ parent: artistUri, limit: 200 });
  return items
    .filter((a) => a.media_type === "album")
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name))
    .map((a) => ({
      id: a.uri,
      title: a.name,
      year: a.year ?? null,
      tracks: null,
      art: a.image ?? null,
    }));
}
/** The mix playlists MA holds (the nightly ones of mixes.json), by name. */
export async function maMixPlaylists() {
  const { items } = await panelLibraryList({
    section: "playlists",
    limit: 200,
    orderBy: "sort_name",
  });
  return MA_MIXES.flatMap((m) => {
    const p = items.find((i) => i.media_type === "playlist" && i.name === m.name);
    return p ? [{ id: p.uri, mix: m.id, title: m.name, he: m.he, art: p.image ?? null }] : [];
  });
}

/** The pickers' lists from Music Assistant: album artists, albums, an artist's albums (by MA uri), the mixes. */
export async function maListData(
  kind: "artist" | "album" | "mix",
  sort: "name" | "random",
  limit: number,
  offset: number,
  artist: string | undefined,
) {
  if (kind === "mix") {
    const items = await maMixPlaylists();
    return { ok: true, kind, total: items.length, offset: 0, items };
  }
  if (kind === "album" && artist) {
    if (!artist.includes("://")) return { error: "artist must be a Music Assistant uri" };
    const items = await maArtistAlbums(artist);
    return { ok: true, kind, artist, total: items.length, offset: 0, items };
  }
  const orderBy = sort === "random" ? "random" : "sort_name";
  if (kind === "artist") {
    const page = await panelLibraryList({
      section: "artists",
      albumArtistsOnly: true,
      orderBy,
      limit,
      offset,
    });
    return {
      ok: true,
      kind,
      sort,
      offset,
      total: page.total,
      items: page.items.map((a) => ({ id: a.uri, name: a.name, art: a.image ?? null })),
    };
  }
  const page = await panelLibraryList({ section: "albums", orderBy, limit, offset });
  return {
    ok: true,
    kind,
    sort,
    offset,
    total: page.total,
    items: page.items.map((a) => ({
      id: a.uri,
      title: a.name,
      artist: a.artist ?? null,
      year: a.year ?? null,
      art: a.image ?? null,
    })),
  };
}
