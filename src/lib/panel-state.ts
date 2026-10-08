// Where the panel was: the active tab and the open "now playing" media screen, kept in localStorage
// so a bridge page reload or a screensaver wake lands back on the same screen (never on Lights by
// accident). Light / plug modals are deliberately not remembered.
export const TAB_NAMES = ["Lights", "Vacuum", "Power", "Media"] as const;
export type TabName = (typeof TAB_NAMES)[number];
export const PERSISTED_MEDIA_SCREENS = ["now", "source", "radio", "music"] as const;
export type PersistedMediaScreen = (typeof PERSISTED_MEDIA_SCREENS)[number];
export type PanelState = { tab: TabName; mediaScreen: PersistedMediaScreen | null };

const KEY = "kindle-panel-state";

export function loadPanelState(): PanelState | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { tab, mediaScreen } = parsed as Record<string, unknown>;
    if (!(TAB_NAMES as readonly unknown[]).includes(tab)) return null;
    const screen = (PERSISTED_MEDIA_SCREENS as readonly unknown[]).includes(mediaScreen)
      ? (mediaScreen as PersistedMediaScreen)
      : null;
    return { tab: tab as TabName, mediaScreen: tab === "Media" ? screen : null };
  } catch {
    return null;
  }
}

export function savePanelState(state: PanelState) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota: the panel simply starts on Lights next time */
  }
}

/** The media screens worth restoring; the TV modal is a plain modal and is not. */
export const persistableScreen = (screen: string | null): PersistedMediaScreen | null =>
  (PERSISTED_MEDIA_SCREENS as readonly string[]).includes(screen ?? "")
    ? (screen as PersistedMediaScreen)
    : null;
