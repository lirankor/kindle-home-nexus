// Server functions of the Music Assistant library (bus task 027, MUSIC_BACKEND=ha). Thin: validate, call kindle_panel.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { haConfigured } from "./home.server";
import { DISCOVER_ROWS, LIBRARY_TABS } from "./library";
import { SEARCH_MAX_CHARS } from "./media";
import type {
  DiscoverRow,
  LibHomeResult,
  LibListResult,
  LibPlayResult,
  LibSearchResult,
} from "./library";
import {
  favouriteLibraryItem,
  playLibraryItem,
  readLibraryHome,
  readLibraryList,
  searchLibrary,
} from "./library-ha.server";

/**
 * A Music Assistant uri (provider://type/id). Podcast episode ids contain a space (an RSS url, a space, a guid), so the
 * id may hold spaces, but not at its ends and never control characters or line breaks. The uri is only ever sent as a
 * JSON field of an HA service call, so spaces open no injection surface.
 */
export const LIB_URI_RE =
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  /^[a-z0-9_-]+:\/\/[a-z_]+\/[^\s\u0000-\u001f\u007f-\u009f](?:[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,398}[^\s\u0000-\u001f\u007f-\u009f])?$/i;

// The zod schemas are built on first use, not at import: the UI tests import the panel (and with it this module) under
// vitest-jsdom, where zod is not available at module load (the voice route does the same).
let built: ReturnType<typeof buildSchemas> | null = null;
function buildSchemas() {
  const uri = z.string().regex(LIB_URI_RE);
  return {
    list: z.object({
      section: z
        .enum(LIBRARY_TABS.filter((t) => t !== "search") as [string, ...string[]])
        .optional(),
      parent: uri.optional(),
      favorite: z.boolean().optional(),
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    home: z.object({
      sections: z.array(z.enum(DISCOVER_ROWS)).max(DISCOVER_ROWS.length).optional(),
    }),
    search: z.object({ query: z.string().trim().min(1).max(SEARCH_MAX_CHARS) }),
    play: z.object({ uri, option: z.enum(["replace", "next", "add"]), startItem: uri.optional() }),
    favourite: z.object({ uri, favorite: z.boolean() }),
  };
}
const schemas = () => (built ??= buildSchemas());
const noHa = { ok: false, error: "HA not configured" } as const;

type ListInput = Parameters<typeof readLibraryList>[0];
type PlayInput = {
  uri: string;
  option: "replace" | "next" | "add";
  startItem?: string | undefined;
};

type HomeInput = { sections?: DiscoverRow[] | undefined };

/** Discover's rows; `sections` = the panel option media.discover_rows (bus task 029). */
export const getLibraryHome = createServerFn({ method: "GET" })
  .validator((d: HomeInput) => schemas().home.parse(d ?? {}) as HomeInput)
  .handler(async ({ data }): Promise<LibHomeResult> =>
    haConfigured() ? readLibraryHome(data.sections) : { ...noHa, rows: [] },
  );

export const getLibraryList = createServerFn({ method: "GET" })
  .validator((d: ListInput) => schemas().list.parse(d) as ListInput)
  .handler(async ({ data }): Promise<LibListResult> =>
    haConfigured()
      ? readLibraryList(data)
      : { ...noHa, total: 0, offset: 0, favorites: 0, parent: null, items: [] },
  );

export const searchLibraryItems = createServerFn({ method: "GET" })
  .validator((d: { query: string }) => schemas().search.parse(d))
  .handler(async ({ data }): Promise<LibSearchResult> =>
    haConfigured() ? searchLibrary(data.query) : { ...noHa, query: data.query, items: [] },
  );

export const playLibrary = createServerFn({ method: "POST" })
  .validator((d: PlayInput) => schemas().play.parse(d) as PlayInput)
  .handler(async ({ data }): Promise<LibPlayResult> =>
    haConfigured() ? playLibraryItem(data) : noHa,
  );

export const favouriteLibrary = createServerFn({ method: "POST" })
  .validator((d: { uri: string; favorite: boolean }) => schemas().favourite.parse(d))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> =>
    haConfigured() ? favouriteLibraryItem(data.uri, data.favorite) : noHa,
  );
