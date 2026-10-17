import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Home,
  Sun,
  Lightbulb,
  LampCeiling,
  Sofa,
  Power,
  Plug,
  Music2,
  Bot,
  Play,
  Pause,
  Moon,
  Film,
  RotateCcw,
  MapPin,
  Bed,
  Utensils,
  Bath,
  DoorOpen,
  Baby,
  ShowerHead,
  Battery,
  ArrowLeft,
  Palette,
  X,
  Thermometer,
  Droplets,
  Cloud,
  CloudSun,
  CloudRain,
  CloudSnow,
  CloudFog,
  CloudLightning,
  CloudHail,
  CloudDrizzle,
  CloudMoon,
  Wind,
  CalendarDays,
  Snowflake,
  Gauge,
  Zap,
  Leaf,
  BookOpen,
  Star,
  Sparkles,
  Lamp,
  Fan,
  Tv,
} from "lucide-react";
import { DeviceRow } from "@/components/device-row";
import { Button } from "@/components/ui/button";
import {
  DeviceActions,
  flashSoftKey,
  pressSoftKey,
  type DeviceAction,
} from "@/components/device-actions";
import { LightModal, PickerModal, PlugModal, pickerValues } from "@/components/light-modals";
import { MediaCards, MediaModal } from "@/components/media-screens";
import { useMediaPanel } from "@/lib/media-panel";
import { loadPanelState, persistableScreen, savePanelState, type TabName } from "@/lib/panel-state";
import { isCustomTab } from "@/lib/panel-config";
import type { PanelView, TabId } from "@/lib/panel-config";
import { SpotLightIcon, StripLightIcon } from "@/components/light-icons";
import { useFullRefresh } from "@/lib/eink";
import { BatteryBadge } from "@/components/battery-badge";
import { useKindleBattery } from "@/lib/battery";
import { dateLocale, isRtl, makeT } from "@/lib/i18n";
import { LangContext } from "@/lib/lang-context";
import type { Key } from "@/lib/i18n";
import screensaverPhoto from "@/assets/screensaver-preview.jpg";
import {
  COLORS,
  CUSTOM_TABS,
  LIGHTS,
  applyHomeConfig,
  localName,
  PLUGS,
  POWER_KEYS,
  ROOMS,
  SAVER_CARDS,
  SCENES,
  isMovieScene,
  sceneLabel,
  softKeyTarget,
  SHADES,
  SHADE_NAMES,
  actionLabel,
  applyOptimistic,
  conditionLabel,
  demoSnapshot,
  emptySnapshot,
  vacuumLabel,
} from "@/lib/home";
import type { Action, LightState, Snapshot, SnapshotResult } from "@/lib/home";
import type { SceneButton } from "@/lib/panel-config";
import { getScreensaver, getSnapshot, markScreensaverPhoto, runAction } from "@/lib/home.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home Control · Kindle" },
      {
        name: "description",
        content:
          "A 600 × 800 grayscale home control panel with lights, vacuum, power and media views.",
      },
      { property: "og:title", content: "Home Control · Kindle" },
      {
        property: "og:description",
        content: "Four simple home-control views designed for a non-touch e-ink screen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: () => getSnapshot(),
  component: HomeControl,
});

/** A tab of the bar; custom tabs carry their (English) title, shown through the names mechanism. */
type TabEntry = { name: TabName; icon: typeof Lightbulb; title?: string };
const ALL_TABS: Record<Exclude<TabId, `custom:${string}`>, TabEntry> = {
  lights: { name: "Lights", icon: Lightbulb },
  vacuum: { name: "Vacuum", icon: Bot },
  power: { name: "Power", icon: Plug },
  media: { name: "Media", icon: Music2 },
};
/** Tabs in the configured order (panel config: tabs); rewritten in place when a new config arrives. */
const tabs: TabEntry[] = (["lights", "vacuum", "power", "media"] as const).map(
  (id) => ALL_TABS[id],
);
type IconComponent = (props: { size?: number; strokeWidth?: number }) => ReactNode;
const LIGHT_ICONS: Record<string, IconComponent> = {
  lamp_ceiling: LampCeiling,
  spot: SpotLightIcon,
  strip: StripLightIcon,
  lamp: LampCeiling,
  bulb: Lightbulb,
};
const ROOM_ICONS: Record<string, IconComponent> = {
  shower: ShowerHead,
  baby: Baby,
  door: DoorOpen,
  utensils: Utensils,
  home: Home,
  bath: Bath,
  bed: Bed,
  sofa: Sofa,
  room: Home,
};
const CARD_ICONS: Record<string, IconComponent> = {
  thermometer: Thermometer,
  droplets: Droplets,
  gauge: Gauge,
  zap: Zap,
  plug: Plug,
  wind: Wind,
  sun: Sun,
  leaf: Leaf,
  home: Home,
  battery: Battery,
};
/** The configuration that came with the snapshot, applied to the shared constants before anything renders. */
let appliedPanel = "";
function applyPanel(panel: PanelView | undefined) {
  if (!panel) return;
  const key = JSON.stringify(panel);
  if (key === appliedPanel) return;
  appliedPanel = key;
  applyHomeConfig(panel);
  tabs.splice(
    0,
    tabs.length,
    ...panel.tabs.map((id): TabEntry => {
      if (!isCustomTab(id)) return ALL_TABS[id];
      const custom = panel.custom_tabs[id.slice("custom:".length)];
      return {
        name: id,
        icon: TOGGLE_ICONS[custom?.icon ?? ""] ?? Star,
        title: custom?.title ?? id,
      };
    }),
  );
  screensaverIdleMs = panel.screensaver.idle_minutes * 60 * 1000;
}
const weatherIcons: Record<string, typeof Sun> = {
  sunny: Sun,
  "clear-night": Moon,
  cloudy: Cloud,
  partlycloudy: CloudSun,
  rainy: CloudRain,
  pouring: CloudRain,
  snowy: CloudSnow,
  "snowy-rainy": CloudSnow,
  fog: CloudFog,
  lightning: CloudLightning,
  "lightning-rainy": CloudLightning,
  hail: CloudHail,
  windy: Wind,
  "windy-variant": Wind,
};
const weatherIcon = (condition: string | null) =>
  (condition && weatherIcons[condition]) || (condition === null ? CloudDrizzle : CloudMoon);
/** Scene button icons (panel config: scenes[].icon). */
const SCENE_ICONS: Record<string, typeof Sun> = {
  sun: Sun,
  moon: Moon,
  film: Film,
  sofa: Sofa,
  bed: Bed,
  book: BookOpen,
  utensils: Utensils,
  star: Star,
  sparkles: Sparkles,
  power: Power,
};
/** Custom tab and toggle icons (panel config: custom_tabs[].icon, toggles[].icon). */
const TOGGLE_ICONS: Record<string, typeof Sun> = {
  plug: Plug,
  bulb: Lightbulb,
  lamp: Lamp,
  fan: Fan,
  power: Power,
  tv: Tv,
  zap: Zap,
  leaf: Leaf,
  home: Home,
  star: Star,
};
/** Keeps numbers and units in reading order inside right-to-left text. */
const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr">{children}</bdi>;
const fmt = (value: number | null, digits = 1) => (value === null ? "—" : value.toFixed(digits));
const SAMPLE_REFRESH_MS = 10 * 60 * 1000;
const MODAL_IDLE_MS = 30 * 1000;
let screensaverIdleMs = 5 * 60 * 1000;

function HomeControl() {
  const [chosenTab, setTab] = useState<TabName>("Lights");
  // A tab the panel config does not show (or a remembered one that was removed) falls back to the first one.
  const tab: TabName = tabs.some((x) => x.name === chosenTab)
    ? chosenTab
    : (tabs[0]?.name ?? "Lights");
  const [scene, setScene] = useState("");
  const [locating, setLocating] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const [modal, setModal] = useState<{
    kind: "light" | "shade" | "color" | "plug";
    index: number;
  } | null>(null);
  const [cursor, setCursor] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  // F1 on the screensaver marks the shown Immich photo as "looks good on e-ink". The handler lives in
  // a ref so the wake listener (registered once per screensaver state) always sees the current photo.
  const markPhoto = useRef<() => void>(() => {});
  // F4 skips to the next photo without judging this one.
  const skipPhoto = useRef<() => void>(() => {});
  const [marking, setMarking] = useState(false);
  const battery = useKindleBattery();
  // F1 / F4 on the saver ask for a new photo even inside the night window (no automatic rotation there).
  const forceNextPhoto = useRef(false);
  // Tell the bridge where the photo is (x,y,w,h in CSS pixels) so it can dither only that region.
  const publishPhotoRegion = () => {
    const box = photoRef.current?.getBoundingClientRect();
    if (box)
      document.documentElement.setAttribute(
        "data-eink-photo",
        [box.x, box.y, box.width, box.height].map(Math.round).join(","),
      );
  };
  const [now, setNow] = useState(() => new Date(2026, 9, 6));
  const screen = useRef<HTMLDivElement>(null);
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const queryClient = useQueryClient();
  const loaded = Route.useLoaderData();
  const query = useQuery<SnapshotResult>({
    queryKey: ["snapshot"],
    queryFn: () => getSnapshot(),
    initialData: loaded,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  });
  const result = query.data;
  applyPanel(result.panel);
  const lang = result.lang;
  const t = makeT(lang);
  const rtl = isRtl(lang);
  const locale = dateLocale(lang);
  const dateLabel = now.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const calendar = {
    day: String(now.getDate()),
    month: now.toLocaleDateString(locale, { month: "long" }),
    weekday: now.toLocaleDateString(locale, { weekday: "long" }),
  };
  const configured = result.configured;
  const lastGood = useRef<Snapshot | null>(null);
  if (result.snapshot) lastGood.current = result.snapshot;
  const [demo, setDemo] = useState(demoSnapshot);
  const [optimistic, setOptimistic] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const inFlight = useRef(0);
  const locateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const data: Snapshot = !configured ? demo : (optimistic ?? lastGood.current ?? emptySnapshot());
  const serverText = (text: string) =>
    text === "HA unreachable"
      ? t("err.ha")
      : text === "HA rejected token"
        ? t("err.token")
        : text === "Immich unreachable"
          ? t("err.immich")
          : text;
  const pollError = query.isError ? t("err.server") : result.error;
  const status = !configured
    ? t("status.demo", { text: notice?.text ?? t("status.notConfigured") })
    : pollError
      ? `${t("status.disconnected")} · ${serverText(pollError)}`
      : notice
        ? notice.error
          ? notice.text
          : t("status.done", { text: notice.text })
        : t("status.connected");
  const photo = useQuery({
    queryKey: ["screensaver"],
    queryFn: () => {
      const force = forceNextPhoto.current;
      forceNextPhoto.current = false;
      return getScreensaver({ data: { force } });
    },
    enabled: screensaver,
    // Rotation period = the Kindle's day wake interval (DAY_WAKE_MIN), so every photo gets one wake.
    refetchInterval: (result.photoMinutes ?? SAMPLE_REFRESH_MS / 60_000) * 60_000,
    staleTime: 0,
    gcTime: 0,
  });

  const act = useCallback(
    async (action: Action) => {
      if (!configured) {
        setDemo((current) => applyOptimistic(current, action));
        setNotice({ text: actionLabel(action, lang) });
        return;
      }
      setOptimistic((current) =>
        applyOptimistic(current ?? lastGood.current ?? emptySnapshot(), action),
      );
      inFlight.current += 1;
      try {
        await queryClient.cancelQueries({ queryKey: ["snapshot"] });
        const res = await runAction({ data: action });
        if (res.ok) {
          setNotice({ text: actionLabel(action, lang) });
          if (res.snapshot)
            queryClient.setQueryData<SnapshotResult>(["snapshot"], {
              configured: true,
              snapshot: res.snapshot,
              lang,
            });
        } else
          setNotice({ text: res.error ? serverText(res.error) : t("err.failed"), error: true });
      } catch {
        setNotice({ text: t("err.server"), error: true });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setOptimistic(null);
        void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configured, queryClient, lang],
  );

  const media = useMediaPanel({
    active: tab === "Media",
    lang,
    notify: ({ text, error }) =>
      setNotice(error ? { text: serverText(text), error: true } : { text }),
    onHomeChanged: () => void queryClient.invalidateQueries({ queryKey: ["snapshot"] }),
  });
  const mediaClose = media.close;
  const mediaOpen = media.restoreScreen;
  const mediaRestoreRadio = media.restoreRadio;
  const mediaRestoreMusic = media.restoreMusic;
  const mediaStatus =
    configured && media.pollError
      ? `${t("status.disconnected")} · ${serverText(media.pollError)}`
      : status;

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = rtl ? "rtl" : "ltr";
  }, [lang, rtl]);

  // Owner's rule (2026-10-15): no screensaver only while the amp is ON (power on, any source — the amp
  // cannot tell whether CD / PHONO / TV inputs play, so no playback check) AND the panel is on the amp
  // view, the "now playing" display. Everywhere else, and once the amp is off, the saver starts
  // SCREENSAVER_IDLE_MS after the last key. The power state comes from the Media snapshot the panel
  // already polls (no extra timers): an amp going off while the view sits idle brings the saver with
  // the next snapshot. Only key presses count as activity — snapshot polls and refresh hints never do.
  const keepAwake = media.screen === "now" && !!media.data?.amp.on;
  const lastKeyAt = useRef(Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      if (keepAwake) return;
      const left = screensaverIdleMs - (Date.now() - lastKeyAt.current);
      timer = setTimeout(() => setScreensaver(true), Math.max(0, left));
    };
    const wake = (event: Event) => {
      lastKeyAt.current = Date.now();
      if (screensaver) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event instanceof KeyboardEvent && event.key === "F1") {
          markPhoto.current();
          return;
        }
        if (event instanceof KeyboardEvent && event.key === "F4") {
          skipPhoto.current();
          return;
        }
        setScreensaver(false);
      }
      reset();
    };
    reset();
    document.addEventListener("keydown", wake, true);
    document.addEventListener("pointerdown", wake, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", wake, true);
      document.removeEventListener("pointerdown", wake, true);
    };
  }, [screensaver, keepAwake]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (modal) screen.current?.querySelector<HTMLElement>(".full-modal")?.focus();
  }, [modal]);
  const modalOpen = modal !== null;
  useFullRefresh(tab);
  useFullRefresh(modal ? `${modal.kind}:${modal.index}` : "");
  useFullRefresh(screensaver ? "saver" : "");
  // A new picture flashes; the same picture served again (night window) does not.
  useFullRefresh(photo.data?.assetId ?? photo.data?.image ?? "");
  // Tell the bridge the screensaver is showing (<html data-eink-saver="1">): with no key for 5 min the
  // Kindle may then switch its Wi-Fi radio off between updates (bridge /schedule, docs/battery-saver-plan.md).
  useEffect(() => {
    if (screensaver) document.documentElement.dataset["einkSaver"] = "1";
    else delete document.documentElement.dataset["einkSaver"];
    return () => {
      delete document.documentElement.dataset["einkSaver"];
    };
  }, [screensaver]);
  useEffect(() => {
    if (modalOpen) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [modalOpen]);
  // A tab opens with its main control already selected (the first light card on Lights), so every
  // light is at most two moves away instead of a first press only "waking" the selection on the
  // screensaver icon.
  useEffect(() => {
    if (modalOpen || screensaver) return;
    const content = screen.current?.querySelector<HTMLElement>(".content");
    if (!content || content.contains(document.activeElement)) return;
    (
      content.querySelector<HTMLElement>("[data-autofocus]") ??
      content.querySelector<HTMLElement>("button:not(:disabled)")
    )?.focus();
  }, [tab, modalOpen, screensaver]);

  // Light / plug / picker modals close after 30 s without a key press and when the screensaver starts.
  // The media screens (amp view, source list, radio, music) are "now playing" views and stay open.
  useEffect(() => {
    if (!modalOpen) return;
    let timer = setTimeout(() => setModal(null), MODAL_IDLE_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setModal(null), MODAL_IDLE_MS);
    };
    document.addEventListener("keydown", reset, true);
    document.addEventListener("pointerdown", reset, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", reset, true);
      document.removeEventListener("pointerdown", reset, true);
    };
  }, [modalOpen]);
  useEffect(() => {
    if (screensaver) setModal(null);
  }, [screensaver]);
  // Remember tab + media screen so a page reload or a screensaver wake lands where the user was.
  const restored = useRef(false);
  useEffect(() => {
    const saved = loadPanelState();
    if (saved) {
      setTab(saved.tab);
      if (saved.mediaScreen) mediaOpen(saved.mediaScreen);
      if (saved.radio) mediaRestoreRadio(saved.radio);
      if (saved.music) mediaRestoreMusic(saved.music);
    }
    restored.current = true;
  }, [mediaOpen, mediaRestoreRadio, mediaRestoreMusic]);
  // The playlist is a detour from the amp view: a reload comes back to the amp view.
  const mediaScreenToSave = persistableScreen(
    media.screen === "queue"
      ? "now"
      : media.screen === "search" || media.screen === "artist"
        ? "music"
        : media.screen,
  );
  const radioToSave = media.radioState;
  const musicToSave = media.musicState;
  useEffect(() => {
    if (restored.current)
      savePanelState({
        tab,
        mediaScreen: mediaScreenToSave,
        ...(radioToSave ? { radio: radioToSave } : {}),
        ...(musicToSave ? { music: musicToSave } : {}),
      });
  }, [tab, mediaScreenToSave, radioToSave, musicToSave]);
  const photoSrc = photo.data?.image ?? "";
  const photoAssetId = photo.data?.assetId ?? null;
  const photoRefetch = photo.refetch;
  markPhoto.current = () => {
    if (!photoAssetId || marking) return;
    forceNextPhoto.current = true;
    setMarking(true);
    void markScreensaverPhoto({ data: { id: photoAssetId, verdict: "keep" } })
      .then((res) => {
        if (!res.ok) console.error("mark photo failed:", res.error);
        // Marked photos leave the pool, so the next pick is a different, unjudged favourite.
        return photoRefetch();
      })
      .finally(() => setMarking(false));
  };
  skipPhoto.current = () => {
    if (marking || photo.isFetching) return;
    forceNextPhoto.current = true;
    // F4 = skip for good (stored in Home Assistant with the kindle_panel integration), then the next photo
    // (asked once the skip is stored, so HA never hands the skipped one back).
    if (!photoAssetId) {
      void photoRefetch();
      return;
    }
    setMarking(true); // a second F4 meanwhile does nothing
    void markScreensaverPhoto({ data: { id: photoAssetId, verdict: "skip" } })
      .catch(() => undefined)
      .then(() => photoRefetch())
      .finally(() => setMarking(false));
  };
  // While a mark + next photo is in flight the bridge holds its post-key screenshot (data-eink-busy),
  // so the Kindle gets the new photo in the key's own redraw instead of the next poll.
  const photoBusy = screensaver && (marking || photo.isFetching);
  useEffect(() => {
    if (photoBusy) document.documentElement.dataset["einkBusy"] = "1";
    else delete document.documentElement.dataset["einkBusy"];
    return () => {
      delete document.documentElement.dataset["einkBusy"];
    };
  }, [photoBusy]);
  useEffect(() => {
    if (!screensaver) return;
    publishPhotoRegion();
    return () => document.documentElement.removeAttribute("data-eink-photo");
  }, [screensaver, photoSrc]);

  const changeLight = (index: number, amount: number) => {
    const light = data.lights[index];
    if (!light || (!light.on && amount < 0)) return;
    const meta = LIGHTS[index];
    if (meta)
      act({
        type: "light.brightness",
        entity: meta.id,
        pct: Math.max(1, Math.min(100, (light.on ? light.level : 0) + amount)),
      });
  };
  const applyScene = (row: SceneButton) => {
    // Scripts (movie mode, …) are actions, not states: their button never stays pressed.
    setScene(row.entity_id.startsWith("script.") || isMovieScene(row) ? "" : row.entity_id);
    act({ type: "scene", entity: row.entity_id });
  };
  const locate = () => {
    setLocating(true);
    clearTimeout(locateTimer.current);
    locateTimer.current = setTimeout(() => setLocating(false), 8000);
    act({ type: "vacuum", op: "locate" });
  };
  const shot = photo.data;
  const sampleNote = shot?.note ? serverText(shot.note) : t("photo.sample");
  const readings = shot?.result.snapshot && configured ? shot.result.snapshot : data;
  const SIcon = weatherIcon(readings.weather.condition);

  /** "96% · Warm"; colour names only for lights that can do colour. */
  const lightLine = (light: LightState) => (
    <>
      {light.on ? <Ltr>{light.level}%</Ltr> : t("lights.off")} ·{" "}
      {light.canColor && light.color !== "White"
        ? t(`color.${light.color as (typeof COLORS)[number]}`)
        : t(`shade.${light.shade}`)}
    </>
  );
  const modalLight = modal ? data.lights[modal.index] : undefined;
  const modalMeta = modal ? LIGHTS[modal.index] : undefined;
  const openModal = (kind: "light" | "shade" | "color" | "plug", index: number) => {
    if (!modal) opener.current = document.activeElement as HTMLElement | null;
    const light = data.lights[index];
    if (kind === "shade") setCursor(Math.max(0, SHADE_NAMES.indexOf(light?.shade ?? "Neutral")));
    if (kind === "color")
      setCursor(Math.max(0, COLORS.indexOf((light?.color ?? "White") as (typeof COLORS)[number])));
    setModal({ kind, index });
  };
  const pick = (kind: "shade" | "color", index: number, next: number) => {
    const entity = LIGHTS[index]?.id;
    if (!entity) return;
    setCursor(next);
    setScene("");
    if (kind === "shade")
      act({ type: "light.kelvin", entity, kelvin: SHADES[SHADE_NAMES[next] ?? "Neutral"] });
    else act({ type: "light.color", entity, color: COLORS[next] ?? "White" });
  };
  const cold = modalLight?.shade === "Cool" && modalLight.color === "White";
  const modalPlug = modal?.kind === "plug" ? data.plugs[modal.index] : undefined;
  const modalActions: (DeviceAction | null)[] = !modal
    ? []
    : modal.kind === "plug"
      ? [
          { label: t("modal.close"), icon: X, onClick: () => setModal(null) },
          null,
          {
            label: t("modal.power"),
            icon: Power,
            pressed: modalPlug?.on ?? false,
            onClick: () => {
              const entity = PLUGS[modal.index]?.id;
              if (entity) act({ type: "switch.toggle", entity });
            },
          },
          null,
        ]
      : modal.kind === "light"
        ? [
            { label: t("modal.close"), icon: X, onClick: () => setModal(null) },
            {
              // Only colour-capable lights get the colour picker; the others go straight to white tones.
              label: modalLight?.canColor ? t("modal.colorWhite") : t("modal.shadeTitle"),
              icon: Palette,
              onClick: () => openModal(modalLight?.canColor ? "color" : "shade", modal.index),
            },
            {
              label: t("modal.power"),
              icon: Power,
              pressed: modalLight?.on ?? false,
              onClick: () => {
                const entity = modalMeta?.id;
                if (!entity) return;
                setScene("");
                act({ type: "light.toggle", entity });
              },
            },
            {
              label: t("modal.warmCold"),
              icon: cold ? Snowflake : Sun,
              pressed: cold,
              onClick: () => {
                const entity = modalMeta?.id;
                if (!entity) return;
                setScene("");
                act({ type: "light.kelvin", entity, kelvin: cold ? SHADES.Warm : SHADES.Cool });
              },
            },
          ]
        : [
            { label: t("modal.close"), icon: X, onClick: () => setModal(null) },
            {
              label: t("modal.back"),
              icon: ArrowLeft,
              onClick: () => setModal({ kind: "light", index: modal.index }),
            },
          ];

  const plugOn = (index: number) => data.plugs[index]?.on ?? false;
  /** The open custom tab (tab name `custom:<id>`), its live state, and its F1..F4 (the same key model as Power). */
  const customId = isCustomTab(tab) ? tab.slice("custom:".length) : "";
  const custom = customId ? CUSTOM_TABS[customId] : undefined;
  const customState = data.custom?.[customId];
  const customOn = (index: number) => customState?.on[index] ?? false;
  const customActions = (): (DeviceAction | null)[] => {
    if (!custom) return [];
    const ids = custom.toggles.map((x) => x.entity_id);
    return custom.keys.map((key) => {
      const target = softKeyTarget(key, ids);
      if (!target) return null;
      if (target.kind === "all_off")
        return {
          label: t("power.allOff"),
          icon: Power,
          onClick: () => act({ type: "custom.off", tab: customId }),
        };
      if (target.kind === "run") {
        const name = customState?.names[target.entity] ?? target.entity;
        return {
          label: localName(lang, name),
          icon: target.entity.startsWith("scene.") ? Sparkles : Play,
          onClick: () => act({ type: "custom.run", tab: customId, entity: target.entity, name }),
        };
      }
      const row = custom.toggles[target.index]!;
      return {
        label: localName(lang, row.name),
        icon: TOGGLE_ICONS[row.icon] ?? Plug,
        pressed: customOn(target.index),
        onClick: () => act({ type: "custom.toggle", tab: customId, entity: row.entity_id }),
      };
    });
  };
  const cleaning = data.vacuum.state === "cleaning";
  const actions: (DeviceAction | null)[] =
    tab === "Lights"
      ? [
          // F1..F3: the configured scene buttons (panel config: scenes), blank slots for missing ones.
          ...[0, 1, 2].map((slot) => {
            const row = SCENES[slot];
            return row
              ? {
                  label: sceneLabel(lang, row.name),
                  icon: SCENE_ICONS[row.icon] ?? Star,
                  pressed: scene === row.entity_id,
                  onClick: () => applyScene(row),
                }
              : null;
          }),
          {
            label: t("lights.alloff"),
            icon: Power,
            onClick: () => {
              setScene("");
              act({ type: "lights.off" });
            },
          },
        ]
      : tab === "Vacuum"
        ? [
            {
              label: cleaning ? t("vacuum.pause") : t("vacuum.start"),
              icon: cleaning ? Pause : Play,
              pressed: cleaning,
              onClick: () => act({ type: "vacuum", op: cleaning ? "pause" : "start" }),
            },
            {
              label: t("vacuum.dock"),
              icon: Home,
              onClick: () => act({ type: "vacuum", op: "dock" }),
            },
            { label: t("vacuum.locate"), icon: MapPin, pressed: locating, onClick: locate },
            {
              label: t("vacuum.cleanAll"),
              icon: RotateCcw,
              onClick: () => {
                act({ type: "rooms.clear" });
                act({ type: "vacuum", op: "start" });
              },
            },
          ]
        : tab === "Power"
          ? [
              // F1..F4 as configured (panel config: power_keys): a plug, all plugs off, or a blank key.
              ...POWER_KEYS.map((key) => {
                const target = softKeyTarget(
                  key,
                  PLUGS.map((p) => p.id),
                );
                if (!target || target.kind === "run") return null; // the Power page offers no scripts
                if (target.kind === "all_off")
                  return {
                    label: t("power.allOff"),
                    icon: Power,
                    onClick: () => {
                      PLUGS.forEach((meta, index) => {
                        if (plugOn(index)) act({ type: "switch.toggle", entity: meta.id });
                      });
                    },
                  };
                const meta = PLUGS[target.index]!;
                return {
                  label: localName(lang, meta.name),
                  icon: Plug,
                  pressed: plugOn(target.index),
                  onClick: () => act({ type: "switch.toggle", entity: meta.id }),
                };
              }),
            ]
          : tab === "Media"
            ? media.actions
            : customActions();

  keyHandler.current = (event) => {
    const footer = media.screen ? media.modalActions : modal ? modalActions : actions;
    if (pressSoftKey(footer, event.key)) {
      event.preventDefault();
      flashSoftKey(event.key);
      return;
    }
    if (media.screen) {
      // The media screens own every key while open, except the tab keys on the amp view and the
      // radio dial: those close the screen (returning false) and fall through to the tab switch.
      if (media.onKey(event)) return;
      if (event.key !== "PageUp" && event.key !== "PageDown") return;
    }
    if (modal) {
      if (event.key === "Escape" || (event.key === "Enter" && modal.kind !== "light")) {
        event.preventDefault();
        setModal(null);
        return;
      }
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (modal.kind === "plug") return;
      if (modal.kind === "light") {
        const up = ["ArrowUp", "ArrowRight", "PageDown"].includes(event.key);
        changeLight(modal.index, up ? 10 : -10);
        return;
      }
      const count = pickerValues(modal.kind).length;
      const step = modal.kind === "shade" ? 1 : 3;
      // The grid reads right to left in Hebrew, so ArrowLeft moves to the next item there.
      const side = rtl ? -1 : 1;
      const delta =
        event.key === "PageUp"
          ? -1
          : event.key === "PageDown"
            ? 1
            : event.key === "ArrowLeft"
              ? -side
              : event.key === "ArrowRight"
                ? side
                : event.key === "ArrowUp"
                  ? -step
                  : step;
      const next = Math.max(0, Math.min(count - 1, cursor + delta));
      if (next !== cursor) pick(modal.kind, modal.index, next);
      return;
    }
    if (
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "PageUp" || event.key === "PageDown") {
      const index = tabs.findIndex((item) => item.name === tab);
      const n = tabs.length;
      setTab(tabs[(index + (event.key === "PageDown" ? 1 : n - 1) + n) % n]?.name ?? "Lights");
      return;
    }
    const controls = Array.from(
      // Arrow keys only ever move within the content: tabs are PageUp/PageDown, the footer is F1..F4.
      screen.current?.querySelectorAll<HTMLButtonElement>(".content button:not(:disabled)") ?? [],
    );
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !controls.includes(active as HTMLButtonElement)) {
      (
        screen.current?.querySelector<HTMLElement>(".content [data-autofocus]") ?? controls[0]
      )?.focus();
      return;
    }
    const origin = active.getBoundingClientRect();
    const ox = origin.x + origin.width / 2;
    const oy = origin.y + origin.height / 2;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const target = controls
      .filter((control) => control !== active)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        const dx = rect.x + rect.width / 2 - ox;
        const dy = rect.y + rect.height / 2 - oy;
        const along = horizontal ? dx : dy;
        const across = horizontal ? dy : dx;
        return { control, along: along * sign, score: Math.abs(along) + Math.abs(across) * 3 };
      })
      .filter((item) => item.along > 2)
      .sort((a, b) => a.score - b.score)[0];
    target?.control.focus();
  };

  if (screensaver)
    return (
      <LangContext.Provider value={lang}>
        <div className="screen-stage">
          <div className="kindle-screen photo-screen" aria-label={t("photo.label")}>
            <img
              ref={photoRef}
              onLoad={publishPhotoRegion}
              src={shot?.image ?? screensaverPhoto}
              width={600}
              height={800}
              alt={
                shot?.credit
                  ? t("photo.altUnsplash")
                  : shot?.image
                    ? t("photo.altImmich")
                    : t("photo.altSample")
              }
            />
            {battery && <BatteryBadge battery={battery} variant="photo" />}
            <div
              className="photo-caption"
              style={
                SAVER_CARDS.length === 3
                  ? undefined
                  : {
                      gridTemplateColumns: `repeat(${Math.max(1, SAVER_CARDS.length)}, minmax(0, 1fr))`,
                    }
              }
            >
              {SAVER_CARDS.map((card, i) => {
                if (card.type === "outdoor")
                  return (
                    <section className="photo-block" key={i}>
                      <h2>{t("photo.outdoor")}</h2>
                      <SIcon size={38} strokeWidth={1.5} />
                      <strong className="climate-reading">
                        <Ltr>
                          {readings.weather.temp === null ? "—" : `${fmt(readings.weather.temp)}°`}
                        </Ltr>
                      </strong>
                      <span>{conditionLabel(readings.weather.condition, lang)}</span>
                    </section>
                  );
                if (card.type === "indoor")
                  return (
                    <section className="photo-block" key={i}>
                      <h2>{t("photo.indoor")}</h2>
                      <Thermometer size={34} strokeWidth={1.5} />
                      <strong className="climate-reading">
                        <Ltr>
                          {readings.indoor.temp === null ? "—" : `${fmt(readings.indoor.temp)}°`}
                        </Ltr>
                      </strong>
                      <span className="humidity-reading">
                        <Droplets size={22} />
                        {readings.indoor.humidity === null
                          ? "—"
                          : `${Math.round(readings.indoor.humidity)}%`}
                      </span>
                    </section>
                  );
                if (card.type === "calendar")
                  return (
                    <section className="photo-block calendar-block" aria-label={dateLabel} key={i}>
                      <span className="calendar-month">{calendar.month}</span>
                      <CalendarDays size={26} strokeWidth={1.25} />
                      <strong className="calendar-day">{calendar.day}</strong>
                      <span className="calendar-weekday">{calendar.weekday}</span>
                    </section>
                  );
                // Any Home Assistant entity: its state with its unit.
                const Icon = CARD_ICONS[card.icon ?? ""] ?? Gauge;
                const r = card.entity_id ? readings.cards?.[card.entity_id] : undefined;
                return (
                  <section className="photo-block" key={i}>
                    <h2>{localName(lang, card.label || card.entity_id || "")}</h2>
                    <Icon size={34} strokeWidth={1.5} />
                    <strong className="climate-reading">
                      <Ltr>{r?.value == null ? "—" : `${r.value}${r.unit ?? ""}`}</Ltr>
                    </strong>
                  </section>
                );
              })}
              <small className="photo-demo">
                {shot?.image && shot.credit
                  ? [t("photo.unsplash", { name: shot.credit }), t("photo.skipHint")].join(" · ")
                  : shot?.image
                    ? [
                        t("photo.immich"),
                        t("photo.markHint"),
                        t("photo.skipHint"),
                        shot.marked ? t("photo.marked", { n: String(shot.marked) }) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : !configured
                      ? t("photo.demo", { note: sampleNote })
                      : sampleNote}
              </small>
            </div>
          </div>
        </div>
      </LangContext.Provider>
    );

  return (
    <LangContext.Provider value={lang}>
      <div className="screen-stage">
        <div className="kindle-screen" ref={screen}>
          <nav
            className="device-tabs"
            aria-label={t("nav.label")}
            data-count={tabs.length}
            style={
              tabs.length === 4
                ? undefined
                : { gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }
            }
          >
            {tabs.map(({ name, icon: Icon, title }) => (
              <Button
                key={name}
                variant="eink"
                data-active={tab === name}
                aria-current={tab === name ? "page" : undefined}
                onClick={() => {
                  setTab(name);
                  setModal(null);
                  mediaClose();
                }}
              >
                <Icon />
                {title !== undefined
                  ? localName(lang, title)
                  : t(`tab.${name as "Lights" | "Vacuum" | "Power" | "Media"}`)}
              </Button>
            ))}
            {battery && !battery.charging && <BatteryBadge battery={battery} variant="tabs" />}
          </nav>
          <main className="content" key={tab}>
            {tab === "Lights" && (
              <>
                <div className="section-heading">
                  <div>
                    <h1>{t("lights.title")}</h1>
                    <p>
                      {t("lights.count", {
                        n: data.lights.filter((light) => light.on).length,
                        total: data.lights.length,
                      })}
                    </p>
                  </div>
                  <Button
                    variant="eink"
                    size="icon"
                    title={t("screensaver")}
                    aria-label={t("screensaver")}
                    onClick={() => setScreensaver(true)}
                  >
                    <Moon />
                  </Button>
                </div>
                <div className="light-card-grid">
                  {data.lights.map((light, index) => {
                    const meta = LIGHTS[index];
                    if (!meta) return null;
                    const Icon = LIGHT_ICONS[meta.icon] ?? Lightbulb;
                    const name = localName(lang, meta.name);
                    return (
                      <Button
                        variant="eink"
                        className="light-card"
                        key={meta.id}
                        data-on={light.on}
                        data-autofocus={index === 0 || undefined}
                        title={t("lights.open", { name })}
                        aria-label={`${name}, ${lightLine(light)}`}
                        onClick={() => openModal("light", index)}
                      >
                        <span className="light-card-heading">
                          <span className={`device-icon ${light.on ? "on" : ""}`}>
                            <Icon size={34} strokeWidth={1.6} />
                          </span>
                          <span className="device-info">
                            <strong>{name}</strong>
                            <span className="light-state">{lightLine(light)}</span>
                          </span>
                        </span>
                        <span className="light-card-foot">
                          <span className="light-room">{localName(lang, meta.room)}</span>
                          <span className={`shade-swatch shade-${light.shade.toLowerCase()}`} />
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </>
            )}
            {tab === "Vacuum" && (
              <>
                {(() => {
                  const picked = data.rooms.filter(Boolean).length;
                  const battery = data.vacuum.battery;
                  return (
                    <>
                      <div className="section-heading vacuum-heading">
                        <Bot size={64} strokeWidth={1.3} className="vacuum-bot" />
                        <div className="vacuum-heading-text">
                          <h1>{t("vacuum.title")}</h1>
                          <p>
                            {locating ? t("vacuum.locating") : vacuumLabel(data.vacuum.state, lang)}
                            {" · "}
                            {picked ? t("vacuum.rooms", { n: picked }) : t("vacuum.wholeHome")}
                          </p>
                        </div>
                        <span className="vacuum-battery" aria-label={t("vacuum.battery")}>
                          <Battery size={30} />
                          <Ltr>{battery === null ? "—" : `${battery}%`}</Ltr>
                        </span>
                      </div>
                      <div className="subheading">{t("vacuum.roomsLabel")}</div>
                      <div className="room-grid">
                        {ROOMS.map(({ name, id }, index) => {
                          const Icon = ROOM_ICONS[ROOMS[index]?.icon ?? "room"] ?? Home;
                          if (!Icon) return null;
                          return (
                            <Button
                              key={id}
                              variant="eink"
                              aria-pressed={data.rooms[index]}
                              onClick={() => act({ type: "room.toggle", entity: id })}
                            >
                              <Icon />
                              {localName(lang, name)}
                            </Button>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </>
            )}
            {tab === "Power" && (
              <>
                {(() => {
                  const wh = (value: number | null) =>
                    value === null ? "—" : `\u2066${Math.round(value)} Wh\u2069`;
                  const known = data.plugs.filter((plug) => plug.energyWh !== null);
                  const total = known.length
                    ? known.reduce((sum, plug) => sum + (plug.energyWh ?? 0), 0)
                    : null;
                  return (
                    <>
                      <div className="section-heading">
                        <div>
                          <h1>{t("power.title")}</h1>
                          <p>
                            {t("power.count", {
                              n: data.plugs.filter((plug) => plug.on).length,
                              total: data.plugs.length,
                            })}
                          </p>
                        </div>
                        <Plug size={25} />
                      </div>
                      <div className="power-readings">
                        {PLUGS.map((meta, index) => {
                          const plug = data.plugs[index];
                          if (!plug) return null;
                          const name = localName(lang, meta.name);
                          return (
                            <DeviceRow
                              key={meta.id}
                              icon={Plug}
                              name={name}
                              on={plug.on}
                              title={t("lights.open", { name })}
                              onClick={() => openModal("plug", index)}
                              state={t("power.today", {
                                state: plug.on ? t("state.on") : t("state.off"),
                                wh: wh(plug.energyWh),
                              })}
                              reading={
                                <Ltr>
                                  {fmt(plug.power)} <small>W</small>
                                </Ltr>
                              }
                            />
                          );
                        })}
                      </div>
                      <div className="power-total">
                        <h2>{t("power.total")}</h2>
                        <strong>
                          <Ltr>{total === null ? "—" : (total / 1000).toFixed(3)}</Ltr>{" "}
                          <small>{t("power.kwhToday")}</small>
                        </strong>
                      </div>
                    </>
                  );
                })()}
              </>
            )}
            {tab === "Media" && <MediaCards panel={media} />}
            {custom && (
              <>
                <div className="section-heading">
                  <div>
                    <h1>{localName(lang, custom.title)}</h1>
                    <p>
                      {t("custom.count", {
                        n: custom.toggles.filter((_, i) => customOn(i)).length,
                        total: custom.toggles.length,
                      })}
                    </p>
                  </div>
                  {(() => {
                    const Icon = TOGGLE_ICONS[custom.icon] ?? Star;
                    return <Icon size={25} />;
                  })()}
                </div>
                <div className="power-readings">
                  {custom.toggles.map((row, index) => {
                    const name = localName(lang, row.name);
                    const on = customOn(index);
                    return (
                      <DeviceRow
                        key={row.entity_id}
                        icon={TOGGLE_ICONS[row.icon] ?? Plug}
                        name={name}
                        on={on}
                        state={on ? t("state.on") : t("state.off")}
                        title={name}
                        onClick={() =>
                          act({ type: "custom.toggle", tab: customId, entity: row.entity_id })
                        }
                      />
                    );
                  })}
                </div>
              </>
            )}
          </main>
          <div className="demo-status" role="status">
            {status}
          </div>
          <DeviceActions actions={actions} />
          {modal && modal.kind === "plug" && modalPlug && (
            <PlugModal
              name={localName(lang, PLUGS[modal.index]?.name ?? "")}
              plug={modalPlug}
              actions={modalActions}
              status={status}
            />
          )}
          {modal && modalLight && modalMeta && modal.kind === "light" && (
            <LightModal
              name={localName(lang, modalMeta.name)}
              room={localName(lang, modalMeta.room)}
              light={modalLight}
              actions={modalActions}
              status={status}
            />
          )}
          {media.screen && <MediaModal panel={media} status={mediaStatus} />}
          {modal && modalLight && modalMeta && modal.kind !== "light" && modal.kind !== "plug" && (
            <PickerModal
              kind={modal.kind}
              lightName={localName(lang, modalMeta.name)}
              cursor={cursor}
              onPick={(next) => pick(modal.kind as "shade" | "color", modal.index, next)}
              actions={modalActions}
              status={status}
            />
          )}
        </div>
      </div>
    </LangContext.Provider>
  );
}
