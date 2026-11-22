// The panel's recent searches (2026-11-22). Music Assistant's web app keeps its own list on the MA server, per MA
// user (preference "search.recent"); the panel talks to MA through Home Assistant's integration and has no such user
// session, so it keeps a small list of its own: a file under MEDIA_STATE_DIR (the app-data bind mount), memory only
// without that variable (tests, a bare dev server).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RECENT_SEARCH_MAX, addRecentSearch } from "./library";

let recents: string[] | null = null;
const recentsFile = () => {
  const dir = (process.env["MEDIA_STATE_DIR"] ?? "").trim();
  return dir ? path.join(dir, "kindle-search-recent.json") : null;
};

export async function readRecentSearches(): Promise<string[]> {
  if (recents) return recents;
  let list: string[] = [];
  const file = recentsFile();
  if (file) {
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(raw))
        list = raw.filter((v): v is string => typeof v === "string").slice(0, RECENT_SEARCH_MAX);
    } catch {
      /* no file yet */
    }
  }
  return (recents ??= list);
}

/** A search whose results were opened: to the head of the list. Answers the new list. */
export async function rememberRecentSearch(query: string): Promise<string[]> {
  const next = addRecentSearch(await readRecentSearches(), query);
  recents = next;
  const file = recentsFile();
  if (file) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next), "utf8");
    } catch {
      /* the list still lives in memory */
    }
  }
  return next;
}

/** Test hook: forget the list. */
export function resetRecentSearches() {
  recents = null;
}
