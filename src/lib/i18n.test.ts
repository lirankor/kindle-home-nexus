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

  it("the picker is the player picker, not an exit (bus task 025)", () => {
    const he = makeT("he");
    const en = makeT("en");
    expect(he("media.output")).toBe("נגן");
    expect(he("output.title")).toBe("נגנים");
    expect(en("media.output")).toBe("Player");
    expect(en("output.title")).toBe("Players");
    for (const lang of ["he", "en"] as const)
      for (const [k, v] of Object.entries(dictionaries[lang]))
        if (k.startsWith("output.") || k === "media.output") expect(v).not.toMatch(/יציאה|output/i);
    expect(he("output.elsewhere", { name: "X" })).toBe("X מנגן · F3 להחלפה");
  });

  it("has the same keys in every language and no empty strings", () => {
    expect(Object.keys(dictionaries.he).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const dict of Object.values(dictionaries))
      for (const value of Object.values(dict)) expect(value.length).toBeGreaterThan(0);
  });

  it("fills placeholders", () => {
    expect(makeT("en")("lights.count", { n: 2, total: 4 })).toBe("2 of 4 lights on");
    expect(makeT("he")("lights.count", { n: 2, total: 4 })).toContain("4");
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
