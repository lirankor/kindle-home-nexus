// Desktop debugging: the panel is driven by the Kindle's keys (arrows + Enter in the content, PageUp /
// PageDown for the side buttons = tabs, F1..F4 for the bottom row). In an ordinary browser the F-keys and
// PageUp/PageDown are awkward, so 1..4 act as F1..F4 and [ / ] as PageUp / PageDown. Keyed on
// `event.code`, so it works on the Hebrew layout too. Modifier combinations are left alone. The
// synthetic events carry the target key as their code, which is not an alias, so there is no loop.
const ALIASES: Record<string, string> = {
  Digit1: "F1",
  Digit2: "F2",
  Digit3: "F3",
  Digit4: "F4",
  BracketLeft: "PageUp",
  BracketRight: "PageDown",
};

export function installDesktopKeyAliases(win: Window = window): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = ALIASES[event.code];
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    win.document.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
    );
  };
  // Window capture runs before every document listener (the screensaver wake listener included).
  win.addEventListener("keydown", onKey, true);
  return () => win.removeEventListener("keydown", onKey, true);
}
