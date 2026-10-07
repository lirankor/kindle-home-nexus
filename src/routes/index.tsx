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
  Tv,
  Music2,
  Bot,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Minus,
  Plus,
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
  Volume2,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeviceActions, pressSoftKey, type DeviceAction } from "@/components/device-actions";
import { LightModal, PickerModal, pickerValues } from "@/components/light-modals";
import { SpotLightIcon, StripLightIcon } from "@/components/light-icons";
import { useFullRefresh } from "@/lib/eink";
import { dateLocale, isRtl, makeT } from "@/lib/i18n";
import { LangContext } from "@/lib/lang-context";
import type { Key } from "@/lib/i18n";
import screensaverPhoto from "@/assets/screensaver-preview.jpg";
import {
  COLORS,
  LIGHTS,
  localName,
  MEDIA,
  PLUGS,
  ROOMS,
  SHADES,
  SHADE_NAMES,
  actionLabel,
  applyOptimistic,
  conditionLabel,
  demoSnapshot,
  emptySnapshot,
  vacuumLabel,
} from "@/lib/home";
import type { Action, MediaOp, Snapshot, SnapshotResult } from "@/lib/home";
import { getScreensaver, getSnapshot, runAction } from "@/lib/home.functions";

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

const tabs: { name: "Lights" | "Vacuum" | "Power" | "Media"; icon: typeof Lightbulb }[] = [
  { name: "Lights", icon: Lightbulb },
  { name: "Vacuum", icon: Bot },
  { name: "Power", icon: Plug },
  { name: "Media", icon: Music2 },
];
const lightIcons = [LampCeiling, SpotLightIcon, LampCeiling, StripLightIcon];
const roomIcons = [ShowerHead, Baby, DoorOpen, Utensils, Home, Bath, Bed, Sofa];
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
/** Keeps numbers and units in reading order inside right-to-left text. */
const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr">{children}</bdi>;
const fmt = (value: number | null, digits = 1) => (value === null ? "—" : value.toFixed(digits));
const SAMPLE_REFRESH_MS = 10 * 60 * 1000;
const MODAL_IDLE_MS = 30 * 1000;

function HomeControl() {
  const [tab, setTab] = useState("Lights");
  const [scene, setScene] = useState("");
  const [locating, setLocating] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const [modal, setModal] = useState<{ kind: "light" | "shade" | "color"; index: number } | null>(
    null,
  );
  const [cursor, setCursor] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const [now, setNow] = useState(() => new Date(2026, 9, 6));
  const screen = useRef<HTMLDivElement>(null);
  const focusTabAfterChange = useRef(false);
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
    month: now.toLocaleDateString(locale, { month: "short" }),
    weekday: now.toLocaleDateString(locale, { weekday: "short" }),
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
    queryFn: () => getScreensaver(),
    enabled: screensaver,
    refetchInterval: SAMPLE_REFRESH_MS,
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

  useEffect(() => {
    if (!focusTabAfterChange.current) return;
    screen.current?.querySelector<HTMLButtonElement>('.device-tabs [data-active="true"]')?.focus();
    focusTabAfterChange.current = false;
  }, [tab]);

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

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setScreensaver(true), 5 * 60 * 1000);
    };
    const wake = (event: Event) => {
      if (screensaver) {
        event.preventDefault();
        event.stopImmediatePropagation();
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
  }, [screensaver]);

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
  useFullRefresh(photo.dataUpdatedAt);
  useEffect(() => {
    if (modalOpen) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [modalOpen]);

  // Modals close after 30 s without a key press and as soon as the screensaver starts.
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
  const applyScene = (name: "Bright" | "Evening" | "Movie") => {
    setScene(name === "Movie" ? "" : name);
    act({ type: "scene", name });
  };
  const media = (index: number, op: MediaOp) => {
    const meta = MEDIA[index];
    if (meta) act({ type: "media", entity: meta.id, op });
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

  const modalLight = modal ? data.lights[modal.index] : undefined;
  const modalMeta = modal ? LIGHTS[modal.index] : undefined;
  const openModal = (kind: "light" | "shade" | "color", index: number) => {
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
  const modalActions: DeviceAction[] = !modal
    ? []
    : modal.kind === "light"
      ? [
          { label: t("modal.close"), icon: X, onClick: () => setModal(null) },
          {
            label: t("modal.colorWhite"),
            icon: Palette,
            onClick: () => openModal("color", modal.index),
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
  const mediaOff = (index: number) => {
    const state = data.media[index]?.state;
    return state === "unavailable" || state === "unknown";
  };
  const mediaPower = (index: number) =>
    media(index, data.media[index]?.state === "off" ? "turn_on" : "turn_off");
  const cleaning = data.vacuum.state === "cleaning";
  const actions: (DeviceAction | null)[] =
    tab === "Lights"
      ? [
          ...(
            [
              { name: "Bright", icon: Sun },
              { name: "Evening", icon: Moon },
              { name: "Movie", icon: Film },
            ] as const
          ).map(({ name, icon }) => ({
            label: t(`scene.${name}`),
            icon,
            pressed: scene === name || (name === "Movie" && data.movieActive),
            onClick: () => applyScene(name),
          })),
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
              ...PLUGS.map((meta, index) => ({
                label: localName(lang, meta.name),
                icon: Plug,
                pressed: plugOn(index),
                onClick: () => act({ type: "switch.toggle", entity: meta.id }),
              })),
              {
                label: t("power.allOff"),
                icon: Power,
                onClick: () => {
                  PLUGS.forEach((meta, index) => {
                    if (plugOn(index)) act({ type: "switch.toggle", entity: meta.id });
                  });
                },
              },
            ]
          : [
              {
                label: t("media.movie"),
                icon: Film,
                pressed: data.movieActive,
                onClick: () => applyScene("Movie"),
              },
              {
                label: t("media.tv"),
                icon: Tv,
                disabled: mediaOff(1),
                onClick: () => mediaPower(1),
              },
              {
                label: t("media.yamaha"),
                icon: Music2,
                disabled: mediaOff(0),
                onClick: () => mediaPower(0),
              },
              null,
            ];

  keyHandler.current = (event) => {
    if (pressSoftKey(modal ? modalActions : actions, event.key)) {
      event.preventDefault();
      return;
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
      focusTabAfterChange.current = true;
      setTab(tabs[(index + (event.key === "PageDown" ? 1 : 3)) % 4]?.name ?? "Lights");
      return;
    }
    const controls = Array.from(
      screen.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !controls.includes(active as HTMLButtonElement)) {
      controls[0]?.focus();
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
              src={shot?.image ?? screensaverPhoto}
              width={600}
              height={800}
              alt={shot?.image ? t("photo.altImmich") : t("photo.altSample")}
            />
            <div className="photo-caption">
              <section className="photo-block">
                <h2>{t("photo.outdoor")}</h2>
                <SIcon size={40} strokeWidth={1.5} />
                <strong className="climate-reading">
                  <Ltr>
                    {readings.weather.temp === null ? "—" : `${fmt(readings.weather.temp)}°`}
                  </Ltr>
                </strong>
                <span>{conditionLabel(readings.weather.condition, lang)}</span>
              </section>
              <section className="photo-block">
                <h2>{t("photo.indoor")}</h2>
                <Thermometer size={40} strokeWidth={1.5} />
                <strong className="climate-reading">
                  <Ltr>{readings.indoor.temp === null ? "—" : `${fmt(readings.indoor.temp)}°`}</Ltr>
                </strong>
                <span className="humidity-reading">
                  <Droplets size={22} />
                  {readings.indoor.humidity === null
                    ? "—"
                    : `${Math.round(readings.indoor.humidity)}%`}
                </span>
              </section>
              <section className="photo-block calendar-block" aria-label={dateLabel}>
                <span className="calendar-month">{calendar.month.toUpperCase()}</span>
                <CalendarDays size={40} strokeWidth={1.5} />
                <strong className="calendar-day">{calendar.day}</strong>
                <span className="calendar-weekday">{calendar.weekday.toUpperCase()}</span>
              </section>
              <small className="photo-demo">
                {shot?.image
                  ? t("photo.immich")
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
          <nav className="device-tabs" aria-label={t("nav.label")}>
            {tabs.map(({ name, icon: Icon }) => (
              <Button
                key={name}
                variant="eink"
                data-active={tab === name}
                aria-current={tab === name ? "page" : undefined}
                onClick={() => {
                  setTab(name);
                  setModal(null);
                }}
              >
                <Icon />
                {t(`tab.${name}`)}
              </Button>
            ))}
          </nav>
          <main className="content" key={tab}>
            {tab === "Lights" && (
              <>
                <div className="section-heading">
                  <div>
                    <h1>{t("lights.title")}</h1>
                    <p>
                      {t("lights.count", { n: data.lights.filter((light) => light.on).length })}
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
                    const Icon = lightIcons[index];
                    if (!meta || !Icon) return null;
                    const name = localName(lang, meta.name);
                    return (
                      <section className="light-card" key={meta.id}>
                        <div className="light-card-heading">
                          <Button
                            variant="eink"
                            className="device-icon"
                            title={name}
                            aria-label={t("lights.toggle", { name })}
                            aria-pressed={light.on}
                            onClick={() => {
                              setScene("");
                              act({ type: "light.toggle", entity: meta.id });
                            }}
                          >
                            <Icon size={32} strokeWidth={1.6} />
                          </Button>
                          <Button
                            variant="eink"
                            className="light-open device-info"
                            title={t("lights.open", { name })}
                            aria-label={t("lights.open", { name })}
                            onClick={() => openModal("light", index)}
                          >
                            <strong>{name}</strong>
                            <p>
                              {light.on ? <Ltr>{light.level}%</Ltr> : t("lights.off")} ·{" "}
                              {light.color === "White"
                                ? t(`shade.${light.shade}`)
                                : t(`color.${light.color as (typeof COLORS)[number]}`)}
                            </p>
                          </Button>
                        </div>
                        <p className="light-room">{localName(lang, meta.room)}</p>
                        <div className="light-card-controls">
                          <div className="light-adjustments">
                            <Button
                              variant="eink"
                              title={t("lights.shade", { name })}
                              aria-label={t("lights.shade", { name })}
                              onClick={() => openModal("shade", index)}
                            >
                              <span className={`shade-swatch shade-${light.shade.toLowerCase()}`} />
                            </Button>
                            <Button
                              variant="eink"
                              title={t("lights.color", { name })}
                              aria-label={t("lights.color", { name })}
                              onClick={() => openModal("color", index)}
                            >
                              <Palette />
                            </Button>
                          </div>
                          <div className="level-control">
                            <Button
                              variant="eink"
                              title={t("lights.dim", { name })}
                              aria-label={t("lights.dim", { name })}
                              onClick={() => changeLight(index, -10)}
                            >
                              <Minus />
                            </Button>
                            <Button
                              variant="eink"
                              title={t("lights.brighten", { name })}
                              aria-label={t("lights.brighten", { name })}
                              onClick={() => changeLight(index, 10)}
                            >
                              <Plus />
                            </Button>
                          </div>
                        </div>
                      </section>
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
                      <div className="section-heading">
                        <div>
                          <h1>{t("vacuum.title")}</h1>
                          <p>{picked ? t("vacuum.rooms", { n: picked }) : t("vacuum.wholeHome")}</p>
                        </div>
                        <span
                          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}
                        >
                          <Battery size={24} />
                          <Ltr>{battery === null ? "—" : `${battery}%`}</Ltr>
                        </span>
                      </div>
                      <div className="vacuum-summary">
                        <Bot strokeWidth={1.3} />
                        <div>
                          <strong dir="ltr">Roborock Qrevo Edge</strong>
                          <p>
                            {locating ? t("vacuum.locating") : vacuumLabel(data.vacuum.state, lang)}
                          </p>
                        </div>
                      </div>
                      <div className="subheading">{t("vacuum.roomsLabel")}</div>
                      <div className="room-grid">
                        {ROOMS.map(({ name, id }, index) => {
                          const Icon = roomIcons[index];
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
                      <div className="progress-line">
                        <span>{t("vacuum.battery")}</span>
                        <strong dir="ltr">{battery === null ? "—" : `${battery}%`}</strong>
                      </div>
                      <div className="progress-track">
                        <span style={{ width: `${battery ?? 0}%` }} />
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
                            {t("power.count", { n: data.plugs.filter((plug) => plug.on).length })}
                          </p>
                        </div>
                        <Plug size={25} />
                      </div>
                      <div className="power-readings">
                        {PLUGS.map((meta, index) => {
                          const plug = data.plugs[index];
                          if (!plug) return null;
                          return (
                            <div className="power-row" key={meta.id}>
                              <div className={`device-icon ${plug.on ? "on" : ""}`}>
                                <Plug size={28} />
                              </div>
                              <div className="device-info">
                                <strong>{localName(lang, meta.name)}</strong>
                                <p>
                                  {t("power.today", {
                                    state: plug.on ? t("state.on") : t("state.off"),
                                    wh: wh(plug.energyWh),
                                  })}
                                </p>
                              </div>
                              <strong className="watt-reading">
                                <Ltr>
                                  {fmt(plug.power)} <small>W</small>
                                </Ltr>
                              </strong>
                            </div>
                          );
                        })}
                      </div>
                      <section className="usage-chart" aria-label={t("power.total")}>
                        <div className="chart-heading">
                          <h2>{t("power.total")}</h2>
                          <strong>
                            <Ltr>{total === null ? "—" : (total / 1000).toFixed(3)}</Ltr>{" "}
                            <small>{t("power.kwhToday")}</small>
                          </strong>
                        </div>
                        {!configured && (
                          <div dir="ltr">
                            <div className="chart-axis-label">{t("power.demoHistory")}</div>
                            <svg
                              viewBox="0 0 540 155"
                              preserveAspectRatio="none"
                              role="img"
                              aria-label={t("power.chartLabel")}
                            >
                              <g className="chart-grid">
                                <path d="M35 10H530M35 70H530M35 130H530" />
                              </g>
                              <g className="chart-labels">
                                <text x="0" y="15">
                                  120
                                </text>
                                <text x="8" y="75">
                                  60
                                </text>
                                <text x="15" y="135">
                                  0
                                </text>
                              </g>
                              <path
                                className="chart-line"
                                d="M35 128L55 128L76 124L97 127L117 128L138 125L159 98L179 32L200 46L221 86L241 108L262 105L283 110L303 88L324 75L345 92L365 50L386 20L407 62L427 68L448 67L469 68L489 68L510 68L530 68"
                              />
                            </svg>
                            <div className="chart-times">
                              <span>00:00</span>
                              <span>06:00</span>
                              <span>12:00</span>
                              <span>18:00</span>
                              <span>24:00</span>
                            </div>
                          </div>
                        )}
                      </section>
                    </>
                  );
                })()}
              </>
            )}
            {tab === "Media" && (
              <>
                <div className="section-heading">
                  <div>
                    <h1>{t("media.title")}</h1>
                    <p>{t("media.room")}</p>
                  </div>
                  <Music2 size={25} />
                </div>
                {MEDIA.map((meta, index) => {
                  const m = data.media[index];
                  if (!m) return null;
                  const off = m.state === "unavailable" || m.state === "unknown";
                  const idle = off || m.state === "off";
                  const name = localName(lang, meta.name);
                  return (
                    <section className="media-device" key={meta.id}>
                      <div className="media-title">
                        {index === 0 ? <Music2 size={27} /> : <Tv size={27} />}
                        <div>
                          <strong>{name}</strong>
                          <p>{vacuumLabel(m.state, lang)}</p>
                        </div>
                      </div>
                      <div className="transport">
                        {(
                          [
                            {
                              icon: SkipBack,
                              label: t("media.previous"),
                              op: "media_previous_track",
                            },
                            { icon: Play, label: t("media.play"), op: "media_play" },
                            { icon: Pause, label: t("media.pause"), op: "media_pause" },
                            { icon: SkipForward, label: t("media.next"), op: "media_next_track" },
                          ] as const
                        ).map(({ icon: Icon, label, op }) => (
                          <Button
                            variant="eink"
                            disabled={idle}
                            key={label}
                            title={label}
                            aria-label={t("media.op", { label, name })}
                            onClick={() => media(index, op)}
                          >
                            <Icon />
                          </Button>
                        ))}
                      </div>
                      <div className="source-control">
                        <span>{t("media.source")}</span>
                        <span>{m.source ?? "—"}</span>
                      </div>
                      <div className="source-control">
                        <span>
                          <Volume2 size={16} /> {t("media.volume")}
                        </span>
                        <div className="level-control">
                          <Button
                            variant="eink"
                            disabled={idle}
                            aria-label={t("media.volDown", { name })}
                            onClick={() => media(index, "volume_down")}
                          >
                            <Minus />
                          </Button>
                          <span className="level-value">
                            {m.volume === null ? "—" : Math.round(m.volume * 100)}
                          </span>
                          <Button
                            variant="eink"
                            disabled={idle}
                            aria-label={t("media.volUp", { name })}
                            onClick={() => media(index, "volume_up")}
                          >
                            <Plus />
                          </Button>
                        </div>
                      </div>
                    </section>
                  );
                })}
              </>
            )}
          </main>
          <div className="demo-status" role="status">
            {status}
          </div>
          <DeviceActions actions={actions} />
          {modal && modalLight && modalMeta && modal.kind === "light" && (
            <LightModal
              name={localName(lang, modalMeta.name)}
              room={localName(lang, modalMeta.room)}
              light={modalLight}
              actions={modalActions}
              status={status}
            />
          )}
          {modal && modalLight && modalMeta && modal.kind !== "light" && (
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
