import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Home,
  Sun,
  Lightbulb,
  LampCeiling,
  LampDesk,
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
  Check,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
const lightIcons = [LampCeiling, LampDesk, LampCeiling, Lightbulb];
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
            <div className="photo-date" aria-label={dateLabel}>
              <strong className="photo-date-day">{calendar.day}</strong>
              <div>
                <span className="photo-date-weekday">{calendar.weekday}</span>
                <span className="photo-date-month">
                  {calendar.month} {calendar.year}
                </span>
              </div>
            </div>
            <div className="photo-weather">
              <SIcon size={34} strokeWidth={1.5} />
              <div>
                <strong>
                  {readings.weather.temp === null ? "—" : `${fmt(readings.weather.temp)}°`}
                </strong>
                <small>{conditionLabel(readings.weather.condition)} outside</small>
              </div>
            </div>
            <div className="photo-home">
              <span>
                <Thermometer size={18} />
                Home{" "}
                <strong>
                  {readings.indoor.temp === null ? "—" : `${fmt(readings.indoor.temp)} °C`}
                </strong>
              </span>
              <span>
                <Droplets size={18} />
                Humidity{" "}
                <strong>
                  {readings.indoor.humidity === null
                    ? "—"
                    : `${Math.round(readings.indoor.humidity)}%`}
                </strong>
              </span>
              <small>
                {shot?.image
                  ? "Immich favorite"
                  : !configured
                    ? "Demo readings · " + sampleNote
                    : sampleNote}
              </small>
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="screen-stage">
      <div className="kindle-screen" ref={screen}>
        <header className="weather-header" aria-label="Weather and home conditions">
          <div className="weather-date">
            <span>{dateLabel}</span>
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
          <div className="weather-overview">
            <WeatherIcon size={64} strokeWidth={1.2} />
            <strong>
              {outdoor === "—" ? (
                "—"
              ) : (
                <>
                  {fmt(data.weather.temp)}
                  <span>°</span>
                </>
              )}
            </strong>
            <div>
              <h2>{conditionLabel(data.weather.condition)}</h2>
              <p>Outside{configured ? "" : " · demo weather"}</p>
            </div>
          </div>
          <div className="weather-details">
            <span>
              <Thermometer size={18} />
              Indoor <strong>{indoor}</strong>
            </span>
            <span>
              <Droplets size={18} />
              Humidity <strong>{humidity}</strong>
            </span>
          </div>
        </header>
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
                  onClick={() => {
                    setScene("");
                    act({ type: "lights.off" });
                  }}
                >
                  <Power />
                  All off
                </Button>
              </div>
              {data.lights.map((light, index) => {
                const meta = LIGHTS[index];
                const Icon = lightIcons[index];
                if (!meta || !Icon) return null;
                return (
                  <div key={meta.id}>
                    {(index === 0 || index === 2) && <div className="group-label">{meta.room}</div>}
                    <div className="light-row">
                      <div className={`device-icon ${light.on ? "on" : ""}`}>
                        <Icon size={24} strokeWidth={1.5} />
                      </div>
                      <div className="device-info">
                        <strong>{meta.name}</strong>
                        <p>
                          {light.on ? `${light.level}%` : "Off"} ·{" "}
                          {light.color === "White"
                            ? light.shade.toLowerCase()
                            : light.color.toLowerCase()}
                        </p>
                      </div>
                      <div className="light-adjustments">
                        <Button
                          variant="eink"
                          className="shade-button"
                          title={`${light.shade} white · ${meta.name}`}
                          aria-label={`White shade for ${meta.name}`}
                          data-menu-open={lightMenu?.index === index && lightMenu.mode === "shade"}
                          onClick={() => setLightMenu({ index, mode: "shade" })}
                        >
                          <span className={`shade-swatch shade-${light.shade.toLowerCase()}`} />
                        </Button>
                        <Button
                          variant="eink"
                          size="icon"
                          title={`Color · ${meta.name}`}
                          aria-label={`Color for ${meta.name}`}
                          data-menu-open={lightMenu?.index === index && lightMenu.mode === "color"}
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
                      <Button
                        variant="eink"
                        className="toggle-button"
                        title={`${meta.name} ${light.on ? "on" : "off"}`}
                        aria-label={`Toggle ${meta.name}`}
                        aria-pressed={light.on}
                        onClick={() => {
                          setScene("");
                          act({ type: "light.toggle", entity: meta.id });
                        }}
                      >
                        <span className="switch-indicator">{light.on && <Check />}</span>
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="subheading">Scenes</div>
              <div className="scene-grid">
                {(
                  [
                    { name: "Bright", icon: Sun },
                    { name: "Evening", icon: Moon },
                    { name: "Movie", icon: Film },
                  ] as const
                ).map(({ name, icon: Icon }) => (
                  <Button
                    key={name}
                    variant="eink"
                    aria-pressed={scene === name || (name === "Movie" && data.movieActive)}
                    onClick={() => applyScene(name)}
                  >
                    <Icon />
                    {name}
                  </Button>
                ))}
              </div>
            </>
          )}
          {tab === "Vacuum" && (
            <>
              {(() => {
                const picked = data.rooms.filter(Boolean).length;
                const cleaning = data.vacuum.state === "cleaning";
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
                    <div className="vacuum-actions">
                      <Button
                        variant="eink"
                        aria-pressed={cleaning}
                        onClick={() => act({ type: "vacuum", op: cleaning ? "pause" : "start" })}
                      >
                        {cleaning ? <Pause /> : <Play />}
                        {cleaning ? "Pause" : "Start cleaning"}
                      </Button>
                      <Button variant="eink" onClick={() => act({ type: "vacuum", op: "dock" })}>
                        <Home />
                        Dock
                      </Button>
                      <Button variant="eink" onClick={locate}>
                        <MapPin />
                        Locate
                      </Button>
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
                      <Button variant="eink" onClick={() => act({ type: "rooms.clear" })}>
                        <RotateCcw />
                        Whole home
                      </Button>
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
                  value === null ? "—" : String(Math.round(value));
                const kwh = (value: number | null, digits: number) =>
                  value === null ? "—" : (value / 1000).toFixed(digits);
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
                    <div className="group-label">Plugs & power</div>
                    {PLUGS.map((meta, index) => {
                      const plug = data.plugs[index];
                      if (!plug) return null;
                      return (
                        <div className="light-row" key={meta.id}>
                          <div className={`device-icon ${plug.on ? "on" : ""}`}>
                            <Plug size={24} />
                          </div>
                          <div className="device-info">
                            <strong>{meta.name}</strong>
                            <p>{fmt(plug.power)} W</p>
                          </div>
                          <Button
                            variant="eink"
                            className="toggle-button"
                            title={`${meta.name} ${plug.on ? "on" : "off"}`}
                            aria-label={`Toggle ${meta.name}`}
                            aria-pressed={plug.on}
                            onClick={() => act({ type: "switch.toggle", entity: meta.id })}
                          >
                            <span className="switch-indicator">{plug.on && <Check />}</span>
                          </Button>
                        </div>
                      );
                    })}
                    <div className="subheading">Energy today</div>
                    <div className="power-stats">
                      <div>
                        <strong>
                          {wh(data.plugs[1]?.energyWh ?? null)}
                          <small> Wh</small>
                        </strong>
                        <small>Workstation</small>
                      </div>
                      <div>
                        <strong>
                          {wh(data.plugs[0]?.energyWh ?? null)}
                          <small> Wh</small>
                        </strong>
                        <small>TV Plug</small>
                      </div>
                      <div>
                        <strong>
                          {kwh(data.plugs[2]?.energyWh ?? null, 2)}
                          <small> kWh</small>
                        </strong>
                        <small>Kitchen boiler</small>
                      </div>
                    </div>
                    <div className="subheading">Total today</div>
                    <div className="power-stats">
                      <div>
                        <strong>
                          {kwh(total, 3)}
                          <small> kWh</small>
                        </strong>
                        <small>Across all plugs</small>
                      </div>
                    </div>
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
              <div className="scene-grid">
                <Button
                  variant="eink"
                  aria-pressed={data.movieActive}
                  onClick={() => applyScene("Movie")}
                >
                  <Film />
                  Movie mode
                </Button>
                <Button
                  variant="eink"
                  onClick={() => {
                    setScene("");
                    act({ type: "movie.end" });
                  }}
                >
                  <ArrowLeft />
                  End movie
                </Button>
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
                      <Button
                        variant="eink"
                        disabled={off}
                        aria-label={`Power ${name}`}
                        onClick={() => media(index, m.state === "off" ? "turn_on" : "turn_off")}
                      >
                        <Power />
                      </Button>
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
        <span className="demo-label" role="status">
          {status}
        </span>
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
