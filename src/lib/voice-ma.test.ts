// Bus task 031: the voice API's music reads Music Assistant through kindle_panel's library_* services (ids = MA uris,
// art = MA image proxy URLs). HA is faked at fetch level.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maArtistAlbums, maCandidates, maListData, maMixPlaylists } from "./voice-ma.server";
import { maImageUrl, maMixFor, trackView } from "./voice-match";

const IMG = (n: string) => `http://192.168.1.15:8095/imageproxy/${n}?size=256`;
const lib = (mt: string, id: number, name: string, extra: Record<string, unknown> = {}) => ({
  uri: `library://${mt}/${id}`,
  media_type: mt,
  name,
  image: IMG(`${mt}${id}`),
  ...extra,
});
const calls: { service: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env["HA_TOKEN"] = "ha";
  process.env["HA_BASE_URL"] = "http://ha.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = /\/api\/services\/kindle_panel\/(library_\w+)/.exec(String(input));
    if (!m) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ service: m[1]!, body });
    let r: unknown = { total: 0, items: [] };
    if (m[1] === "library_search")
      r = {
        items: [
          lib("artist", 998, "Queen"),
          lib("album", 602, "Classic Queen", { artist: "Queen", year: 1992 }),
          lib("track", 2553, "Dancing Queen", { artist: "ABBA", album: "Arrival" }),
          lib("radio", 9, "Queen FM"),
        ],
      };
    else if (body["parent"] === "library://artist/998")
      r = {
        total: 3,
        items: [
          lib("album", 7, "Innuendo", { year: 1991 }),
          lib("track", 1, "Loose track"),
          lib("album", 3, "A Night at the Opera", { year: 1975 }),
        ],
      };
    else if (body["section"] === "artists")
      r = { total: 1010, items: [lib("artist", 584, "Gladys Knight")] };
    else if (body["section"] === "albums")
      r = {
        total: 2302,
        items: [lib("album", 143, "#1's", { artist: "Destiny's Child", year: 2005 })],
      };
    else if (body["section"] === "playlists")
      r = {
        total: 3,
        items: [
          lib("playlist", 20, "80s"),
          lib("playlist", 21, "Jazz"),
          lib("playlist", 5, "Mine"),
        ],
      };
    return new Response(JSON.stringify({ service_response: r }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
  delete process.env["HA_TOKEN"];
  delete process.env["HA_BASE_URL"];
});

describe("voice API from Music Assistant (bus task 031)", () => {
  it("search candidates carry MA uris, art, artist / album / year; radio is left out", async () => {
    const c = await maCandidates("queen", "auto", 10);
    expect(calls[0]).toEqual({
      service: "library_search",
      body: { query: "queen", media_types: ["artist", "album", "track", "playlist"], limit: 10 },
    });
    expect(c.map((x) => [x.kind, x.id])).toEqual([
      ["artist", "library://artist/998"],
      ["album", "library://album/602"],
      ["track", "library://track/2553"],
    ]);
    expect(c[0]).toMatchObject({ title: "Queen", art: IMG("artist998"), score: 100 });
    expect(c[1]).toMatchObject({ artist: "Queen", year: 1992 });
    expect(c[2]).toMatchObject({ artist: "ABBA", album: "Arrival" });
    await maCandidates("queen", "album", 5);
    expect(calls[1]?.body["media_types"]).toEqual(["album"]);
  });
  it("an artist's albums by uri, oldest first, tracks left out", async () => {
    const a = await maArtistAlbums("library://artist/998");
    expect(calls[0]?.body).toEqual({ parent: "library://artist/998", offset: 0, limit: 200 });
    expect(a).toEqual([
      {
        id: "library://album/3",
        title: "A Night at the Opera",
        year: 1975,
        tracks: null,
        art: IMG("album3"),
      },
      { id: "library://album/7", title: "Innuendo", year: 1991, tracks: null, art: IMG("album7") },
    ]);
  });
  it("lists: random album artists, albums by name, discography, mixes; a non-uri artist is refused", async () => {
    const a = await maListData("artist", "random", 40, 0, undefined);
    expect(calls.at(-1)?.body).toEqual({
      section: "artists",
      offset: 0,
      limit: 40,
      order_by: "random",
      album_artists_only: true,
    });
    expect(a).toMatchObject({
      ok: true,
      total: 1010,
      items: [{ id: "library://artist/584", name: "Gladys Knight" }],
    });
    const b = await maListData("album", "name", 5, 10, undefined);
    expect(calls.at(-1)?.body).toEqual({
      section: "albums",
      offset: 10,
      limit: 5,
      order_by: "sort_name",
    });
    expect(b).toMatchObject({
      total: 2302,
      items: [
        {
          id: "library://album/143",
          title: "#1's",
          artist: "Destiny's Child",
          year: 2005,
          art: IMG("album143"),
        },
      ],
    });
    const c = await maListData("album", "name", 50, 0, "library://artist/998");
    expect(c).toMatchObject({ artist: "library://artist/998", total: 2 });
    expect(await maListData("album", "name", 50, 0, "3fb7991a95f7b9ba")).toEqual({
      error: "artist must be a Music Assistant uri",
    });
    expect((await maMixPlaylists()).map((m) => [m.mix, m.id, m.he])).toEqual([
      ["s80", "library://playlist/20", "שנות ה-80"],
      ["jazz", "library://playlist/21", "ג׳אז"],
    ]);
  });
  it("mix names and the state's MA art URL", () => {
    expect(maMixFor("80s mix")?.name).toBe("80s");
    expect(maMixFor("the eighties")?.id).toBe("s80");
    expect(maMixFor("kids")?.name).toBe("Kids");
    expect(maMixFor("children's music")?.id).toBe("kids");
    expect(maMixFor("עברית")?.id).toBe("hebrew");
    expect(maMixFor("queen")).toBeNull();
    const url = "http://192.168.1.15:8095/imageproxy/ab?size=256";
    const token = `ma:${Buffer.from(url).toString("base64url")}`;
    expect(maImageUrl(token)).toBe(url);
    expect(maImageUrl("c".repeat(32))).toBeNull();
    const v = trackView({
      id: "1",
      title: "t",
      artist: null,
      album: null,
      albumId: "143",
      durationMs: 0,
      container: null,
      artItemId: token,
    });
    expect(v).toMatchObject({ artItemId: token, artUrl: url, albumId: "143" });
  });
});
