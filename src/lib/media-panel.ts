// State and key handling for the media screens (no JSX, so it can sit beside the other lib code).
// The shell calls `useMediaPanel`, renders `MediaCards` / `MediaModal` from media-screens.tsx with
// the returned panel, feeds the footer from `actions` / `modalActions` and forwards keys to `onKey`.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  Heart,
  ListMusic,
  Music2,
  Power,
  Radio,
  Tv,
  VolumeX,
  X,
} from "lucide-react";
import type { DeviceAction } from "@/components/device-actions";
import { useFullRefresh } from "@/lib/eink";
import { makeT } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";
import { demoMediaSnapshot } from "@/lib/media";
import type {
  AmpSource,
  MediaAction,
  MediaSnapshot,
  MediaSnapshotResult,
  PowerOnStatus,
  RadioListsResult,
  RadioPosition,
  RadioStationView,
} from "@/lib/media";
import {
  SOURCE_ROWS,
  applyMediaOptimistic,
  applyRadioTune,
  mediaActionLabel,
  screenForSource,
  stepAction,
  toggleAction,
} from "@/lib/media-ui";
import {
  getMediaSnapshot,
  getPowerOnStatus,
  getRadioLists,
  runMediaAction,
  startAmpPowerOn,
  tuneRadioStation,
} from "@/lib/media.functions";
import type { RadioPanelState } from "@/lib/panel-state";
import {
  RADIO_BANDS,
  bandKey,
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
const POWER_ON_POLL_MS = 2000;
/** HA publishes the new state a moment after an action: refetch the snapshot this long after it resolved. */
const AFTER_ACTION_MS = 2000;
const FAILED_SHOWN_MS = 2 * 60 * 1000;
const NAV_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];

export type MediaScreen = "now" | "source" | "radio" | "music" | "tv";
/** Sub-views of the radio screen: the dial and the station list of the band. */
export type RadioView = "dial" | "stations";
export type MediaNotice = { text: string; error?: boolean };
export const RADIO_PAGE_SIZE = 8;
/** Not under ["media"]: a volume step must not refetch the YTuner lists. */
const RADIO_LISTS_KEY = ["radioLists"] as const;

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
    refetchInterval: active || screen !== null ? POLL_MS : false,
    refetchIntervalInBackground: true,
  });
  const result = query.data;
  const configured = result?.configured ?? true;
  if (result?.configured && result.snapshot) lastGood.current = result.snapshot;
  const data: MediaSnapshot | null =
    result === undefined ? null : !result.configured ? demo : (optimistic ?? lastGood.current);
  const latest = useRef(data);
  latest.current = data;
  const configuredRef = useRef(configured);
  configuredRef.current = configured;
  const pollError = query.isError ? t("err.server") : result?.error;

  // Power-on routine: the snapshot carries the last status; while it runs, poll it every 2 s.
  const fromSnapshot = data?.powerOn ?? null;
  const base =
    localPowerOn && (!fromSnapshot || localPowerOn.startedAt >= fromSnapshot.startedAt)
      ? localPowerOn
      : fromSnapshot;
  const poQuery = useQuery<PowerOnStatus | null>({
    queryKey: ["media", "powerOn"],
    queryFn: () => getPowerOnStatus(),
    enabled: (base?.running ?? false) && screen !== null,
    refetchInterval: POWER_ON_POLL_MS,
    refetchIntervalInBackground: true,
  });
  const powerOn =
    poQuery.data && base && poQuery.data.startedAt >= base.startedAt ? poQuery.data : base;
  const step = powerOn?.step;
  const prevStep = useRef(step);
  /** Station chosen on the dial while the amp was off: tuned once the power-on routine is done. */
  const tuneAfterPowerOn = useRef<RadioPosition | null>(null);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    if (step === "done" || step === "failed") {
      void queryClient.invalidateQueries({ queryKey: ["media"] });
      notify({
        text: step === "done" ? t("poweron.done") : (powerOn?.error ?? t("poweron.failed")),
        error: step === "failed",
      });
      const pending = tuneAfterPowerOn.current;
      tuneAfterPowerOn.current = null;
      if (step === "done" && pending) void sendTune(pending);
      // The screen must match the source the amp ended on: never the music placeholder for NET RADIO.
      // The amp view ("now") shows any source and stays; a closed panel stays closed.
      const want = screenForSource(powerOn?.source ?? null);
      const cur = screenRef.current;
      if (step === "done" && cur !== null && cur !== "now" && cur !== "tv" && cur !== want)
        open(want);
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
      try {
        const res = await startAmpPowerOn({ data: source ? { source } : {} });
        if (res.ok && res.status) {
          setLocalPowerOn(res.status);
          notify({ text: t("act.powerOn") });
        } else notify({ text: res.error ?? t("err.failed"), error: true });
      } catch {
        notify({ text: t("err.server"), error: true });
      }
      refetchSnapshotSoon();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, refetchSnapshotSoon],
  );

  /** F4: off → power-on routine (demo: plain toggle); on → turn off. */
  const togglePower = () => {
    const s = latest.current;
    if (!s) return;
    if (s.amp.on) void act({ type: "amp.power", on: false });
    else if (!configuredRef.current) void act({ type: "amp.power", on: true });
    else void startPowerOn();
  };

  const open = useCallback((next: MediaScreen) => {
    setScreenState((current) => {
      if (current === null) opener.current = document.activeElement as HTMLElement | null;
      return next;
    });
    if (next === "source")
      setCursor(Math.max(0, SOURCE_ROWS.indexOf(latest.current?.amp.source ?? "SERVER")));
    if (next === "radio") setRadioView("dial");
  }, []);
  const close = useCallback(() => setScreenState(null), []);
  useFullRefresh(`${screen ?? ""}/${screen === "radio" ? radioView : ""}`);
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
    if (s && !s.amp.on && configuredRef.current) void startPowerOn(source);
    else void act({ type: "amp.source", source });
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
    if (!before.amp.on) {
      tuneAfterPowerOn.current = pos;
      if (!powerOn?.running) void startPowerOn("NET RADIO");
      return;
    }
    setOptimistic(applyRadioTune(before, station, pos));
    void sendTune(pos);
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
    notify({ text: t("act.band", { band: t(bandKey(list)) }) });
  };
  /** F3 on the dial: the next band, wrapping (favourites → Düsseldorf → Israel → English). */
  const bandAfter = (list: string): string =>
    RADIO_BANDS[
      (RADIO_BANDS.indexOf(list as (typeof RADIO_BANDS)[number]) + 1) % RADIO_BANDS.length
    ]!;
  const cycleBand = () => selectBand(bandAfter(dialRef.current.list));
  const openStations = () => {
    setCursor(Math.max(0, dialRef.current.index));
    setRadioView("stations");
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

  const isFavourite = !!dialStation && (dialPos.list === RADIO_BANDS[0] || dialStation.favourite);
  const canFavourite = !!dialStation && isCatalogStationId(dialStation.id);
  /** F3: add the station under the needle to the YTuner bookmarks, or remove it when it is one. */
  const toggleFavourite = () => {
    const station = dialStation;
    if (!station || !isCatalogStationId(station.id)) return;
    const add = !isFavourite;
    queryClient.setQueryData<RadioListsResult>(RADIO_LISTS_KEY, (old) =>
      old ? toggleFavouriteInLists(old, station, add) : old,
    );
    void act({ type: "radio.favourite", stationId: station.id, add });
  };

  const tvOn =
    data?.tv.state !== undefined && !["off", "unavailable", "unknown"].includes(data.tv.state);
  const tvUnavailable = !data || data.tv.state === "unavailable" || data.tv.state === "unknown";
  const actions: (DeviceAction | null)[] = [
    {
      label: t("media.movie"),
      icon: Film,
      pressed: data?.movieActive ?? false,
      onClick: () => void act({ type: "movie", on: !(data?.movieActive ?? false) }),
    },
    {
      label: t("media.tv"),
      icon: Tv,
      pressed: tvOn,
      disabled: tvUnavailable,
      onClick: () => void act({ type: "tv", op: "toggle" }),
    },
    { label: t("media.amp"), icon: Music2, onClick: () => open("now") },
    { label: t("power.allOff"), icon: Power, onClick: () => void act({ type: "all_off" }) },
  ];
  const powerKey: DeviceAction = {
    label: t("amp.power"),
    icon: Power,
    pressed: data?.amp.on ?? false,
    onClick: togglePower,
  };
  const backToNow: DeviceAction = {
    label: t("amp.back"),
    icon: ArrowLeft,
    onClick: () => open("now"),
  };
  const modalActions: (DeviceAction | null)[] =
    screen === "now"
      ? [
          { label: t("amp.back"), icon: ArrowLeft, onClick: close },
          { label: t("amp.music"), icon: ListMusic, onClick: () => open("music") },
          { label: t("media.source"), icon: Radio, onClick: () => open("source") },
          powerKey,
        ]
      : screen === "source"
        ? [
            { label: t("source.cancel"), icon: X, onClick: () => open("now") },
            null,
            null,
            {
              label: t("source.apply"),
              icon: Check,
              onClick: () => {
                const source = SOURCE_ROWS[cursor];
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
                  backToNow,
                  {
                    label: t(isFavourite ? "radio.favRemove" : "radio.favAdd"),
                    icon: Heart,
                    pressed: isFavourite,
                    disabled: !canFavourite,
                    onClick: toggleFavourite,
                  },
                  {
                    label: t(bandKey(bandAfter(dialPos.list))),
                    icon: Radio,
                    onClick: cycleBand,
                  },
                  powerKey,
                ]
              : [
                  { label: t("amp.back"), icon: ArrowLeft, onClick: () => setRadioView("dial") },
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
            : screen === "music"
              ? [backToNow, null, null, powerKey]
              : [];

  /** Keys while a media screen is open (soft keys are handled by the shell first). Returns handled. */
  const onKey = (event: KeyboardEvent): boolean => {
    if (!screen) return false;
    if (screen === "radio" && radioView !== "dial") return onRadioListKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      if (screen === "now" || screen === "tv") close();
      else open("now");
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (screen === "now") {
        const action = toggleAction(latest.current);
        if (action) void act(action);
      } else if (screen === "source") {
        const source = SOURCE_ROWS[cursor];
        if (source) applySource(source);
      } else if (screen === "tv") close();
      else if (screen === "radio") openStations();
      return true;
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
        setCursor((c) => Math.min(SOURCE_ROWS.length - 1, c + 1));
    }
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
    lang,
    t,
    // Radio screen
    radioView,
    radioLists,
    radioListsError,
    radioListsLoading: listsQuery.isPending,
    dialPos,
    dialStation,
    isFavourite,
    radioState: radio,
    restoreRadio,
    tuneTo,
    selectBand,
    openStations,
    cycleBand,
    stationPage,
    stationPages,
    toggleFavourite,
  };
}
export type MediaPanel = ReturnType<typeof useMediaPanel>;
