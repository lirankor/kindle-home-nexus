import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RECENT_SEARCH_MAX } from "./library";
import {
  readRecentSearches,
  rememberRecentSearch,
  resetRecentSearches,
} from "./search-recent.server";

describe("the panel's recent searches", () => {
  let dir = "";
  const file = () => path.join(dir, "kindle-search-recent.json");
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "khn-recent-"));
    delete process.env["MEDIA_STATE_DIR"];
    resetRecentSearches();
  });
  afterEach(() => {
    delete process.env["MEDIA_STATE_DIR"];
    resetRecentSearches();
    rmSync(dir, { recursive: true, force: true });
  });

  it("without a state directory the list lives in memory only", async () => {
    expect(await readRecentSearches()).toEqual([]);
    expect(await rememberRecentSearch("Queen")).toEqual(["Queen"]);
    expect(await readRecentSearches()).toEqual(["Queen"]);
  });

  it("the list is a file in the state directory: newest first, one entry per search, capped, read back after a restart", async () => {
    process.env["MEDIA_STATE_DIR"] = dir;
    await rememberRecentSearch("queen");
    await rememberRecentSearch("עוף גוזל");
    expect(await rememberRecentSearch("Queen")).toEqual(["Queen", "עוף גוזל"]);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(["Queen", "עוף גוזל"]);
    for (let i = 0; i < RECENT_SEARCH_MAX + 2; i++) await rememberRecentSearch(`search ${i}`);
    resetRecentSearches(); // a restart: only the file is left
    const list = await readRecentSearches();
    expect(list.length).toBe(RECENT_SEARCH_MAX);
    expect(list[0]).toBe(`search ${RECENT_SEARCH_MAX + 1}`);
    expect(list).not.toContain("Queen");
  });

  it("a broken or foreign file is an empty list, not an error", async () => {
    process.env["MEDIA_STATE_DIR"] = dir;
    writeFileSync(file(), "{not json");
    expect(await readRecentSearches()).toEqual([]);
    resetRecentSearches();
    writeFileSync(file(), JSON.stringify(["ok", 7, null, "two"]));
    expect(await readRecentSearches()).toEqual(["ok", "two"]);
  });
});
