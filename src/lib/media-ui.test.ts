import { describe, expect, it } from "vitest";

import {
  LIB_SEARCH_KEYS,
  LIB_SEARCH_ROWS,
  SEARCH_GLOBE,
  SEARCH_GLOBE_INDEX,
  SEARCH_KEY_ROWS,
  moveLibSearchKey,
} from "@/lib/media-ui";

describe("the Library search keyboard layouts", () => {
  it("both layouts: four rows of ten, then the globe alone at the same index", () => {
    for (const layout of ["en", "he"] as const) {
      const rows = LIB_SEARCH_ROWS[layout];
      expect(rows.map((r) => r.length)).toEqual([10, 10, 10, 10, 1]);
      expect(LIB_SEARCH_KEYS[layout].indexOf(SEARCH_GLOBE)).toBe(SEARCH_GLOBE_INDEX);
      expect(LIB_SEARCH_KEYS[layout].filter((k) => k === SEARCH_GLOBE)).toHaveLength(1);
    }
    expect(SEARCH_GLOBE_INDEX).toBe(40);
    // the English rows are the old ones, untouched
    expect(LIB_SEARCH_ROWS.en.slice(0, 4)).toEqual(SEARCH_KEY_ROWS.en);
  });

  it("Hebrew: rows read right to left on screen, final forms are keys of their own, digits as in English", () => {
    const he = LIB_SEARCH_ROWS.he;
    const reading = (r: readonly string[]) => [...r].reverse().join(" ");
    expect(reading(he[0]!)).toBe("א ב ג ד ה ו ז ח ט י");
    expect(reading(he[1]!)).toBe("כ ל מ נ ס ע פ צ ק ר");
    expect(reading(he[2]!)).toBe("ש ת ך ם ן ף ץ ' - .");
    expect(he[3]).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    // on screen (left to right): Alef is the top row's rightmost key
    expect(LIB_SEARCH_KEYS.he[9]).toBe("א");
    expect(LIB_SEARCH_KEYS.he[0]).toBe("י");
  });

  it("arrows are geometry: Left / Right walk the row, Down from the digits lands on the globe, Down from it = results", () => {
    // Hebrew: Left from Alef (rightmost) is Bet, Right from Bet is Alef
    expect(LIB_SEARCH_KEYS.he[moveLibSearchKey(9, "left") as number]).toBe("ב");
    expect(LIB_SEARCH_KEYS.he[moveLibSearchKey(8, "right") as number]).toBe("א");
    expect(LIB_SEARCH_KEYS.en[moveLibSearchKey(1, "left") as number]).toBe("A");
    expect(LIB_SEARCH_KEYS.en[moveLibSearchKey(0, "right") as number]).toBe("B");
    expect(moveLibSearchKey(0, "left")).toBe(0);
    for (let k = 30; k < 40; k++) expect(moveLibSearchKey(k, "down")).toBe(SEARCH_GLOBE_INDEX);
    expect(moveLibSearchKey(SEARCH_GLOBE_INDEX, "down")).toBe("results");
    expect(moveLibSearchKey(SEARCH_GLOBE_INDEX, "up")).toBe(30);
    expect(moveLibSearchKey(SEARCH_GLOBE_INDEX, "right")).toBe(SEARCH_GLOBE_INDEX);
    expect(moveLibSearchKey(SEARCH_GLOBE_INDEX, "left")).toBe(39);
    expect(moveLibSearchKey(5, "down")).toBe(15);
    expect(moveLibSearchKey(15, "up")).toBe(5);
  });
});
