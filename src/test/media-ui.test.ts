import { describe, expect, it } from "vitest";

import { albumDateLabel } from "@/lib/media-ui";

describe("albumDateLabel", () => {
  it("shows the full date when the tags know the day", () => {
    expect(albumDateLabel({ year: 1973, releaseDate: "1973-04-17" }, "en")).toBe("17 Apr 1973");
    expect(albumDateLabel({ year: 1973, releaseDate: "1973-04-17" }, "he")).toMatch(/1973/);
  });
  it("falls back to the year for 1 January placeholders and year-only tags", () => {
    expect(albumDateLabel({ year: 1976, releaseDate: "1976-01-01" }, "en")).toBe("1976");
    expect(albumDateLabel({ year: 1992, releaseDate: null }, "en")).toBe("1992");
    expect(albumDateLabel({ year: null, releaseDate: "2007-01-01" }, "en")).toBe("2007");
    expect(albumDateLabel({ year: null, releaseDate: null }, "en")).toBeNull();
  });
});
