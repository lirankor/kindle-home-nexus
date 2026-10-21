import { afterEach, describe, expect, it } from "vitest";
import { installDesktopKeyAliases } from "./desktop-keys";

describe("desktop key aliases", () => {
  let uninstall = () => {};
  afterEach(() => uninstall());

  it("turns 1..4 and [ ] into F1..F4 and PageUp/PageDown on the document", () => {
    uninstall = installDesktopKeyAliases();
    const seen: string[] = [];
    document.addEventListener("keydown", (e) => seen.push(e.key));
    const press = (code: string, key: string, init: KeyboardEventInit = {}) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init }),
      );
    press("Digit1", "1");
    press("Digit4", "4");
    press("BracketLeft", "[");
    press("BracketRight", "]");
    // Not aliased (and dispatched on window, so the document never sees them): default kept.
    expect(press("KeyA", "a")).toBe(true);
    expect(press("Digit2", "2", { metaKey: true })).toBe(true);
    expect(press("Digit1", "1")).toBe(false);
    expect(seen).toEqual(["F1", "F4", "PageUp", "PageDown", "F1"]);
  });
});
