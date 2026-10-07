import { describe, expect, it } from "vitest";
import { actionLabel, localName } from "./home";
import { dictionaries, makeT, parseLang } from "./i18n";

describe("i18n", () => {
  it("defaults to Hebrew and accepts English", () => {
    expect(parseLang(undefined)).toBe("he");
    expect(parseLang("")).toBe("he");
    expect(parseLang("EN")).toBe("en");
    expect(parseLang("en-GB")).toBe("en");
  });

  it("has the same keys in every language and no empty strings", () => {
    expect(Object.keys(dictionaries.he).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const dict of Object.values(dictionaries))
      for (const value of Object.values(dict)) expect(value.length).toBeGreaterThan(0);
  });

  it("fills placeholders", () => {
    expect(makeT("en")("lights.count", { n: 2 })).toBe("2 of 4 lights on");
    expect(makeT("he")("lights.count", { n: 2 })).toContain("2");
  });

  it("localises entity names and action labels", () => {
    expect(localName("he", "Main light")).toBe("אור ראשי");
    expect(localName("en", "Main light")).toBe("Main light");
    expect(actionLabel({ type: "lights.off" }, "he")).toBe("כל האורות כבו");
    expect(actionLabel({ type: "light.toggle", entity: "light.spots" }, "en")).toBe(
      "Spot light toggled",
    );
  });
});
