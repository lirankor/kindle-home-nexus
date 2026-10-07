import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeviceActions, pressSoftKey, type DeviceAction } from "@/components/device-actions";
import { SpotLightIcon, StripLightIcon } from "@/components/light-icons";
import screensaverPhoto from "@/assets/screensaver-preview.jpg";
import {
  COLORS,
  LIGHTS,
  MEDIA,
  PLUGS,
  ROOMS,
  SHADES,
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

const tabs = [
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
const fmt = (value: number | null, digits = 1) => (value === null ? "—" : value.toFixed(digits));
const SAMPLE_REFRESH_MS = 10 * 60 * 1000;

function HomeControl() {
  const [tab, setTab] = useState("Lights");
  const [scene, setScene] = useState("");
  const [locating, setLocating] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const [lightMenu, setLightMenu] = useState<{ index: number; mode: "shade" | "color" } | null>(
    null,
  );
  const [dateLabel, setDateLabel] = useState("Tuesday, 6 October");
  const [calendar, setCalendar] = useState({
    weekday: "Tuesday",
    day: "6",
    month: "October",
    year: "2026",
  });
  const screen = useRef<HTMLDivElement>(null);
  const focusTabAfterChange = useRef(false);
  const latest = useRef<{ actions: DeviceAction[] }>({ actions: [] });
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
  const configured = result.configured;
  const lastGood = useRef<Snapshot | null>(null);
  if (result.snapshot) lastGood.current = result.snapshot;
  const [demo, setDemo] = useState(demoSnapshot);
  const [optimistic, setOptimistic] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const inFlight = useRef(0);
  const locateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const data: Snapshot = !configured ? demo : (optimistic ?? lastGood.current ?? emptySnapshot());
  const pollError = query.isError ? "Server unreachable" : result.error;
  const status = !configured
    ? `Demo · ${notice?.text ?? "HA not configured"}`
    : (pollError ??
      (notice
        ? notice.error
          ? notice.text
          : `Done · ${notice.text}`
        : "Home Assistant · connected"));
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
        setNotice({ text: actionLabel(action) });
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
          setNotice({ text: actionLabel(action) });
          if (res.snapshot)
            queryClient.setQueryData<SnapshotResult>(["snapshot"], {
              configured: true,
              snapshot: res.snapshot,
            });
        } else setNotice({ text: res.error ?? "Action failed", error: true });
      } catch {
        setNotice({ text: "Server unreachable", error: true });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setOptimistic(null);
        void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
      }
    },
    [configured, queryClient],
  );

  useEffect(() => {
    if (!focusTabAfterChange.current) return;
    screen.current?.querySelector<HTMLButtonElement>('.device-tabs [data-active="true"]')?.focus();
    focusTabAfterChange.current = false;
  }, [tab]);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setDateLabel(
        now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
      );
      setCalendar({
        weekday: now.toLocaleDateString("en-GB", { weekday: "long" }),
        day: String(now.getDate()),
        month: now.toLocaleDateString("en-GB", { month: "long" }),
        year: String(now.getFullYear()),
      });
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, []);

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
    const handleKey = (event: KeyboardEvent) => {
      if (pressSoftKey(latest.current.actions, event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        setLightMenu(null);
        return;
      }
      if (
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      if (event.key === "PageUp" || event.key === "PageDown") {
        setLightMenu(null);
        const index = tabs.findIndex((item) => item.name === tab);
        focusTabAfterChange.current = true;
        setTab(tabs[(index + (event.key === "PageDown" ? 1 : 3)) % 4]?.name ?? "Lights");
        return;
      }
      const container = screen.current?.querySelector('[role="dialog"]') ?? screen.current;
      const controls = Array.from(
        container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
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
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [tab]);

  useEffect(() => {
    if (lightMenu)
      screen.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus();
    else screen.current?.querySelector<HTMLButtonElement>('[data-menu-open="true"]')?.focus();
  }, [lightMenu]);

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
  const WeatherIcon = weatherIcon(data.weather.condition);
  const outdoor = data.weather.temp === null ? "—" : `${fmt(data.weather.temp)}°`;
  const indoor = data.indoor.temp === null ? "—" : `${fmt(data.indoor.temp)} °C`;
  const humidity = data.indoor.humidity === null ? "—" : `${Math.round(data.indoor.humidity)}%`;
  const shot = photo.data;
  const sampleNote = shot?.note ?? "Sample photo";
  const readings = shot?.result.snapshot && configured ? shot.result.snapshot : data;
  const SIcon = weatherIcon(readings.weather.condition);

  const plugOn = (index: number) => data.plugs[index]?.on ?? false;
  const mediaOff = (index: number) => {
    const state = data.media[index]?.state;
    return state === "unavailable" || state === "unknown";
  };
  const mediaPower = (index: number) =>
    media(index, data.media[index]?.state === "off" ? "turn_on" : "turn_off");
  const cleaning = data.vacuum.state === "cleaning";
  const actions: DeviceAction[] =
    tab === "Lights"
      ? [
          ...(
            [
              { name: "Bright", icon: Sun },
              { name: "Evening", icon: Moon },
              { name: "Movie", icon: Film },
            ] as const
          ).map(({ name, icon }) => ({
            label: name,
            icon,
            pressed: scene === name || (name === "Movie" && data.movieActive),
            onClick: () => applyScene(name),
          })),
          {
            label: "All off",
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
              label: cleaning ? "Pause cleaning" : "Start cleaning",
              icon: cleaning ? Pause : Play,
              pressed: cleaning,
              onClick: () => act({ type: "vacuum", op: cleaning ? "pause" : "start" }),
            },
            { label: "Dock", icon: Home, onClick: () => act({ type: "vacuum", op: "dock" }) },
            { label: "Locate", icon: MapPin, pressed: locating, onClick: locate },
            {
              label: "Clean all",
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
                label: meta.name,
                icon: Plug,
                pressed: plugOn(index),
                onClick: () => act({ type: "switch.toggle", entity: meta.id }),
              })),
              {
                label: "All off",
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
                label: "Movie mode",
                icon: Film,
                pressed: data.movieActive,
                onClick: () => applyScene("Movie"),
              },
              {
                label: "End movie",
                icon: ArrowLeft,
                onClick: () => {
                  setScene("");
                  act({ type: "movie.end" });
                },
              },
              { label: "TV power", icon: Tv, disabled: mediaOff(1), onClick: () => mediaPower(1) },
              {
                label: "Yamaha power",
                icon: Music2,
                disabled: mediaOff(0),
                onClick: () => mediaPower(0),
              },
            ];

  latest.current = { actions };

  if (screensaver)
    return (
      <div className="screen-stage">
        <div
          className="kindle-screen photo-screen"
          aria-label="Immich favorites screensaver preview"
        >
          <img
            src={shot?.image ?? screensaverPhoto}
            width={600}
            height={800}
            alt={
              shot?.image
                ? "Favorite photo from Immich"
                : "Grayscale alpine lake and mountains — sample screensaver photo"
            }
          />
          <div className="photo-caption">
            <section className="photo-block">
              <h2>Outdoor</h2>
              <SIcon size={40} strokeWidth={1.5} />
              <strong className="climate-reading">
                {readings.weather.temp === null ? "—" : `${fmt(readings.weather.temp)}°`}
              </strong>
              <span>{conditionLabel(readings.weather.condition)}</span>
            </section>
            <section className="photo-block">
              <h2>Indoor</h2>
              <Thermometer size={40} strokeWidth={1.5} />
              <strong className="climate-reading">
                {readings.indoor.temp === null ? "—" : `${fmt(readings.indoor.temp)}°`}
              </strong>
              <span className="humidity-reading">
                <Droplets size={22} />
                {readings.indoor.humidity === null
                  ? "—"
                  : `${Math.round(readings.indoor.humidity)}%`}
              </span>
            </section>
            <section className="photo-block calendar-block" aria-label={dateLabel}>
              <span className="calendar-month">{calendar.month.slice(0, 3).toUpperCase()}</span>
              <CalendarDays size={40} strokeWidth={1.5} />
              <strong className="calendar-day">{calendar.day}</strong>
              <span className="calendar-weekday">{calendar.weekday.slice(0, 3).toUpperCase()}</span>
            </section>
            <small className="photo-demo">
              {shot?.image
                ? "Immich favorite"
                : !configured
                  ? "Demo readings · " + sampleNote
                  : sampleNote}
            </small>
          </div>
        </div>
      </div>
    );

  return (
    <div className="screen-stage">
      <div className="kindle-screen" ref={screen}>
        <nav className="device-tabs" aria-label="Device categories">
          {tabs.map(({ name, icon: Icon }) => (
            <Button
              key={name}
              variant="eink"
              data-active={tab === name}
              aria-current={tab === name ? "page" : undefined}
              onClick={() => {
                setTab(name);
                setLightMenu(null);
              }}
            >
              <Icon />
              {name}
            </Button>
          ))}
        </nav>
        <main className="content" key={tab}>
          {tab === "Lights" && (
            <>
              <div className="section-heading">
                <div>
                  <h1>Lights</h1>
                  <p>{data.lights.filter((light) => light.on).length} of 4 lights on</p>
                </div>
                <Button
                  variant="eink"
                  size="icon"
                  title="Screensaver"
                  aria-label="Screensaver"
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
                  return (
                    <section className="light-card" key={meta.id}>
                      <div className="light-card-heading">
                        <Button
                          variant="eink"
                          className="device-icon"
                          title={`${meta.name} ${light.on ? "on" : "off"}`}
                          aria-label={`Toggle ${meta.name}`}
                          aria-pressed={light.on}
                          onClick={() => {
                            setScene("");
                            act({ type: "light.toggle", entity: meta.id });
                          }}
                        >
                          <Icon size={32} strokeWidth={1.6} />
                        </Button>
                        <div className="device-info">
                          <strong>{meta.name}</strong>
                          <p>
                            {light.on ? `${light.level}%` : "Off"} ·{" "}
                            {light.color === "White"
                              ? light.shade.toLowerCase()
                              : light.color.toLowerCase()}
                          </p>
                        </div>
                      </div>
                      <p className="light-room">{meta.room}</p>
                      <div className="light-card-controls">
                        <div className="light-adjustments">
                          <Button
                            variant="eink"
                            title={`${light.shade} white · ${meta.name}`}
                            aria-label={`White shade for ${meta.name}`}
                            data-menu-open={
                              lightMenu?.index === index && lightMenu.mode === "shade"
                            }
                            onClick={() => setLightMenu({ index, mode: "shade" })}
                          >
                            <span className={`shade-swatch shade-${light.shade.toLowerCase()}`} />
                          </Button>
                          <Button
                            variant="eink"
                            title={`Color · ${meta.name}`}
                            aria-label={`Color for ${meta.name}`}
                            data-menu-open={
                              lightMenu?.index === index && lightMenu.mode === "color"
                            }
                            onClick={() => setLightMenu({ index, mode: "color" })}
                          >
                            <Palette />
                          </Button>
                        </div>
                        <div className="level-control">
                          <Button
                            variant="eink"
                            title={`Dim ${meta.name}`}
                            aria-label={`Dim ${meta.name}`}
                            onClick={() => changeLight(index, -10)}
                          >
                            <Minus />
                          </Button>
                          <Button
                            variant="eink"
                            title={`Brighten ${meta.name}`}
                            aria-label={`Brighten ${meta.name}`}
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
                        <h1>Vacuum</h1>
                        <p>{picked ? `${picked} rooms selected` : "Whole home"}</p>
                      </div>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                        <Battery size={24} />
                        {battery === null ? "—" : `${battery}%`}
                      </span>
                    </div>
                    <div className="vacuum-summary">
                      <Bot strokeWidth={1.3} />
                      <div>
                        <strong>Roborock Qrevo Edge</strong>
                        <p>
                          {locating ? "Locating · sound requested" : vacuumLabel(data.vacuum.state)}
                        </p>
                      </div>
                    </div>
                    <div className="subheading">Rooms</div>
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
                            {name}
                          </Button>
                        );
                      })}
                    </div>
                    <div className="progress-line">
                      <span>Battery</span>
                      <strong>{battery === null ? "—" : `${battery}%`}</strong>
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
                  value === null ? "—" : `${Math.round(value)} Wh`;
                const known = data.plugs.filter((plug) => plug.energyWh !== null);
                const total = known.length
                  ? known.reduce((sum, plug) => sum + (plug.energyWh ?? 0), 0)
                  : null;
                return (
                  <>
                    <div className="section-heading">
                      <div>
                        <h1>Power</h1>
                        <p>{data.plugs.filter((plug) => plug.on).length} of 3 plugs on</p>
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
                              <strong>{meta.name}</strong>
                              <p>
                                {plug.on ? "On" : "Off"} · {wh(plug.energyWh)} today
                              </p>
                            </div>
                            <strong className="watt-reading">
                              {fmt(plug.power)} <small>W</small>
                            </strong>
                          </div>
                        );
                      })}
                    </div>
                    <section className="usage-chart" aria-label="Total power usage">
                      <div className="chart-heading">
                        <h2>Total usage</h2>
                        <strong>
                          {total === null ? "—" : (total / 1000).toFixed(3)}{" "}
                          <small>kWh today</small>
                        </strong>
                      </div>
                      {!configured && (
                        <>
                          <div className="chart-axis-label">W · demo history</div>
                          <svg
                            viewBox="0 0 540 155"
                            preserveAspectRatio="none"
                            role="img"
                            aria-label="Sample total power usage over 24 hours, from 0 to 120 watts"
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
                        </>
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
                  <h1>Media</h1>
                  <p>Living room</p>
                </div>
                <Music2 size={25} />
              </div>
              {MEDIA.map((meta, index) => {
                const m = data.media[index];
                if (!m) return null;
                const off = m.state === "unavailable" || m.state === "unknown";
                const idle = off || m.state === "off";
                const name = meta.name;
                return (
                  <section className="media-device" key={meta.id}>
                    <div className="media-title">
                      {index === 0 ? <Music2 size={27} /> : <Tv size={27} />}
                      <div>
                        <strong>{name}</strong>
                        <p>{vacuumLabel(m.state)}</p>
                      </div>
                    </div>
                    <div className="transport">
                      {(
                        [
                          { icon: SkipBack, label: "Previous", op: "media_previous_track" },
                          { icon: Play, label: "Play", op: "media_play" },
                          { icon: Pause, label: "Pause", op: "media_pause" },
                          { icon: SkipForward, label: "Next", op: "media_next_track" },
                        ] as const
                      ).map(({ icon: Icon, label, op }) => (
                        <Button
                          variant="eink"
                          disabled={idle}
                          key={label}
                          title={label}
                          aria-label={`${label} on ${name}`}
                          onClick={() => media(index, op)}
                        >
                          <Icon />
                        </Button>
                      ))}
                    </div>
                    <div className="source-control">
                      <span>Source</span>
                      <span>{m.source ?? "—"}</span>
                    </div>
                    <div className="source-control">
                      <span>
                        <Volume2 size={16} /> Volume
                      </span>
                      <div className="level-control">
                        <Button
                          variant="eink"
                          disabled={idle}
                          aria-label={`Lower volume on ${name}`}
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
                          aria-label={`Raise volume on ${name}`}
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
        {lightMenu && (
          <div className="light-menu-backdrop">
            <section
              role="dialog"
              aria-modal="true"
              aria-label={`${lightMenu.mode === "shade" ? "White shade" : "Color"} for ${LIGHTS[lightMenu.index]?.name}`}
              className="light-menu"
            >
              <div className="menu-heading">
                <div>
                  <h2>{lightMenu.mode === "shade" ? "White shade" : "Color"}</h2>
                  <p>{LIGHTS[lightMenu.index]?.name}</p>
                </div>
                <Button
                  variant="eink"
                  size="icon"
                  aria-label="Close light menu"
                  onClick={() => setLightMenu(null)}
                >
                  <X />
                </Button>
              </div>
              <div className="color-options">
                {(lightMenu.mode === "shade" ? (["Warm", "Neutral", "Cool"] as const) : COLORS).map(
                  (value) => (
                    <Button
                      key={value}
                      variant="eink"
                      aria-pressed={
                        lightMenu.mode === "shade"
                          ? data.lights[lightMenu.index]?.shade === value &&
                            data.lights[lightMenu.index]?.color === "White"
                          : data.lights[lightMenu.index]?.color === value
                      }
                      onClick={() => {
                        const entity = LIGHTS[lightMenu.index]?.id ?? "";
                        act(
                          lightMenu.mode === "shade"
                            ? {
                                type: "light.kelvin",
                                entity,
                                kelvin: SHADES[value as keyof typeof SHADES],
                              }
                            : {
                                type: "light.color",
                                entity,
                                color: value as (typeof COLORS)[number],
                              },
                        );
                        setScene("");
                        setLightMenu(null);
                      }}
                    >
                      {lightMenu.mode === "shade" ? (
                        <span className={`shade-swatch shade-${value.toLowerCase()}`} />
                      ) : (
                        <Palette />
                      )}
                      <span>{value}</span>
                    </Button>
                  ),
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
