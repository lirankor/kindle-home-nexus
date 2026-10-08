// Where the panel was: the active tab and the open "now playing" media screen, kept in localStorage
// so a bridge page reload or a screensaver wake lands back on the same screen (never on Lights by
// accident). Light / plug modals are deliberately not remembered.
import { MUSIC_TABS } from "./media";
import type { MusicTab } from "./media";

export const TAB_NAMES = ["Lights", "Vacuum", "Power", "Media"] as const;
export type TabName = (typeof TAB_NAMES)[number];
export const PERSISTED_MEDIA_SCREENS = ["now", "source", "radio", "music"] as const;
export type PersistedMediaScreen = (typeof PERSISTED_MEDIA_SCREENS)[number];
/** Radio screen: the band the dial shows and the remembered needle index per band. */
export type RadioPanelState = { list: string; indexByList: Record<string, number> };
/** Music screen: the tab the user was on and the remembered page per tab. */
export type MusicPanelState = { tab: MusicTab; pageByTab: Partial<Record<MusicTab, number>> };
export type PanelState = {
  tab: TabName;
  mediaScreen: PersistedMediaScreen | null;
  radio?: RadioPanelState;
  music?: MusicPanelState;
};

const parseRadio = (value: unknown): RadioPanelState | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const { list, indexByList } = value as Record<string, unknown>;
  if (typeof list !== "string" || !list) return undefined;
  const indexes: Record<string, number> = {};
  if (indexByList && typeof indexByList === "object")
    for (const [k, v] of Object.entries(indexByList as Record<string, unknown>))
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) indexes[k] = v;
  return { list, indexByList: indexes };
};

const parseMusic = (value: unknown): MusicPanelState | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const { tab, pageByTab } = value as Record<string, unknown>;
  if (!(MUSIC_TABS as readonly unknown[]).includes(tab)) return undefined;
  const pages: Partial<Record<MusicTab, number>> = {};
  if (pageByTab && typeof pageByTab === "object")
    for (const [k, v] of Object.entries(pageByTab as Record<string, unknown>))
      if (
        (MUSIC_TABS as readonly string[]).includes(k) &&
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 0
      )
        pages[k as MusicTab] = v;
  return { tab: tab as MusicTab, pageByTab: pages };
};

const KEY = "kindle-panel-state";

export function loadPanelState(): PanelState | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { tab, mediaScreen, radio, music } = parsed as Record<string, unknown>;
    if (!(TAB_NAMES as readonly unknown[]).includes(tab)) return null;
    const screen = (PERSISTED_MEDIA_SCREENS as readonly unknown[]).includes(mediaScreen)
      ? (mediaScreen as PersistedMediaScreen)
      : null;
    const parsedRadio = parseRadio(radio);
    const parsedMusic = parseMusic(music);
    return {
      tab: tab as TabName,
      mediaScreen: tab === "Media" ? screen : null,
      ...(parsedRadio ? { radio: parsedRadio } : {}),
      ...(parsedMusic ? { music: parsedMusic } : {}),
    };
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
