// State and key handling for the media screens (no JSX, so it can sit beside the other lib code).
// The shell calls `useMediaPanel`, renders `MediaCards` / `MediaModal` from media-screens.tsx with
// the returned panel, feeds the footer from `actions` / `modalActions` and forwards keys to `onKey`.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  Delete,
  Film,
  Heart,
  ListMusic,
  ListOrdered,
  Music2,
  Power,
  Radio,
  Search,
  Shuffle,
  Space,
  Speaker,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type { DeviceAction } from "@/components/device-actions";
import { useFullRefresh } from "@/lib/eink";
import { nodeIcon } from "@/lib/icons";
import { isRtl, makeT } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";
import {
  FAVOURITES_LIST_ID,
  INPUT_NET_RADIO,
  MUSIC_PAGE_SIZE,
  MUSIC_TABS,
  SEARCH_MAX_CHARS,
  SEARCH_MIN_CHARS,
  demoMediaSnapshot,
  demoQueue,
} from "@/lib/media";
import type {
  AmpSource,
  ArtistAlbumsResult,
  MediaAction,
  MediaSnapshot,
  MediaSnapshotResult,
  MusicListItem,
  MusicListResult,
  MusicSearchResult,
  MusicTab,
  PowerOnStatus,
  RadioListsResult,
  RadioPosition,
  RadioStationView,
  QueueList,
} from "@/lib/media";
import {
  SEARCH_KEYS,
  SEARCH_KEY_COLS,
  ampNode,
  ampSourceRows,
  inputLabel,
  ampPowerSlot,
  appendSearchChar,
  applyMediaOptimistic,
  applyMusicPlay,
  applyRadioTune,
  mediaActionLabel,
  musicItemTitle,
  nodeLabel,
  screenForSource,
  sourceHomeScreen,
  stepAction,
  toggleAction,
} from "@/lib/media-ui";
import {
  getArtistAlbums,
  getMediaSnapshot,
  getMusicLists,
  getPowerOnStatus,
  getQueueTracks,
  getRadioLists,
  playMusic,
  runMediaAction,
  searchMusic,
  startAmpPowerOn,
  tuneRadioStation,
} from "@/lib/media.functions";
import type { MusicPanelState, RadioPanelState } from "@/lib/panel-state";
import {
  bandLabel,
  radioBands,
  dialPosition,
  isCatalogStationId,
  listById,
  playingPosition,
  stationAt,
  toggleFavouriteInLists,
  withPosition,
  wrapIndex,
} from "@/lib/radio-dial";

const POLL_MS = 10000;
/** While our Jellyfin queue plays and the Media tab (or a media screen) is showing: the snapshot is
 *  polled this often and the Kindle is told, through <html data-eink-poll>, to re-fetch its screen
 *  this often too, so a track change lands within a few seconds instead of its idle 20 s. Radio and
 *  the other tabs keep the slow cadence. */
export const QUEUE_POLL_MS = 5000;
/** Snapshot cadence while the Media tab is not showing (another tab, the screensaver). */
export const IDLE_POLL_MS = 60_000;
/** A snapshot older than this (two idle polls: polling is dead or the server was away) must not decide
 *  where the amp card opens (power-on vs. the amp view); the amp view refetches on open and routes then. */
export const SNAPSHOT_STALE_MS = 2 * IDLE_POLL_MS;
const POWER_ON_POLL_MS = 2000;
/** HA publishes the new state a moment after an action: refetch the snapshot this long after it resolved. */
const AFTER_ACTION_MS = 2000;
const FAILED_SHOWN_MS = 2 * 60 * 1000;
/** How long a dial notice (F2 in MUSIC_BACKEND=ha) stays on the radio screen. */
const DIAL_NOTICE_MS = 8000;
const NAV_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];

export type MediaScreen =
  | "now"
  | "source"
  | "radio"
  | "music"
  | "tv"
  | "queue"
  | "search"
  | "artist"
  /** A Media tab node's controls (bus task 014), its source list, and the music output picker. */
  | "node"
  | "nodesource"
  /** A receiver's NET RADIO stations (from the bridge's station select), opened from its NET RADIO input. */
  | "nodestation"
  | "output";
/** Node screens by type: the soft keys F2 / F3 (F1 back, F4 on/off). The table grows with the node types. */
export const NODE_SCREEN_KEYS: Record<string, ("source" | "stream" | "movie" | null)[]> = {
  receiver: ["source", "stream"],
  tv: ["movie", "source"],
};
/** Sub-views of the radio screen: the dial and the station list of the band. */
export type RadioView = "dial" | "stations" | "bands";
export type MediaNotice = { text: string; error?: boolean };
export const RADIO_PAGE_SIZE = 8;
export const QUEUE_PAGE_SIZE = 8;
/** Search screen: the results request waits this long after the last typed character. */
export const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_STALE_MS = 60_000;
/** Search screen state: the typed text, which half has the cursor, and the highlighted key. */
type SearchState = { query: string; focus: "keys" | "results"; key: number };
const EMPTY_SEARCH: SearchState = { query: "", focus: "keys", key: 0 };
/** Artist screen: the artist row that opened it, the page shown, and where to return on back. */
type ArtistState = {
  item: MusicListItem;
  page: number;
  from: { screen: MediaScreen; cursor: number; focus: SearchState["focus"] };
};
/** Not under ["media"]: a volume step must not refetch the YTuner lists. */
const RADIO_LISTS_KEY = ["radioLists"] as const;
/** Jellyfin lists, one entry per tab and page; kept for a while so tabs come back instantly. */
const MUSIC_LIST_KEY = "musicList";
const MUSIC_LIST_STALE_MS = 5 * 60_000;

const queuePlaying = (s: MediaSnapshot | null | undefined): boolean =>
  !!s && s.amp.on && s.nowPlaying.kind === "music" && s.queue?.status === "playing";

export function useMediaPanel({
  active,
  lang,
  notify,
  onHomeChanged,
}: {
  /** The Media tab is showing: poll the snapshot every 10 s. */
  active: boolean;
  lang: Lang;
  /** Status-line text; `error` texts may be raw server messages ("HA unreachable"). */
  notify: (notice: MediaNotice) => void;
  /** Called after actions that also change the home snapshot (movie mode, TV). */
  onHomeChanged?: () => void;
}) {
  const t = makeT(lang);
  const queryClient = useQueryClient();
  const [screen, setScreenState] = useState<MediaScreen | null>(null);
  const [cursor, setCursor] = useState(0);
  const [demo, setDemo] = useState<MediaSnapshot>(demoMediaSnapshot);
  const [optimistic, setOptimistic] = useState<MediaSnapshot | null>(null);
  const [localPowerOn, setLocalPowerOn] = useState<PowerOnStatus | null>(null);
  const [radio, setRadio] = useState<RadioPanelState | null>(null);
  const [radioView, setRadioView] = useState<RadioView>("dial");
  const [music, setMusic] = useState<MusicPanelState | null>(null);
  const lastGood = useRef<MediaSnapshot | null>(null);
  const inFlight = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const screenRef = useRef<MediaScreen | null>(null);
  screenRef.current = screen;
  // Snapshot freshness: the 10 s poll is too slow right after an action (HA settles ~1–2 s later)
  // and when a screen opens (F4 once sent "off" to an amp that was already in standby).
  const afterActionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchSnapshot = useCallback(
    () => void queryClient.refetchQueries({ queryKey: ["media"], exact: true }),
    [queryClient],
  );
  const refetchSnapshotSoon = useCallback(() => {
    if (afterActionTimer.current) clearTimeout(afterActionTimer.current);
    afterActionTimer.current = setTimeout(() => {
      afterActionTimer.current = null;
      refetchSnapshot();
    }, AFTER_ACTION_MS);
  }, [refetchSnapshot]);
  useEffect(
    () => () => {
      if (afterActionTimer.current) clearTimeout(afterActionTimer.current);
    },
    [],
  );
  const query = useQuery<MediaSnapshotResult>({
    queryKey: ["media"],
    queryFn: () => getMediaSnapshot(),
    // Another tab or the screensaver showing: a slow poll instead of none, so the snapshot the cards
    // come back to is never minutes old (2026-10-15: an amp in standby showed "on" on return).
    refetchInterval: (q) =>
      !(active || screen !== null)
        ? IDLE_POLL_MS
        : queuePlaying(q.state.data?.snapshot)
          ? QUEUE_POLL_MS
          : POLL_MS,
    refetchIntervalInBackground: true,
  });
  const result = query.data;
  // Tab shown again: fetch now instead of at the next poll tick (the cards would otherwise show the
  // last snapshot of the previous visit until then, 10–20 s on the panel).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refetchSnapshot();
    wasActive.current = active;
  }, [active, refetchSnapshot]);
  const fastPoll = (active || screen !== null) && queuePlaying(result?.snapshot);
  useEffect(() => {
    const el = document.documentElement;
    if (fastPoll) el.dataset["einkPoll"] = String(QUEUE_POLL_MS / 1000);
    else delete el.dataset["einkPoll"];
    return () => {
      delete el.dataset["einkPoll"];
    };
  }, [fastPoll]);
  const configured = result?.configured ?? true;
  if (result?.configured && result.snapshot) lastGood.current = result.snapshot;
  const data: MediaSnapshot | null =
    result === undefined ? null : !result.configured ? demo : (optimistic ?? lastGood.current);
  const latest = useRef(data);
  latest.current = data;
  const configuredRef = useRef(configured);
  configuredRef.current = configured;
  const pollError = query.isError ? t("err.server") : result?.error;

  // Power-on routine: the snapshot carries the last status and `localPowerOn` the one returned when
  // this client started it (step "plug", 0 s). While either copy says running, poll the server every
  // 2 s and let every answer replace the client copy, so the block follows the server's step and
  // elapsed time and drops within one poll once the server reports done / failed (seen 2026-10-08:
  // the client copy stayed on step 1 for a minute after a routine that finished at once).
  const fromSnapshot = data?.powerOn ?? null;
  const anyRunning = (localPowerOn?.running ?? false) || (fromSnapshot?.running ?? false);
  const poQuery = useQuery<PowerOnStatus | null>({
    queryKey: ["media", "powerOn"],
    queryFn: () => getPowerOnStatus(),
    enabled: anyRunning && screen !== null,
    refetchInterval: POWER_ON_POLL_MS,
    refetchIntervalInBackground: true,
  });
  const polled = poQuery.data;
  const polledAt = poQuery.dataUpdatedAt;
  /** A power-on start is in flight: the optimistic block must not be dropped by a poll that ran before it. */
  const startingPowerOn = useRef(false);
  useEffect(() => {
    if (polled === undefined) return;
    if (polled === null && startingPowerOn.current) return;
    // null = the server knows no routine (restarted): nothing to show. An older status (cached from
    // a previous routine) never overrides a newer one.
    setLocalPowerOn((local) =>
      polled === null ? null : !local || polled.startedAt >= local.startedAt ? polled : local,
    );
  }, [polled, polledAt]);
  /** Newest startedAt wins between the client copy and the snapshot's. */
  const powerOn =
    localPowerOn && fromSnapshot
      ? localPowerOn.startedAt >= fromSnapshot.startedAt
        ? localPowerOn
        : fromSnapshot
      : (localPowerOn ?? fromSnapshot);
  const step = powerOn?.step;
  const prevStep = useRef(step);
  /** Station chosen on the dial while the amp was off: tuned once the power-on routine is done. */
  const tuneAfterPowerOn = useRef<RadioPosition | null>(null);
  /** Source picked in the list while the routine was already running: applied once it is done. */
  const sourceAfterPowerOn = useRef<AmpSource | null>(null);
  /** Music item chosen while the amp was off: played once the power-on routine (source SERVER) is done. */
  const playAfterPowerOn = useRef<MusicListItem | null>(null);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    if (step === "done" || step === "failed") {
      void queryClient.invalidateQueries({ queryKey: ["media"] });
      refetchSnapshotSoon();
      notify({
        text: step === "done" ? t("poweron.done") : (powerOn?.error ?? t("poweron.failed")),
        error: step === "failed",
      });
      const pending = tuneAfterPowerOn.current;
      tuneAfterPowerOn.current = null;
      if (step === "done" && pending) void sendTune(pending);
      const pendingPlay = playAfterPowerOn.current;
      playAfterPowerOn.current = null;
      if (step === "done" && pendingPlay) void sendPlay(pendingPlay);
      // Land on the screen of the source the amp ended on (NET RADIO → radio, SERVER / others →
      // the amp view). The TV modal and a closed panel stay as they are.
      const pendingSource = sourceAfterPowerOn.current;
      sourceAfterPowerOn.current = null;
      if (step === "done" && pendingSource) void act({ type: "amp.source", source: pendingSource });
      const want = pendingSource
        ? screenForSource(pendingSource)
        : sourceHomeScreen(powerOn?.source ?? latest.current?.amp.source ?? null);
      const cur = screenRef.current;
      if (step === "done" && cur !== null && cur !== "tv" && cur !== want) open(want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const showPowerOn =
    !!powerOn &&
    (powerOn.running ||
      (powerOn.step === "failed" && Date.now() - powerOn.updatedAt < FAILED_SHOWN_MS));

  const act = useCallback(
    async (action: MediaAction) => {
      const before = latest.current ?? demoMediaSnapshot();
      const after = applyMediaOptimistic(before, action);
      const label = mediaActionLabel(action, lang, after);
      if (!configuredRef.current) {
        setDemo(after);
        notify({ text: label });
        return;
      }
      setOptimistic(after);
      inFlight.current += 1;
      try {
        await queryClient.cancelQueries({ queryKey: ["media"] });
        const res = await runMediaAction({ data: action });
        if (res.ok) {
          notify({ text: label });
          if (res.snapshot) {
            const snapshot = res.snapshot;
            queryClient.setQueryData<MediaSnapshotResult>(["media"], (old) => {
              const { error: _dropped, ...rest } = old ?? {
                configured: true,
                amp: false,
                jellyfin: false,
                lang,
              };
              return { ...rest, snapshot };
            });
          }
        } else notify({ text: res.error ?? t("err.failed"), error: true });
      } catch {
        notify({ text: t("err.server"), error: true });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setOptimistic(null);
        void queryClient.invalidateQueries({ queryKey: ["media"] });
        refetchSnapshotSoon();
        if (action.type === "radio.favourite")
          void queryClient.invalidateQueries({ queryKey: RADIO_LISTS_KEY });
        if (action.type === "movie" || action.type === "tv") onHomeChanged?.();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, queryClient, refetchSnapshotSoon],
  );

  const startPowerOn = useCallback(
    async (source?: AmpSource) => {
      // Optimistic (Q13): "Turning on…" in the key's own redraw, before the server answers; the server's status
      // replaces it, and a refusal drops it.
      const now = Date.now();
      startingPowerOn.current = true;
      setLocalPowerOn({
        running: true,
        step: "turn_on",
        startedAt: now,
        updatedAt: now,
        elapsedMs: 0,
        source: source ?? null,
      });
      try {
        const res = await startAmpPowerOn({ data: source ? { source } : {} });
        if (res.ok && res.status) {
          setLocalPowerOn(res.status);
          notify({ text: t("act.powerOn") });
        } else {
          setLocalPowerOn(res.status ?? null);
          notify({ text: res.error ?? t("err.failed"), error: true });
        }
      } catch {
        setLocalPowerOn(null);
        notify({ text: t("err.server"), error: true });
      } finally {
        startingPowerOn.current = false;
      }
      refetchSnapshotSoon();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, refetchSnapshotSoon],
  );

  /** Where the source list was opened from: cancel returns there. */
  const sourceOpener = useRef<MediaScreen>("now");
  const open = useCallback((next: MediaScreen) => {
    setScreenState((current) => {
      if (current === null) opener.current = document.activeElement as HTMLElement | null;
      if (next === "source" && current !== null && current !== "source")
        sourceOpener.current = current;
      return next;
    });
    if (next === "source")
      setCursor(
        Math.max(0, ampSourceRows(latest.current).indexOf(latest.current?.amp.source ?? "")),
      );
    if (next === "radio") setRadioView("dial");
    if (next === "music") setCursor(0);
    if (next === "queue") setCursor(Math.max(0, latest.current?.queue?.index ?? 0));
    if (next === "search") {
      setSearch(EMPTY_SEARCH);
      setCursor(0);
    }
    if (next === "artist") setCursor(0);
  }, []);
  const close = useCallback(() => setScreenState(null), []);

  // ---- Media tab nodes and the music output picker (bus task 014) ----
  const [nodeId, setNodeId] = useState<string | null>(null);
  const nodes = data?.nodes ?? [];
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  const output = data?.output ?? null;
  /** The amp's input list (its receiver node's live source_list, hidden inputs left out) and their names. */
  const sourceRows = ampSourceRows(data);
  const sourceName = (source: string | null | undefined) => inputLabel(lang, ampNode(data), source);
  const nodeSourceName = (source: string | null | undefined) => inputLabel(lang, node, source);
  /** HA music backend and no usable output yet: entering the music screen opens the picker first. */
  const needsOutput = !!output && (!output.entity || !output.valid);
  const openNode = (id: string) => {
    setNodeId(id);
    open("node");
  };
  /** Where the picker returns: the screen it was opened from; null = it opened by itself (Back closes the panel). */
  const outputReturn = useRef<MediaScreen | null>(null);
  const openOutput = (from: MediaScreen | null) => {
    outputReturn.current = from;
    open("output");
    const rows = latest.current?.output?.outputs ?? [];
    setCursor(
      Math.max(
        0,
        rows.findIndex((o) => o.entity_id === latest.current?.output?.entity),
      ),
    );
  };
  /** Select / a quick key in the picker: play here from now on, then back to the music screen. */
  const chooseOutput = (entity: string) => {
    void act({ type: "output", entity });
    open(outputReturn.current ?? "now");
  };
  /** Back in the picker: closes it with no change. */
  const closeOutput = () => {
    const back = outputReturn.current;
    if (back) open(back);
    else close();
  };

  /**
   * Opening the amp (Media tab: F3 or Enter on the card) lands on the ACTIVE source's screen:
   * NET RADIO → radio, SERVER / TUNER / CD / PHONO → the amp view. An amp that is off is powered on
   * right here (step block on the amp view) and the screen of the restored source follows when done.
   */
  const pendingOpenAmp = useRef(false);
  const openAmp = () => {
    const s = latest.current;
    const out = s?.output;
    if (out && (!out.entity || !out.valid)) {
      // no output chosen (or it is gone from HA): the picker first (owner, 2026-10-18)
      openOutput(null);
      return;
    }
    if (!s || Date.now() - query.dataUpdatedAt > SNAPSHOT_STALE_MS) {
      // No snapshot yet (first seconds after a page load) or a stale one (the tab was away; 2026-10-15
      // a 30-min-old "on" opened the amp view of an amp in standby): show the amp view, which refetches
      // on open, and route when the fresh snapshot comes.
      pendingOpenAmp.current = true;
      open("now");
      return;
    }
    if (s.amp.on) open(sourceHomeScreen(s.amp.source));
    else if (out)
      open("now"); // music through HA: an MA controller, playing wakes the output's receiver (task 015)
    else if (!configuredRef.current) {
      void act({ type: "amp.power", on: true });
      open(sourceHomeScreen(s.amp.source));
    } else {
      open("now");
      if (!powerOn?.running) void startPowerOn();
    }
  };
  /** Page reload: come back to the saved screen, then move to the active source's screen once known. */
  const restoreTarget = useRef<MediaScreen | null>(null);
  const restoreScreen = useCallback(
    (saved: MediaScreen) => {
      restoreTarget.current = saved === "now" || saved === "radio" ? saved : null;
      open(saved === "source" ? "now" : saved);
    },
    [open],
  );
  const restoreSource = data?.amp.on ? (data.amp.source ?? null) : null;
  useEffect(() => {
    if (!data) return;
    if (pendingOpenAmp.current) {
      pendingOpenAmp.current = false;
      if (screenRef.current === "now") openAmp();
      return;
    }
    if (restoreTarget.current === null) return;
    restoreTarget.current = null;
    if (!data.amp.on) return;
    const want = sourceHomeScreen(data.amp.source);
    if (screenRef.current !== null && screenRef.current !== want) open(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreSource, data === null, query.dataUpdatedAt]);
  /** Cancel in the source list: back to the screen it was opened from. */
  const closeSourceList = () => open(sourceOpener.current);
  useFullRefresh(`${screen ?? ""}/${screen === "radio" ? radioView : ""}`);
  // Events that leave ghosting behind on e-ink: see fullRefreshKey below the list state.
  useEffect(() => {
    if (screen) {
      document.querySelector<HTMLElement>(".full-modal")?.focus();
      refetchSnapshot();
      return;
    }
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [screen, refetchSnapshot]);

  /** Applies a source; an amp that is off is powered on straight into it. Radio / Jellyfin open their screens. */
  const applySource = (source: AmpSource) => {
    const s = latest.current;
    if (s && !s.amp.on && configuredRef.current) {
      if (powerOn?.running) sourceAfterPowerOn.current = source;
      else void startPowerOn(source);
    } else void act({ type: "amp.source", source });
    open(screenForSource(source));
  };

  // ---- Radio screen: lists, the dial position, tuning by index, favourites ----
  const listsQuery = useQuery<RadioListsResult>({
    queryKey: RADIO_LISTS_KEY,
    queryFn: () => getRadioLists(),
    enabled: screen === "radio",
    staleTime: 5 * 60_000,
  });
  const radioLists = listsQuery.data?.lists ?? null;
  const radioListsError = listsQuery.isError ? t("err.server") : (listsQuery.data?.error ?? null);
  const dialPos = dialPosition(radio, radioLists, data);
  const dialList = listById(radioLists, dialPos.list);
  const dialStation = stationAt(radioLists, dialPos) ?? null;
  const radioRef = useRef(radio);
  radioRef.current = radio;
  const dialRef = useRef(dialPos);
  dialRef.current = dialPos;
  const listsRef = useRef(radioLists);
  listsRef.current = radioLists;

  // Follow what the amp plays: when the playing station changes (as reported by the server, not by
  // our optimistic state) move the needle to it, preferring the band the user is on. Skipped while a
  // tune of ours is in flight so a stale poll cannot drag the needle back.
  const tuneBusy = useRef(false);
  const pendingTune = useRef<RadioPosition | null>(null);
  /** Dial state before the current run of tunes; restored when the server says no. */
  const revertTo = useRef<RadioPanelState | null>(null);
  const reported = result?.configured ? (result.snapshot ?? null) : demo;
  const playingKey = reported
    ? `${reported.nowPlaying.stationId ?? ""}|${reported.radio?.list ?? ""}:${reported.radio?.index ?? ""}`
    : "";
  const syncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!radioLists || tuneBusy.current || syncedKey.current === playingKey) return;
    syncedKey.current = playingKey;
    const pos = playingPosition(radioLists, reported, radioRef.current?.list ?? null);
    if (pos) setRadio((r) => withPosition(r, pos));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingKey, radioLists]);

  /** Restores the persisted band / indexes (index route, on mount). */
  const restoreRadio = useCallback((saved: RadioPanelState) => {
    setRadio((r) => r ?? saved);
  }, []);

  /** The request itself; coalesces presses so the amp walks its menu once per settled target. */
  const sendTune = async (pos: RadioPosition) => {
    const station = stationAt(listsRef.current, pos);
    if (!station) return;
    if (tuneBusy.current) {
      pendingTune.current = pos;
      return;
    }
    tuneBusy.current = true;
    inFlight.current += 1;
    try {
      await queryClient.cancelQueries({ queryKey: ["media"] });
      const res = await tuneRadioStation({ data: pos });
      if (res.ok) notify({ text: t("act.tuned", { station: station.name }) });
      else {
        notify({ text: res.error ?? t("err.failed"), error: true });
        if (!pendingTune.current) setRadio(revertTo.current);
      }
    } catch {
      notify({ text: t("err.server"), error: true });
      if (!pendingTune.current) setRadio(revertTo.current);
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setOptimistic(null);
      tuneBusy.current = false;
      const next = pendingTune.current;
      pendingTune.current = null;
      if (next) void sendTune(next);
      else {
        void queryClient.invalidateQueries({ queryKey: ["media"] });
        refetchSnapshotSoon();
      }
    }
  };

  /** Moves the needle and tunes the amp; an amp that is off is powered on into NET RADIO first. */
  const tuneTo = (pos: RadioPosition) => {
    const station = stationAt(listsRef.current, pos);
    if (!station) return;
    if (!tuneBusy.current) revertTo.current = radioRef.current;
    setRadio((r) => withPosition(r, pos));
    const before = latest.current ?? demoMediaSnapshot();
    if (!configuredRef.current) {
      const on = before.amp.on
        ? before
        : applyMediaOptimistic(before, { type: "amp.power", on: true });
      setDemo(applyRadioTune(on, station, pos));
      notify({ text: t("act.tuned", { station: station.name }) });
      return;
    }
    if (!before.amp.on && !before.output) {
      tuneAfterPowerOn.current = pos;
      if (!powerOn?.running) void startPowerOn("NET RADIO");
      return;
    }
    setOptimistic(applyRadioTune(before, station, pos));
    void sendTune(pos);
  };

  /** Enter on the dial: stop / restart the stream; an amp that is off is powered on into the radio. */
  const toggleRadioPlayback = () => {
    const s = latest.current;
    if (!s) return;
    if (!s.amp.on && !s.output) {
      if (!configuredRef.current) void act({ type: "amp.power", on: true });
      else if (!powerOn?.running) void startPowerOn("NET RADIO");
      return;
    }
    void act({
      type: "radio.playback",
      op: s.amp.on && s.amp.state === "playing" ? "stop" : "play",
    });
  };

  /** Left / right on the dial: the neighbour in the current band, wrapping at the ends. */
  const stepStation = (delta: 1 | -1) => {
    const pos = dialRef.current;
    const size = listById(listsRef.current, pos.list)?.stations.length ?? 0;
    const index = wrapIndex(pos.index + delta, size);
    if (index < 0) return;
    tuneTo({ list: pos.list, index });
  };

  /** Band picker: shows the band on the dial (remembered index or its first station); nothing is tuned. */
  const selectBand = (list: string) => {
    setRadio((r) => ({ list, indexByList: r?.indexByList ?? {} }));
    setRadioView("dial");
    notify({ text: t("act.band", { band: bandLabel(lang, list, radioLists) }) });
  };
  /** F3 on the dial: the next band, wrapping (favourites → Düsseldorf → Israel → English). */
  const bandAfter = (list: string): string => {
    const bands = radioBands(radioLists);
    return bands[(bands.indexOf(list) + 1) % bands.length]!;
  };
  const cycleBand = () => selectBand(bandAfter(dialRef.current.list));
  const openStations = () => {
    setCursor(Math.max(0, dialRef.current.index));
    setRadioView("stations");
  };
  /** F1 on the dial: the band picker (favourites, Düsseldorf, Israel, English), cursor on the current band. */
  const openBands = () => {
    setCursor(Math.max(0, radioBands(radioLists).indexOf(dialRef.current.list)));
    setRadioView("bands");
  };
  const stationCount = dialList?.stations.length ?? 0;
  const stationPages = Math.max(1, Math.ceil(stationCount / RADIO_PAGE_SIZE));
  const stationPage = Math.floor(cursor / RADIO_PAGE_SIZE);
  /** F2 / F3 in the station list: previous / next page, cursor on its first row. */
  const pageStations = (delta: 1 | -1) => {
    const page = stationPage + delta;
    if (page < 0 || page >= stationPages) return;
    setCursor(page * RADIO_PAGE_SIZE);
  };

  const isFavourite =
    !!dialStation && (dialPos.list === FAVOURITES_LIST_ID || dialStation.favourite);
  /** MUSIC_BACKEND=ha: the favourites live in Music Assistant; F2 explains that on the dial instead of editing. */
  const favouritesExternal = listsQuery.data?.favouritesExternal ?? false;
  const canFavourite = !!dialStation && (favouritesExternal || isCatalogStationId(dialStation.id));
  /** A short notice shown on the dial itself (the dial has no visible status line). */
  const [dialNotice, setDialNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!dialNotice) return;
    const id = window.setTimeout(() => setDialNotice(null), DIAL_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [dialNotice]);
  /** F2: add the station under the needle to the YTuner bookmarks, or remove it when it is one. */
  const toggleFavourite = () => {
    if (favouritesExternal) {
      setDialNotice(t("radio.favInMa"));
      return;
    }
    const station = dialStation;
    if (!station || !isCatalogStationId(station.id)) return;
    const add = !isFavourite;
    queryClient.setQueryData<RadioListsResult>(RADIO_LISTS_KEY, (old) =>
      old ? toggleFavouriteInLists(old, station, add) : old,
    );
    void act({ type: "radio.favourite", stationId: station.id, add });
  };

  // ---- Music screen: Jellyfin lists per tab and page, the highlighted row, playing a selection ----
  const musicTab: MusicTab = music?.tab ?? "mixes";
  const musicPage = music?.pageByTab[musicTab] ?? 0;
  const musicQuery = useQuery<MusicListResult>({
    queryKey: [MUSIC_LIST_KEY, musicTab, musicPage],
    queryFn: () => getMusicLists({ data: { tab: musicTab, page: musicPage } }),
    enabled: screen === "music",
    staleTime: MUSIC_LIST_STALE_MS,
  });
  const musicList = musicQuery.data ?? null;
  const musicListError = musicQuery.isError ? t("err.server") : (musicList?.error ?? null);
  const musicPages = musicList?.pages ?? 1;
  const musicRows = musicList?.items ?? [];
  const musicCursor = Math.min(cursor, Math.max(0, musicRows.length - 1));
  const musicRef = useRef(music);
  musicRef.current = music;
  const setMusicPage = useCallback(
    (tab: MusicTab, page: number) =>
      setMusic((m) => ({ tab, pageByTab: { ...(m?.pageByTab ?? {}), [tab]: page } })),
    [],
  );
  // The lists change daily: a remembered page past the end comes back clamped by the server.
  useEffect(() => {
    if (musicList && musicList.tab === musicTab && musicList.page !== musicPage)
      setMusicPage(musicTab, musicList.page);
  }, [musicList, musicTab, musicPage, setMusicPage]);
  /** Restores the persisted tab / pages (index route, on mount). */
  const restoreMusic = useCallback((saved: MusicPanelState) => {
    setMusic((m) => m ?? saved);
  }, []);
  const selectMusicTab = (tab: MusicTab) => {
    setMusic((m) => ({ tab, pageByTab: m?.pageByTab ?? {} }));
    setCursor(0);
  };
  /** Left / right: the neighbouring tab in reading order (the row is laid out right-to-left in Hebrew). */
  const stepMusicTab = (delta: 1 | -1) => {
    const i = MUSIC_TABS.indexOf(musicTab) + delta;
    const tab = MUSIC_TABS[i];
    if (tab) selectMusicTab(tab);
  };
  /** F2 / F3 (and page keys): previous / next page, cursor on its first row. */
  const pageMusic = (delta: 1 | -1) => {
    const page = musicPage + delta;
    if (page < 0 || page >= musicPages) return;
    setMusicPage(musicTab, page);
    setCursor(0);
  };
  /** Up / down: the neighbouring row, crossing into the previous / next page at the ends. */
  const stepMusicRow = (delta: 1 | -1) => {
    const next = musicCursor + delta;
    if (next < 0) {
      if (musicPage > 0) {
        setMusicPage(musicTab, musicPage - 1);
        setCursor(MUSIC_PAGE_SIZE - 1);
      }
    } else if (next >= musicRows.length) {
      if (musicPage < musicPages - 1) {
        setMusicPage(musicTab, musicPage + 1);
        setCursor(0);
      }
    } else setCursor(next);
  };

  /** The request itself: the server builds the queue, switches to SERVER and pushes the first track. */
  const sendPlay = async (item: MusicListItem) => {
    const title = musicItemTitle(item, t);
    const before = latest.current ?? demoMediaSnapshot();
    setOptimistic(applyMusicPlay(before, item, null));
    notify({ text: t("music.playing", { title }) });
    inFlight.current += 1;
    try {
      await queryClient.cancelQueries({ queryKey: ["media"] });
      const res = await playMusic({ data: { kind: item.kind, id: item.id } });
      if (res.ok) {
        // Shown until the next snapshot arrives (invalidated below), so the amp view never flashes
        // the previous source in between.
        const snapshot = applyMusicPlay(before, item, res.queue ?? null);
        queryClient.setQueryData<MediaSnapshotResult>(["media"], (old) =>
          old ? { ...old, snapshot } : old,
        );
        notify({ text: t("music.playing", { title }) });
        open("now");
      } else notify({ text: res.error ?? t("err.failed"), error: true });
    } catch {
      notify({ text: t("err.server"), error: true });
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setOptimistic(null);
      void queryClient.invalidateQueries({ queryKey: ["media"] });
      refetchSnapshotSoon();
    }
  };
  /** Plays a row; an amp that is off is powered on into SERVER first and plays when ready. */
  const startPlay = (item: MusicListItem) => {
    const before = latest.current ?? demoMediaSnapshot();
    if (!configuredRef.current) {
      const title = musicItemTitle(item, t);
      setDemo(applyMusicPlay(before, item, demoQueue(title)));
      notify({ text: t("music.playing", { title }) });
      open("now");
      return;
    }
    if (!before.amp.on && !before.output) {
      playAfterPowerOn.current = item;
      if (!powerOn?.running) void startPowerOn("SERVER");
      return;
    }
    void sendPlay(item);
  };
  /** Enter on a row: an artist opens the list of their albums, anything else plays. */
  const playItem = (item: MusicListItem) => {
    if (item.kind === "artist") openArtist(item);
    else startPlay(item);
  };

  // Search screen state lives here because the artist screen remembers where it was opened from.
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);

  // ---- Artist screen (Enter on an artist): their albums, Enter plays one, F4 shuffles them all ----
  const [artist, setArtist] = useState<ArtistState | null>(null);
  const artistQuery = useQuery<ArtistAlbumsResult>({
    queryKey: ["artistAlbums", artist?.item.id ?? "", artist?.page ?? 0],
    queryFn: () =>
      getArtistAlbums({ data: { artistId: artist?.item.id ?? "", page: artist?.page ?? 0 } }),
    enabled: screen === "artist" && !!artist,
    staleTime: MUSIC_LIST_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const artistData = artistQuery.data ?? null;
  const artistRows: MusicListItem[] = artistData?.items ?? [];
  const artistPages = artistData?.pages ?? 1;
  const artistPage = artist?.page ?? 0;
  const artistCursor = Math.min(cursor, Math.max(0, artistRows.length - 1));
  const artistError = artistQuery.isError ? t("err.server") : (artistData?.error ?? null);
  function openArtist(item: MusicListItem) {
    setArtist({ item, page: 0, from: { screen: screen ?? "music", cursor, focus: search.focus } });
    open("artist");
  }
  /** F1 / Escape: back to the list the artist was chosen from, highlight where it was. */
  const backFromArtist = () => {
    const from = artist?.from;
    if (!from) {
      open("music");
      return;
    }
    setScreenState(from.screen);
    setCursor(from.cursor);
    if (from.screen === "search") setSearch((s) => ({ ...s, focus: from.focus }));
  };
  const pageArtist = (delta: 1 | -1) => {
    const page = artistPage + delta;
    if (page < 0 || page >= artistPages) return;
    setArtist((a) => (a ? { ...a, page } : a));
    setCursor(0);
  };
  const stepArtistRow = (delta: 1 | -1) => {
    const next = artistCursor + delta;
    if (next < 0) {
      if (artistPage > 0) {
        setArtist((a) => (a ? { ...a, page: artistPage - 1 } : a));
        setCursor(MUSIC_PAGE_SIZE - 1);
      }
    } else if (next >= artistRows.length) {
      if (artistPage < artistPages - 1) {
        setArtist((a) => (a ? { ...a, page: artistPage + 1 } : a));
        setCursor(0);
      }
    } else setCursor(next);
  };
  /** F4: everything by the artist, shuffled (the server builds the mix). */
  const shuffleArtist = () => {
    if (artist) startPlay(artist.item);
  };

  // ---- Search screen (F4 on the music screen): on-screen keyboard, results from the second character ----
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const term = search.query.trim();
    if (term.length < SEARCH_MIN_CHARS) {
      setSearchTerm("");
      return;
    }
    const timer = setTimeout(() => setSearchTerm(term), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search.query]);
  const searchQuery = useQuery<MusicSearchResult>({
    queryKey: ["musicSearch", searchTerm],
    queryFn: () => searchMusic({ data: { query: searchTerm } }),
    enabled: screen === "search" && searchTerm.length >= SEARCH_MIN_CHARS,
    staleTime: SEARCH_STALE_MS,
    // Keep the previous list on screen while the next one loads: no blank flash on e-ink.
    placeholderData: keepPreviousData,
  });
  const searchActive = search.query.trim().length >= SEARCH_MIN_CHARS;
  const searchRows: MusicListItem[] = searchActive ? (searchQuery.data?.items ?? []) : [];
  const searchError = !searchActive
    ? null
    : searchQuery.isError
      ? t("err.server")
      : (searchQuery.data?.error ?? null);
  const searchLoading = searchActive && (searchQuery.isFetching || searchTerm === "");
  const searchCursor = Math.min(cursor, Math.max(0, searchRows.length - 1));
  const setSearchQueryText = (f: (q: string) => string) =>
    setSearch((s) => {
      const query = f(s.query);
      return query === s.query ? s : { ...s, query, focus: "keys" };
    });
  /** Enter on a key (or a tap on it): appends the character. */
  const typeSearchChar = (ch: string) => {
    setSearchQueryText((q) => appendSearchChar(q, ch, SEARCH_MAX_CHARS));
    setCursor(0);
  };
  const searchBackspace = () => {
    setSearchQueryText((q) => q.slice(0, -1));
    setCursor(0);
  };
  const searchSpace = () => typeSearchChar(" ");
  const focusSearchKeys = () => setSearch((s) => ({ ...s, focus: "keys" }));
  /** F4 / down past the last key row: the highlight moves onto the first result. */
  const focusSearchResults = () => {
    if (!searchRows.length) return;
    setSearch((s) => ({ ...s, focus: "results" }));
    setCursor(0);
  };
  const setSearchKey = (key: number) =>
    setSearch((s) => ({
      ...s,
      focus: "keys",
      key: Math.max(0, Math.min(SEARCH_KEYS.length - 1, key)),
    }));
  /** F4 ("enter"): onto the results from the keyboard, plays the highlighted result from the list. */
  const searchEnter = () => {
    if (search.focus === "keys") focusSearchResults();
    else {
      const item = searchRows[searchCursor];
      if (item) playItem(item);
    }
  };

  // ---- Playlist screen: the server-owned queue (F4 on the amp view while Jellyfin plays) ----
  const queueQuery = useQuery<QueueList | null>({
    queryKey: ["media", "queue"],
    queryFn: () => getQueueTracks(),
    enabled: screen === "queue",
    refetchInterval: screen === "queue" ? POLL_MS : false,
  });
  const queueList = queueQuery.data ?? null;
  const queueTracks = queueList?.tracks ?? [];
  const queueCursor = Math.min(cursor, Math.max(0, queueTracks.length - 1));
  const queuePages = Math.max(1, Math.ceil(queueTracks.length / QUEUE_PAGE_SIZE));
  const queuePage = Math.floor(queueCursor / QUEUE_PAGE_SIZE);
  // Full e-ink refresh on: a list page or music tab change, another artist, the power-on block
  // appearing or going, the amp going on or off, and a song, station or cover change while a
  // now-playing view (amp view, radio, or the Media cards) is showing. Cursor moves are not events.
  const nowPlayingVisible = screen === null || screen === "now" || screen === "radio";
  const nowKey = nowPlayingVisible
    ? `${data?.nowPlaying.title ?? ""}|${data?.nowPlaying.station ?? ""}|${data?.nowPlaying.artItemId ?? ""}`
    : "";
  useFullRefresh(
    [
      musicTab,
      musicPage,
      stationPage,
      artistPage,
      artist?.item.id ?? "",
      queuePage,
      showPowerOn ? 1 : 0,
      data?.amp.on ? 1 : 0,
      data?.amp.available ? 1 : 0,
      nowKey,
    ].join("/"),
  );
  const powerSlot = ampPowerSlot(data, !!powerOn?.running);
  /** F4 on the amp view while the amp is off: the power-on routine (demo mode: the plain action). */
  const powerOnNow = () => {
    if (!configuredRef.current) void act({ type: "amp.power", on: true });
    else if (!powerOn?.running) void startPowerOn();
  };
  const pageQueue = (delta: 1 | -1) => {
    const page = queuePage + delta;
    if (page < 0 || page >= queuePages) return;
    setCursor(Math.min(queueTracks.length - 1, page * QUEUE_PAGE_SIZE));
  };
  /** Enter / F4 on a row: the queue continues from that track; back to the amp view. */
  const jumpQueueTo = (index: number) => {
    if (!queueTracks[index]) return;
    void act({ type: "queue.jump", index });
    open("now");
  };

  const tvOn =
    data?.tv.state !== undefined && !["off", "unavailable", "unknown"].includes(data.tv.state);
  const tvUnavailable = !data || data.tv.state === "unavailable" || data.tv.state === "unknown";
  /** Media tab F1..F4 from the panel config: the music screen, a node's controls, a script, all off or nothing. */
  const mediaKeys = data?.keys ?? ["music", "none", "none", "none"];
  const actions: (DeviceAction | null)[] = mediaKeys.map((key): DeviceAction | null => {
    if (key === "none" || !key) return null;
    if (key === "music")
      // Amp off / standby / unknown: the slot reads Power on (opening music powers the receiver, step block on the
      // music screen); on: Music. A missing output opens the picker instead.
      // Music through HA (an output): always Music, the screen never powers a receiver (task 015).
      return powerSlot === "open" || needsOutput || output
        ? { label: t("media.music"), icon: Music2, onClick: openAmp }
        : {
            label: t("amp.powerOn"),
            icon: Power,
            pressed: powerSlot === "powering",
            onClick: openAmp,
          };
    if (key === "all_off")
      return {
        label: t("power.allOff"),
        icon: Power,
        onClick: () => void act({ type: "all_off" }),
      };
    if (key.startsWith("script."))
      return {
        label: data?.keyLabels?.[key] ?? t("media.script"),
        icon: Zap,
        onClick: () => void act({ type: "script", entity: key }),
      };
    const n = nodes.find((x) => x.id === key);
    if (!n) return null;
    return {
      label: nodeLabel(lang, n.name),
      icon: nodeIcon(n),
      pressed: n.on,
      disabled: !n.available,
      onClick: () => openNode(n.id),
    };
  });
  const nodeSourceKey: DeviceAction | null =
    node && node.sources.length
      ? { label: t("media.source"), icon: Radio, onClick: () => openNodeSources() }
      : null;
  const nodeScreenSlot = (slot: "source" | "stream" | "movie" | null): DeviceAction | null => {
    if (!node || !slot) return null;
    if (slot === "source") return nodeSourceKey;
    if (slot === "stream")
      return node.streams.length
        ? {
            label: t("node.stream", { v: (node.stream ?? "—").toUpperCase() }),
            icon: Speaker,
            disabled: !node.stream,
            onClick: () => {
              const i = node.streams.indexOf(node.stream ?? "");
              const option = node.streams[(i + 1) % node.streams.length];
              if (option) void act({ type: "node", id: node.id, op: "stream", option });
            },
          }
        : null;
    return node.movie
      ? {
          label: t("media.movie"),
          icon: Film,
          pressed: node.movieActive,
          onClick: () =>
            void act({ type: "node", id: node.id, op: "movie", on: !node.movieActive }),
        }
      : null;
  };
  const nodePower = (): void => {
    if (node) void act({ type: "node", id: node.id, op: "power", on: !node.on });
  };
  const openNodeSources = () => {
    open("nodesource");
    setCursor(Math.max(0, node?.sources.indexOf(node.source ?? "") ?? 0));
  };
  const applyNodeSource = (index: number) => {
    const src = node?.sources[index];
    if (node && src === INPUT_NET_RADIO && node.stations?.length) {
      // NET RADIO with the bridge's station list: pick a station (selecting it switches the input too)
      open("nodestation");
      setCursor(
        Math.max(
          0,
          node.stations.findIndex((s) => s.option === node.station),
        ),
      );
      return;
    }
    if (node && src) void act({ type: "node", id: node.id, op: "source", source: src });
    open("node");
  };
  const applyNodeStation = (index: number) => {
    const st = node?.stations?.[index];
    if (node && st) void act({ type: "node", id: node.id, op: "station", option: st.option });
    open("node");
  };
  const outputRows = output?.outputs ?? [];
  const outputKeyActions: (DeviceAction | null)[] = (output?.keys ?? []).map((k) => {
    if (k.startsWith("script."))
      // a script runs instead of picking (e.g. plug on, amp on, input SERVER, output DLNA); back to the music screen
      return {
        label: data?.keyLabels?.[k] ?? t("media.script"),
        icon: Zap,
        onClick: () => {
          void act({ type: "script", entity: k });
          open(outputReturn.current ?? "now");
        },
      };
    const o = outputRows.find((x) => x.entity_id === k);
    return o
      ? {
          label: o.name,
          icon: Speaker,
          pressed: o.entity_id === output?.entity,
          onClick: () => chooseOutput(o.entity_id),
        }
      : null;
  });
  const outputKey: DeviceAction = {
    label: t("media.output"),
    icon: Speaker,
    onClick: () => openOutput(screenRef.current ?? "now"),
  };
  const backToNow: DeviceAction = {
    label: t("amp.back"),
    icon: ArrowLeft,
    onClick: () => open("now"),
  };
  const backToTab: DeviceAction = { label: t("amp.back"), icon: ArrowLeft, onClick: close };
  const sourceKey: DeviceAction = {
    label: t("media.source"),
    icon: Radio,
    onClick: () => open("source"),
  };
  const serverScreen = (data?.amp.on ?? false) && data?.amp.source === "SERVER";
  const modalActions: (DeviceAction | null)[] =
    screen === "node"
      ? [
          backToTab,
          ...(NODE_SCREEN_KEYS[node?.type ?? ""] ?? [null, null]).map(nodeScreenSlot),
          node
            ? {
                label: t("node.power"),
                icon: Power,
                pressed: node.on,
                disabled: !node.available,
                onClick: nodePower,
              }
            : null,
        ]
      : screen === "nodesource"
        ? [
            { label: t("source.cancel"), icon: X, onClick: () => open("node") },
            null,
            null,
            { label: t("source.apply"), icon: Check, onClick: () => applyNodeSource(cursor) },
          ]
        : screen === "nodestation"
          ? [
              { label: t("source.cancel"), icon: X, onClick: () => open("node") },
              null,
              null,
              { label: t("source.apply"), icon: Check, onClick: () => applyNodeStation(cursor) },
            ]
          : screen === "output"
            ? outputKeyActions
            : screen === "now" && output
              ? [
                  // music played by HA: the music screen (no back key: Back / the tab keys leave it)
                  { label: t("radio.title"), icon: Radio, onClick: () => open("radio") },
                  { label: t("amp.library"), icon: ListMusic, onClick: () => open("music") },
                  outputKey,
                  // no Power on here: playing / picking an output wakes the output's receiver (task 015)
                  serverScreen && data?.queue
                    ? { label: t("amp.playlist"), icon: ListOrdered, onClick: () => open("queue") }
                    : null,
                ]
              : screen === "now"
                ? [
                    backToTab,
                    serverScreen
                      ? { label: t("amp.library"), icon: ListMusic, onClick: () => open("music") }
                      : null,
                    sourceKey,
                    serverScreen && data?.queue
                      ? {
                          label: t("amp.playlist"),
                          icon: ListOrdered,
                          onClick: () => open("queue"),
                        }
                      : powerSlot !== "open"
                        ? {
                            label: t("amp.powerOn"),
                            icon: Power,
                            pressed: powerSlot === "powering",
                            onClick: powerOnNow,
                          }
                        : null,
                  ]
                : screen === "source"
                  ? [
                      { label: t("source.cancel"), icon: X, onClick: closeSourceList },
                      null,
                      null,
                      {
                        label: t("source.apply"),
                        icon: Check,
                        onClick: () => {
                          const source = sourceRows[cursor];
                          if (source) applySource(source);
                        },
                      },
                    ]
                  : screen === "tv"
                    ? [
                        { label: t("modal.close"), icon: X, onClick: close },
                        null,
                        {
                          label: t("tv.mute"),
                          icon: VolumeX,
                          disabled: tvUnavailable,
                          onClick: () => void act({ type: "tv", op: "volume_mute" }),
                        },
                        {
                          label: t("tv.power"),
                          icon: Power,
                          pressed: tvOn,
                          disabled: tvUnavailable,
                          onClick: () => void act({ type: "tv", op: "toggle" }),
                        },
                      ]
                    : screen === "radio"
                      ? radioView === "dial"
                        ? [
                            // No back key on the dial: the tab keys leave the radio, F3 opens the source list.
                            {
                              label: bandLabel(lang, dialPos.list, radioLists),
                              icon: Radio,
                              onClick: openBands,
                            },
                            {
                              label: t(isFavourite ? "radio.favRemove" : "radio.favAdd"),
                              icon: Heart,
                              pressed: isFavourite,
                              disabled: !canFavourite,
                              onClick: toggleFavourite,
                            },
                            output ? outputKey : sourceKey,
                            {
                              label: t("radio.stationList"),
                              icon: ListMusic,
                              onClick: openStations,
                            },
                          ]
                        : radioView === "bands"
                          ? [
                              {
                                label: t("source.cancel"),
                                icon: X,
                                onClick: () => setRadioView("dial"),
                              },
                              null,
                              null,
                              {
                                label: t("source.apply"),
                                icon: Check,
                                onClick: () => {
                                  const band = radioBands(radioLists)[cursor];
                                  if (band) selectBand(band);
                                },
                              },
                            ]
                          : [
                              {
                                label: t("amp.back"),
                                icon: ArrowLeft,
                                onClick: () => setRadioView("dial"),
                              },
                              {
                                label: t("radio.prevPage"),
                                icon: ChevronLeft,
                                disabled: stationPage === 0,
                                onClick: () => pageStations(-1),
                              },
                              {
                                label: t("radio.nextPage"),
                                icon: ChevronRight,
                                disabled: stationPage >= stationPages - 1,
                                onClick: () => pageStations(1),
                              },
                              {
                                label: t("source.apply"),
                                icon: Check,
                                onClick: () => {
                                  setRadioView("dial");
                                  tuneTo({ list: dialPos.list, index: cursor });
                                },
                              },
                            ]
                      : screen === "queue"
                        ? [
                            backToNow,
                            {
                              label: t("radio.prevPage"),
                              icon: ChevronLeft,
                              disabled: queuePage === 0,
                              onClick: () => pageQueue(-1),
                            },
                            {
                              label: t("radio.nextPage"),
                              icon: ChevronRight,
                              disabled: queuePage >= queuePages - 1,
                              onClick: () => pageQueue(1),
                            },
                            {
                              label: t("source.apply"),
                              icon: Check,
                              onClick: () => jumpQueueTo(queueCursor),
                            },
                          ]
                        : screen === "music"
                          ? [
                              backToNow,
                              {
                                label: t("radio.prevPage"),
                                icon: ChevronLeft,
                                disabled: musicPage === 0,
                                onClick: () => pageMusic(-1),
                              },
                              {
                                label: t("radio.nextPage"),
                                icon: ChevronRight,
                                disabled: musicPage >= musicPages - 1,
                                onClick: () => pageMusic(1),
                              },
                              {
                                label: t("search.title"),
                                icon: Search,
                                onClick: () => open("search"),
                              },
                            ]
                          : screen === "artist"
                            ? [
                                { label: t("amp.back"), icon: ArrowLeft, onClick: backFromArtist },
                                {
                                  label: t("radio.prevPage"),
                                  icon: ChevronLeft,
                                  disabled: artistPage === 0,
                                  onClick: () => pageArtist(-1),
                                },
                                {
                                  label: t("radio.nextPage"),
                                  icon: ChevronRight,
                                  disabled: artistPage >= artistPages - 1,
                                  onClick: () => pageArtist(1),
                                },
                                {
                                  label: t("artist.shuffle"),
                                  icon: Shuffle,
                                  disabled: !artist,
                                  onClick: shuffleArtist,
                                },
                              ]
                            : screen === "search"
                              ? [
                                  {
                                    label: t("source.cancel"),
                                    icon: X,
                                    onClick: () => open("music"),
                                  },
                                  {
                                    label: t("search.backspace"),
                                    icon: Delete,
                                    disabled: search.query === "",
                                    onClick: searchBackspace,
                                  },
                                  {
                                    label: t("search.space"),
                                    icon: Space,
                                    disabled: search.query === "",
                                    onClick: searchSpace,
                                  },
                                  {
                                    label: t("search.enter"),
                                    icon: CornerDownLeft,
                                    disabled: searchRows.length === 0,
                                    onClick: searchEnter,
                                  },
                                ]
                              : [];

  /** Keys while a media screen is open (soft keys are handled by the shell first). Returns handled. */
  const onKey = (event: KeyboardEvent): boolean => {
    if (!screen) return false;
    if (screen === "output")
      return onListKey(event, outputRows.length, {
        enter: () => {
          const o = outputRows[cursor];
          if (o) chooseOutput(o.entity_id);
        },
        back: closeOutput,
      });
    if (screen === "nodesource")
      return onListKey(event, node?.sources.length ?? 0, {
        enter: () => applyNodeSource(cursor),
        back: () => open("node"),
      });
    if (screen === "nodestation")
      return onListKey(event, node?.stations?.length ?? 0, {
        enter: () => applyNodeStation(cursor),
        back: () => open("node"),
      });
    if (screen === "node") {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        nodePower();
        return true;
      }
      if (event.key === "PageUp" || event.key === "PageDown") {
        close();
        return false;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (node?.on)
          void act({
            type: "node",
            id: node.id,
            op: "volume",
            delta: event.key === "ArrowUp" ? 1 : -1,
          });
        return true;
      }
      return NAV_KEYS.includes(event.key);
    }
    if (screen === "radio" && radioView === "bands") return onRadioBandsKey(event);
    if (screen === "radio" && radioView === "stations") return onRadioListKey(event);
    if (screen === "music") return onMusicKey(event);
    if (screen === "search") return onSearchKey(event);
    if (screen === "artist") return onArtistKey(event);
    if (screen === "queue") return onQueueKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      if (screen === "source") closeSourceList();
      else if (screen === "radio") open("now");
      else close();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (screen === "now") {
        const action = toggleAction(latest.current);
        if (action) void act(action);
      } else if (screen === "source") {
        const source = sourceRows[cursor];
        if (source) applySource(source);
      } else if (screen === "tv") close();
      else if (screen === "radio") toggleRadioPlayback();
      return true;
    }
    // The amp view and the radio dial have no back key: the tab keys close them and the shell then
    // switches the tab.
    if (
      (screen === "now" || screen === "radio") &&
      (event.key === "PageUp" || event.key === "PageDown")
    ) {
      close();
      return false;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (screen === "radio") {
      const s = latest.current;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (s?.amp.on)
          void act({ type: "amp.volume.step", delta: event.key === "ArrowUp" ? 1 : -1 });
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft")
        stepStation(event.key === "ArrowRight" ? 1 : -1);
    } else if (screen === "now") {
      const s = latest.current;
      if (!s || !s.amp.on) return true;
      if (event.key === "ArrowUp" || event.key === "ArrowDown")
        void act({ type: "amp.volume.step", delta: event.key === "ArrowUp" ? 1 : -1 });
      else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        // Physical direction, in both languages: right skips forward like the ▶▶ glyph.
        const action = stepAction(s, event.key === "ArrowRight" ? 1 : -1);
        if (action) void act(action);
      }
    } else if (screen === "source") {
      if (event.key === "ArrowUp" || event.key === "PageUp") setCursor((c) => Math.max(0, c - 1));
      else if (event.key === "ArrowDown" || event.key === "PageDown")
        setCursor((c) => Math.min(sourceRows.length - 1, c + 1));
    }
    return true;
  };

  /** A plain list screen (output picker, node sources): up / down move, Enter applies, Back / Escape leaves. */
  const onListKey = (
    event: KeyboardEvent,
    rows: number,
    on: { enter: () => void; back: () => void },
  ): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      on.back();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      on.enter();
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "ArrowUp" || event.key === "PageUp") setCursor((c) => Math.max(0, c - 1));
    else if (event.key === "ArrowDown" || event.key === "PageDown")
      setCursor((c) => Math.min(Math.max(0, rows - 1), c + 1));
    return true;
  };

  /** Keys on the music screen: left/right switch the tab, up/down move (across pages; page keys jump a
   *  page), Enter plays the highlighted row, Escape backs out to the amp view. */
  const onMusicKey = (event: KeyboardEvent): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      open("now");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = musicRows[musicCursor];
      if (item) playItem(item);
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "ArrowUp") stepMusicRow(-1);
    else if (event.key === "ArrowDown") stepMusicRow(1);
    else if (event.key === "PageUp") pageMusic(-1);
    else if (event.key === "PageDown") pageMusic(1);
    else {
      // Physical direction: in Hebrew the first tab sits at the right end, so right goes back.
      const forward = event.key === "ArrowRight" ? !isRtl(lang) : isRtl(lang);
      stepMusicTab(forward ? 1 : -1);
    }
    return true;
  };

  /** Keys on the artist screen: up/down move (across pages; page keys jump a page), Enter plays the
   *  album, Escape backs out to the list the artist came from. */
  const onArtistKey = (event: KeyboardEvent): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      backFromArtist();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = artistRows[artistCursor];
      if (item) startPlay(item);
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "ArrowUp") stepArtistRow(-1);
    else if (event.key === "ArrowDown") stepArtistRow(1);
    else if (event.key === "PageUp") pageArtist(-1);
    else if (event.key === "PageDown") pageArtist(1);
    return true;
  };

  /** Keys on the search screen. Keyboard half: the 5-way walks the key grid (left / right along a
   *  row, up / down a row), Enter types the key, down past the last row moves onto the results.
   *  Results half: up / down move, up from the first row returns to the keys, Enter plays. The tab
   *  keys jump between the halves; Escape backs out to the music screen. */
  const onSearchKey = (event: KeyboardEvent): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      open("music");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (search.focus === "keys") {
        const ch = SEARCH_KEYS[search.key];
        if (ch) typeSearchChar(ch);
      } else {
        const item = searchRows[searchCursor];
        if (item) playItem(item);
      }
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "PageUp") focusSearchKeys();
    else if (event.key === "PageDown") focusSearchResults();
    else if (search.focus === "keys") {
      const last = SEARCH_KEYS.length - 1;
      if (event.key === "ArrowLeft") setSearchKey(search.key - 1);
      else if (event.key === "ArrowRight") setSearchKey(search.key + 1);
      else if (event.key === "ArrowUp") setSearchKey(search.key - SEARCH_KEY_COLS);
      else if (search.key + SEARCH_KEY_COLS > last) focusSearchResults();
      else setSearchKey(search.key + SEARCH_KEY_COLS);
    } else if (event.key === "ArrowUp") {
      if (searchCursor === 0) focusSearchKeys();
      else setCursor(searchCursor - 1);
    } else if (event.key === "ArrowDown")
      setCursor(Math.min(Math.max(0, searchRows.length - 1), searchCursor + 1));
    return true;
  };

  /** Keys in the station list: up/down move (across pages; page keys jump a page), Enter tunes, Escape backs out. */
  const onRadioListKey = (event: KeyboardEvent): boolean => {
    const size = stationCount;
    if (event.key === "Escape") {
      event.preventDefault();
      setRadioView("dial");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      setRadioView("dial");
      if (cursor < size) tuneTo({ list: dialPos.list, index: cursor });
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    const by = event.key === "PageUp" || event.key === "PageDown" ? RADIO_PAGE_SIZE : 1;
    if (event.key === "ArrowUp" || event.key === "PageUp") setCursor((c) => Math.max(0, c - by));
    else if (event.key === "ArrowDown" || event.key === "PageDown")
      setCursor((c) => Math.min(Math.max(0, size - 1), c + by));
    return true;
  };

  /** Keys in the band picker: up/down move, Enter shows that band on the dial, Escape backs out. */
  const onRadioBandsKey = (event: KeyboardEvent): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      setRadioView("dial");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const band = radioBands(radioLists)[cursor];
      if (band) selectBand(band);
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "ArrowUp" || event.key === "PageUp") setCursor((c) => Math.max(0, c - 1));
    else if (event.key === "ArrowDown" || event.key === "PageDown")
      setCursor((c) => Math.min(radioBands(radioLists).length - 1, c + 1));
    return true;
  };

  /** Keys on the playlist: up/down move (page keys jump a page), Enter plays that track, Escape backs out. */
  const onQueueKey = (event: KeyboardEvent): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      open("now");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      jumpQueueTo(queueCursor);
      return true;
    }
    if (!NAV_KEYS.includes(event.key)) return false;
    event.preventDefault();
    const last = Math.max(0, queueTracks.length - 1);
    if (event.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (event.key === "ArrowDown") setCursor((c) => Math.min(last, c + 1));
    else if (event.key === "PageUp") pageQueue(-1);
    else if (event.key === "PageDown") pageQueue(1);
    return true;
  };

  return {
    screen,
    data,
    configured,
    pollError,
    powerOn,
    showPowerOn,
    cursor,
    setCursor,
    actions,
    modalActions,
    onKey,
    open,
    close,
    act,
    applySource,
    sourceRows,
    sourceName,
    nodeSourceName,
    openAmp,
    restoreScreen,
    // Media tab nodes, output picker
    nodes,
    node,
    openNode,
    output,
    outputRows,
    openOutput,
    chooseOutput,
    lang,
    t,
    // Radio screen
    radioView,
    radioLists,
    radioListsError,
    dialNotice,
    radioListsLoading: listsQuery.isPending,
    dialPos,
    dialStation,
    isFavourite,
    radioState: radio,
    restoreRadio,
    tuneTo,
    selectBand,
    openStations,
    openBands,
    cycleBand,
    stationPage,
    stationPages,
    toggleFavourite,
    // Music screen
    musicTab,
    musicPage,
    musicPages,
    musicRows,
    musicCursor,
    musicListLoading: musicQuery.isPending,
    musicListError,
    musicState: music,
    restoreMusic,
    selectMusicTab,
    playItem,
    // Artist screen
    artistItem: artist?.item ?? null,
    artistData,
    artistRows,
    artistCursor,
    artistPage,
    artistPages,
    artistLoading: artistQuery.isPending,
    artistError,
    backFromArtist,
    shuffleArtist,
    // Search screen
    searchQuery: search.query,
    searchFocus: search.focus,
    searchKey: search.key,
    searchRows,
    searchCursor,
    searchLoading,
    searchError,
    typeSearchChar,
    setSearchKey,
    focusSearchResults,
    // Playlist screen
    queueList,
    queueTracks,
    queueCursor,
    queuePage,
    queuePages,
    queueListLoading: queueQuery.isPending,
    jumpQueueTo,
  };
}
export type MediaPanel = ReturnType<typeof useMediaPanel>;
