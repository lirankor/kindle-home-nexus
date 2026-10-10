// Media tab cards, the full-page amp view (volume on the 5-way, power-on routine), the source list,
// the TV modal, the radio screen (dial bar, station list, band picker) and the music screen (Jellyfin
// lists in tabs, Enter plays). State and keys live in `useMediaPanel` (src/lib/media-panel.ts).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  Compass,
  Disc3,
  Heart,
  Leaf,
  MicVocal,
  Moon,
  Music2,
  Pause,
  Play,
  Power,
  Radio,
  RadioTower,
  Server,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Sun,
  Tv,
  Volume1,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioDial } from "@/components/dial-bar";
import { FullModal } from "@/components/light-modals";
import { tryT } from "@/lib/i18n";
import type { Key, Lang } from "@/lib/i18n";
import { MUSIC_TABS, SEARCH_MIN_CHARS } from "@/lib/media";
import type {
  AmpSource,
  MediaSnapshot,
  MusicListItem,
  PowerOnStep,
  QueueProgress,
  RadioStationView,
} from "@/lib/media";
import {
  SEARCH_KEYS,
  SEARCH_KEY_ROWS,
  SOURCE_ROWS,
  displayDb,
  formatDb,
  musicItemDetail,
  musicItemTitle,
  powerOnStepKey,
} from "@/lib/media-ui";
import { QUEUE_PAGE_SIZE, RADIO_PAGE_SIZE } from "@/lib/media-panel";
import type { MediaPanel } from "@/lib/media-panel";
import { RADIO_BANDS, bandKey, listById, stationDetail } from "@/lib/radio-dial";

const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr">{children}</bdi>;
const POWER_ON_STEPS: PowerOnStep[] = ["plug", "wait", "reload", "turn_on", "source"];
const SOURCE_ICONS: Record<AmpSource, typeof Radio> = {
  SERVER: Server,
  CD: Tv,
  PHONO: Disc3,
  "NET RADIO": Radio,
  TUNER: RadioTower,
};
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const stateLabel = (lang: Lang, state: string | undefined) =>
  state === undefined ? "—" : (tryT(lang, `state.${state}`) ?? state);
const sourceLabel = (t: MediaPanel["t"], source: AmpSource | null) =>
  source ? t(`source.${source}` as Key) : "—";

/** Headline / sub lines for what the amp is doing, by kind. */
function nowPlayingLines(panel: MediaPanel, s: MediaSnapshot | null): [string, string, string] {
  const { t } = panel;
  if (!s) return ["—", "", ""];
  if (!s.amp.available) return [t("amp.unavailable"), "", ""];
  if (!s.amp.on) return [t("amp.off"), t("amp.offHint"), ""];
  const n = s.nowPlaying;
  switch (n.kind) {
    case "radio":
      return [n.station ?? t("source.NET RADIO"), n.title ?? "", ""];
    case "music":
      return [n.title ?? t("amp.nothing"), n.artist ?? "", n.album ?? ""];
    case "fm":
      return [
        n.station ?? t("source.TUNER"),
        n.title ?? "",
        n.preset === null ? "" : `P${n.preset}`,
      ];
    case "tv":
      return [t("source.CD"), t("source.CD.detail"), ""];
    case "phono":
      return [t("source.PHONO"), t("source.PHONO.detail"), ""];
    default:
      return [t("amp.nothing"), "", ""];
  }
}

/** One-liner for the amp card: "1LIVE · Zara Larsson - Memory Lane". */
function nowPlayingLine(panel: MediaPanel, s: MediaSnapshot): string {
  if (!s.amp.on) return "";
  const [a, b] = nowPlayingLines(panel, s);
  return [a, b].filter(Boolean).join(" · ");
}

export function MediaCards({ panel }: { panel: MediaPanel }) {
  const { t, lang, data: s } = panel;
  const tvState = stateLabel(lang, s?.tv.state);
  const tvOn = !!s && !["off", "unavailable", "unknown"].includes(s.tv.state);
  const ampLine = s
    ? `${s.amp.available ? (s.amp.on ? t("state.on") : t("state.off")) : t("state.unavailable")}${
        s.amp.on && s.amp.source ? ` · ${sourceLabel(t, s.amp.source)}` : ""
      }`
    : "—";
  const playing = s ? nowPlayingLine(panel, s) : "";
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>{t("media.title")}</h1>
          <p>{t("media.room")}</p>
        </div>
        <Music2 size={25} />
      </div>
      <div className="media-cards">
        <Button
          variant="eink"
          className="media-card"
          data-on={tvOn}
          title={t("media.openTv")}
          onClick={() => panel.open("tv")}
        >
          <span className="media-card-heading">
            <span className={`device-icon ${tvOn ? "on" : ""}`}>
              <Tv size={34} />
            </span>
            <span className="device-info">
              <strong>{t("media.tvName")}</strong>
              <span className="light-state">{tvState}</span>
            </span>
          </span>
          <span className="media-card-body">{s?.tv.source ?? "\u00a0"}</span>
          <span className="media-card-foot">
            <span>{tvOn ? t("media.nowPlaying") : "\u00a0"}</span>
          </span>
        </Button>
        <Button
          variant="eink"
          className="media-card media-card-amp"
          data-on={s?.amp.on ?? false}
          title={t("media.openAmp")}
          onClick={() => panel.openAmp()}
        >
          <span className="media-card-heading">
            <span className={`device-icon ${s?.amp.on ? "on" : ""}`}>
              <Music2 size={34} />
            </span>
            <span className="device-info">
              <strong>{t("media.amp")}</strong>
              <span className="light-state">{ampLine}</span>
            </span>
          </span>
          <span className="media-card-body media-now-line">{playing || "\u00a0"}</span>
          <span className="media-card-foot">
            <span>{s?.amp.on ? t("media.volume") : "\u00a0"}</span>
            {s?.amp.on && (
              <strong className="media-db">
                <Ltr>
                  {formatDb(displayDb(s.amp))} <small>dB</small>
                </Ltr>
              </strong>
            )}
          </span>
        </Button>
      </div>
    </>
  );
}

function PowerOnBlock({ panel }: { panel: MediaPanel }) {
  const { t, powerOn } = panel;
  if (!powerOn) return null;
  const at = POWER_ON_STEPS.indexOf(powerOn.step);
  const failed = powerOn.step === "failed";
  return (
    <section className="poweron" aria-live="polite">
      <h2>{failed ? t("poweron.failed") : t("poweron.title")}</h2>
      <ol className="poweron-steps">
        {POWER_ON_STEPS.map((name, index) => {
          const state = failed
            ? "pending"
            : index < at || powerOn.step === "done"
              ? "done"
              : index === at
                ? "active"
                : "pending";
          return (
            <li key={name} data-state={state}>
              <span className="poweron-dot" aria-hidden="true">
                {state === "done" ? <Check size={18} strokeWidth={3} /> : null}
              </span>
              {t(powerOnStepKey(name))}
            </li>
          );
        })}
      </ol>
      <p className="modal-hint">
        {failed && powerOn.error ? (
          powerOn.error
        ) : (
          <Ltr>{t("poweron.elapsed", { s: Math.round(powerOn.elapsedMs / 1000) })}</Ltr>
        )}
      </p>
    </section>
  );
}

/** Position inside the current track, counted on from the last snapshot while it plays (the snapshot
 *  arrives every 10 s; a 1 s ticker runs only while music plays in the amp view). */
function useTrackPosition(queue: QueueProgress | null): number {
  const playing = queue?.status === "playing";
  const [anchor, setAnchor] = useState<{ queue: QueueProgress | null; at: number }>({
    queue: null,
    at: 0,
  });
  if (anchor.queue !== queue) setAnchor({ queue, at: Date.now() });
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [playing]);
  if (!queue) return 0;
  if (!playing || anchor.queue !== queue) return queue.positionMs;
  const raw = queue.positionMs + (Date.now() - anchor.at);
  return queue.durationMs > 0 ? Math.min(queue.durationMs, raw) : raw;
}

/** What the centre of the transport pad shows. */
type TransportMode = "playing" | "paused" | "stopped" | "off";

/**
 * The 5-way as a picture: a rounded square (the Kindle's button) with the play state inside and four
 * satellites outside it — volume up above, volume down below, previous / next left / right (physical
 * directions in both languages); source and volume flank it in a single bar. The keys do the work, this only shows it.
 */
function TransportControl({
  db,
  label,
  source,
  sourceTitle,
  mode,
  small = false,
}: {
  db: number | null;
  label: string;
  source: string;
  sourceTitle: string;
  mode: TransportMode;
  small?: boolean;
}) {
  // All five icons share one size; the square only frames the centre one.
  const icon = small ? 22 : 30;
  const Centre =
    mode === "playing" ? Pause : mode === "paused" ? Play : mode === "stopped" ? Square : Power;
  return (
    <div
      className={`transport${small ? " transport-small" : ""}`}
      role="group"
      aria-label={label}
      data-mode={mode}
      data-db={db ?? ""}
    >
      <div className="transport-reading">
        <span>{sourceTitle}</span>
        <strong>{source}</strong>
      </div>
      <div className="transport-grid">
        <span className="transport-sat transport-vol transport-up" aria-hidden="true">
          <Volume2 size={icon} />
          <b>+</b>
        </span>
        <SkipBack size={icon} aria-hidden="true" className="transport-sat transport-prev" />
        <div className="transport-pad">
          <Centre
            size={icon}
            strokeWidth={2}
            aria-hidden="true"
            className="transport-centre"
            fill={mode === "playing" ? "currentColor" : "none"}
          />
        </div>
        <SkipForward size={icon} aria-hidden="true" className="transport-sat transport-next" />
        <span className="transport-sat transport-vol transport-down" aria-hidden="true">
          <Volume1 size={icon} />
          <b>−</b>
        </span>
      </div>
      <div className="transport-reading">
        <span>{label}</span>
        <div className="transport-db" aria-label={label}>
          <Ltr>
            <strong>{formatDb(db)}</strong>
            <small>dB</small>
          </Ltr>
        </div>
      </div>
    </div>
  );
}

/** Centre glyph of the transport pad for the current snapshot. */
function transportMode(s: MediaSnapshot | null): TransportMode {
  if (!s || !s.amp.on) return "off";
  if (s.nowPlaying.kind === "music" && s.queue)
    return s.queue.status === "playing"
      ? "playing"
      : s.queue.status === "paused"
        ? "paused"
        : "stopped";
  // Radio / FM: Enter stops and restarts the stream, so the centre reads like a player too.
  if (s.nowPlaying.kind === "radio" || s.nowPlaying.kind === "fm")
    return s.amp.state === "playing" ? "playing" : "paused";
  return s.amp.state === "playing" ? "playing" : "stopped";
}

function AmpView({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, data: s } = panel;
  const [line1, line2, line3] = nowPlayingLines(panel, s);
  const on = s?.amp.on ?? false;
  const art = on && s?.nowPlaying.artItemId ? s.nowPlaying.artItemId : null;
  const Glyph = on && s?.amp.source ? SOURCE_ICONS[s.amp.source] : Power;
  const queue = on && s?.nowPlaying.kind === "music" ? s.queue : null;
  const position = useTrackPosition(queue);
  const db = on && s ? displayDb(s.amp) : null;
  return (
    <FullModal label={t("amp.label")} actions={panel.modalActions} status={status} compactStatus>
      <div className="screen-stack">
        {panel.showPowerOn ? (
          <PowerOnBlock panel={panel} />
        ) : (
          <header className="amp-head" data-on={on}>
            <span className="amp-meta">
              <strong className="amp-title">{line1}</strong>
              <span className="amp-sub">{line2 || " "}</span>
              <span className="amp-sub amp-sub2">{line3 || " "}</span>
            </span>
          </header>
        )}
        {queue && queue.track && (
          <div className="amp-progress" dir="ltr" data-status={queue.status}>
            <div className="progress-track">
              <span
                style={{
                  width: `${queue.durationMs ? Math.min(100, (position / queue.durationMs) * 100) : 0}%`,
                }}
              />
            </div>
            <div className="amp-times">
              <span className="amp-time-pos">{mmss(position)}</span>
              <span className="amp-queue-pos">
                {t("media.queuePos", { index: queue.index + 1, count: queue.count })}
                {queue.status === "paused" ? ` · ${t("act.pause")}` : ""}
              </span>
              <span>{mmss(queue.durationMs)}</span>
            </div>
          </div>
        )}
        {!panel.showPowerOn && (
          <div className="amp-art" data-on={on} aria-hidden="true">
            {art ? (
              <img
                src={`/media/img?item=${encodeURIComponent(art)}&w=240`}
                alt=""
                width={240}
                height={240}
              />
            ) : (
              <Glyph size={64} strokeWidth={1.4} />
            )}
          </div>
        )}
        <div className="amp-transport" data-on={on}>
          <TransportControl
            db={db}
            label={t("media.volume")}
            sourceTitle={t("media.source")}
            source={sourceLabel(t, s?.amp.source ?? null)}
            mode={transportMode(s)}
          />
        </div>
      </div>
    </FullModal>
  );
}

function SourceList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, data: s, cursor } = panel;
  return (
    <FullModal label={t("source.title")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("source.title")}</h1>
        <p>{t("media.amp")}</p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("source.title")}>
        {SOURCE_ROWS.map((source, index) => {
          const Icon = SOURCE_ICONS[source];
          const current = s?.amp.on && s.amp.source === source;
          return (
            <Button
              key={source}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={current ?? false}
              onClick={() => {
                panel.setCursor(index);
                panel.applySource(source);
              }}
            >
              <span className="source-row-icon">
                <Icon size={30} strokeWidth={1.6} />
              </span>
              <span className="source-row-text">
                <strong>{t(`source.${source}` as Key)}</strong>
                <span>{t(`source.${source}.detail` as Key)}</span>
              </span>
              {current && <Check size={28} strokeWidth={2.5} aria-hidden="true" />}
            </Button>
          );
        })}
      </div>
      <p className="modal-hint">{t("source.hint")}</p>
    </FullModal>
  );
}

function TvModal({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, lang, data: s } = panel;
  const on = !!s && !["off", "unavailable", "unknown"].includes(s.tv.state);
  return (
    <FullModal label={t("tv.label")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("media.tvName")}</h1>
        <p>
          <strong>{stateLabel(lang, s?.tv.state)}</strong>
        </p>
      </header>
      <div className="tv-glyph" data-on={on}>
        <Tv size={150} strokeWidth={1.1} />
      </div>
      <p className="modal-look">{s?.tv.source ? `${t("media.source")} · ${s.tv.source}` : " "}</p>
    </FullModal>
  );
}

// ---- Radio screen ----

/** Station logo from the image route (grayscale PNG); a glyph when the station has none (404). */
function StationLogo({
  station,
  size,
  alt,
}: {
  station: RadioStationView | null;
  size: number;
  alt: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const id = station?.id ?? null;
  const show = !!id && !!station?.logo && !id.startsWith("yt:") && failed !== id;
  return (
    <span className="radio-logo" style={{ width: size, height: size }} aria-hidden={!show}>
      {show ? (
        <img
          src={`/media/img?station=${encodeURIComponent(id)}&w=${size}`}
          alt={alt}
          width={size}
          height={size}
          onError={() => setFailed(id)}
        />
      ) : (
        <Radio size={Math.round(size * 0.55)} strokeWidth={1.4} />
      )}
    </span>
  );
}

function RadioDialView({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, data: s, dialPos, dialStation, radioLists } = panel;
  const list = listById(radioLists, dialPos.list);
  const on = s?.amp.on ?? false;
  const playingId = on && s?.nowPlaying.kind === "radio" ? s.nowPlaying.stationId : null;
  const playing =
    (playingId ? radioLists?.flatMap((l) => l.stations).find((x) => x.id === playingId) : null) ??
    null;
  const name = !s
    ? "—"
    : !s.amp.available
      ? t("amp.unavailable")
      : !on
        ? t("amp.off")
        : s.nowPlaying.kind === "radio"
          ? (playing?.name ?? s.nowPlaying.station ?? t("source.NET RADIO"))
          : t("amp.nothing");
  const song = !s || !s.amp.available ? "" : !on ? t("radio.offHint") : (s.nowPlaying.title ?? "");
  const detail = on && playing ? stationDetail(playing) : "";
  const db = on && s ? displayDb(s.amp) : null;
  const loading = panel.radioListsLoading && !radioLists;
  return (
    <FullModal label={t("radio.title")} actions={panel.modalActions} status={status} compactStatus>
      <div className="screen-stack">
        {panel.showPowerOn ? (
          <PowerOnBlock panel={panel} />
        ) : (
          <>
            <div className="radio-now-text">
              <strong className="radio-now-name">{name}</strong>
              <span className="radio-now-song">{song || "\u00a0"}</span>
              <span className="radio-now-detail">{detail ? <Ltr>{detail}</Ltr> : "\u00a0"}</span>
            </div>
            <div className="radio-cover" data-on={on}>
              <StationLogo
                station={on ? playing : dialStation}
                size={200}
                alt={t("radio.logoAlt")}
              />
            </div>
            <RadioDial
              bandName={t(bandKey(dialPos.list))}
              stations={list?.stations ?? []}
              list={dialPos.list}
              index={dialPos.index}
              emptyText={
                loading
                  ? ""
                  : dialPos.list === RADIO_BANDS[0]
                    ? t("radio.noFavourites")
                    : t("radio.empty")
              }
            />
            {panel.radioListsError && <p className="radio-error">{panel.radioListsError}</p>}
            <div className="radio-transport-row" data-on={on}>
              <TransportControl
                db={db}
                label={t("media.volume")}
                sourceTitle={t("media.source")}
                source={sourceLabel(t, s?.amp.source ?? null)}
                mode={transportMode(s)}
                small
              />
            </div>
          </>
        )}
      </div>
    </FullModal>
  );
}

/** Enter on the dial: the stations of the current band, 8 per page (F2 / F3 page), Enter tunes. */
function RadioStationList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, dialPos, radioLists, cursor } = panel;
  const stations = listById(radioLists, dialPos.list)?.stations ?? [];
  const page = Math.floor(cursor / RADIO_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(stations.length / RADIO_PAGE_SIZE));
  const rows = stations.slice(page * RADIO_PAGE_SIZE, (page + 1) * RADIO_PAGE_SIZE);
  return (
    <FullModal
      label={t("radio.stationsTitle")}
      actions={panel.modalActions}
      status={status}
      hint={t("radio.listHint")}
    >
      <header className="modal-heading radio-list-heading">
        <h1>{t(bandKey(dialPos.list))}</h1>
        <p>
          {t("radio.count", { n: stations.length })}
          {pages > 1 && (
            <>
              {" · "}
              <Ltr>
                {page + 1}/{pages}
              </Ltr>
            </>
          )}
        </p>
      </header>
      <div className="source-rows radio-rows" role="listbox" aria-label={t("radio.stationsTitle")}>
        {rows.length === 0 && (
          <p className="radio-empty">
            {dialPos.list === RADIO_BANDS[0] ? t("radio.noFavourites") : t("radio.empty")}
          </p>
        )}
        {rows.map((station, i) => {
          const index = page * RADIO_PAGE_SIZE + i;
          const detail = stationDetail(station, " ");
          return (
            <Button
              key={station.id}
              variant="eink"
              className="source-row radio-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={index === dialPos.index}
              onClick={() => panel.tuneTo({ list: dialPos.list, index })}
            >
              <StationLogo station={station} size={48} alt="" />
              <span className="source-row-text">
                <strong>{station.name}</strong>
              </span>
              {detail && (
                <span className="radio-row-detail">
                  <Ltr>{detail}</Ltr>
                </span>
              )}
            </Button>
          );
        })}
      </div>
    </FullModal>
  );
}

/** F1 on the dial: the bands; Enter / F4 shows the chosen one on the dial (nothing is tuned). */
function RadioBandList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, dialPos, radioLists, cursor } = panel;
  return (
    <FullModal
      label={t("radio.bandsTitle")}
      actions={panel.modalActions}
      status={status}
      compactStatus
    >
      <header className="modal-heading radio-list-heading">
        <h1>{t("radio.bandsTitle")}</h1>
        <p>{t("radio.bandsSub")}</p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("radio.bandsTitle")}>
        {RADIO_BANDS.map((band, index) => {
          const n = listById(radioLists, band)?.stations.length ?? 0;
          const Icon = band === RADIO_BANDS[0] ? Heart : Radio;
          return (
            <Button
              key={band}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={band === dialPos.list}
              onClick={() => panel.selectBand(band)}
            >
              <span className="source-row-icon">
                <Icon size={30} strokeWidth={1.6} />
              </span>
              <span className="source-row-text">
                <strong>{t(bandKey(band))}</strong>
                <span>{t("radio.count", { n })}</span>
              </span>
            </Button>
          );
        })}
      </div>
    </FullModal>
  );
}

function RadioScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  switch (panel.radioView) {
    case "bands":
      return <RadioBandList panel={panel} status={status} />;
    case "stations":
      return <RadioStationList panel={panel} status={status} />;
    default:
      return <RadioDialView panel={panel} status={status} />;
  }
}

// ---- Music screen (Jellyfin) ----

const MIX_ICONS: Record<string, typeof Sparkles> = {
  daily: Sun,
  discover: Compass,
  relaxed: Leaf,
  evening: Moon,
};
const KIND_ICONS: Record<MusicListItem["kind"], typeof Sparkles> = {
  mix: Sparkles,
  artist: MicVocal,
  album: Disc3,
  track: Music2,
};

/** Cover art from the image route (grayscale PNG); a glyph for the kind when there is none (404). */
function MusicArt({ item, size, alt }: { item: MusicListItem; size: number; alt: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const id = item.artItemId;
  const show = !!id && failed !== id;
  const Icon = (item.kind === "mix" && MIX_ICONS[item.id]) || KIND_ICONS[item.kind];
  return (
    <span
      className="radio-logo music-art"
      style={{ width: size, height: size }}
      aria-hidden={!show}
    >
      {show ? (
        <img
          src={`/media/img?item=${encodeURIComponent(id)}&w=${size}`}
          alt={alt}
          width={size}
          height={size}
          onError={() => setFailed(id)}
        />
      ) : (
        <Icon size={Math.round(size * 0.55)} strokeWidth={1.4} />
      )}
    </span>
  );
}

/** Tabs (left / right), 8 rows per page (up / down, F2 / F3 page), Enter plays the highlighted row. */
function MusicScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, data: s, musicTab, musicPage, musicPages, musicRows, musicCursor } = panel;
  const on = s?.amp.on ?? false;
  const loading = panel.musicListLoading && !panel.musicListError;
  return (
    <FullModal
      label={t("music.title")}
      actions={panel.modalActions}
      status={status}
      hint={on ? t("music.hint") : t("music.offHint")}
    >
      {panel.showPowerOn ? (
        <PowerOnBlock panel={panel} />
      ) : (
        <>
          <div className="music-tabs" role="tablist" aria-label={t("music.tabsLabel")}>
            {MUSIC_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                className="music-tab"
                aria-selected={tab === musicTab}
                tabIndex={-1}
                onClick={() => panel.selectMusicTab(tab)}
              >
                {t(`music.tab.${tab}` as Key)}
              </button>
            ))}
          </div>
          <div
            className="source-rows music-rows"
            role="listbox"
            aria-label={t(`music.tab.${musicTab}` as Key)}
            aria-busy={loading}
          >
            {loading && <p className="music-note">{t("music.loading")}</p>}
            {panel.musicListError && <p className="radio-error">{panel.musicListError}</p>}
            {!loading && !panel.musicListError && musicRows.length === 0 && (
              <p className="music-note">{t("music.empty")}</p>
            )}
            {musicRows.map((item, index) => (
              <Button
                key={`${item.kind}:${item.id}`}
                variant="eink"
                className="source-row music-row"
                role="option"
                aria-selected={index === musicCursor}
                aria-pressed={index === musicCursor}
                data-kind={item.kind}
                onClick={() => panel.playItem(item)}
              >
                <MusicArt item={item} size={56} alt="" />
                <span className="source-row-text">
                  <strong>{musicItemTitle(item, t)}</strong>
                  <span>{musicItemDetail(item, t) || "\u00a0"}</span>
                </span>
              </Button>
            ))}
          </div>
          <div className="music-foot">
            <strong className="music-page">
              <Ltr>
                {Math.min(musicPage, musicPages - 1) + 1}/{musicPages}
              </Ltr>
            </strong>
          </div>
        </>
      )}
    </FullModal>
  );
}

/** Enter on an artist (lists or search): their albums, oldest first, 8 per page. Enter plays the
 *  album, F2 / F3 page, F4 shuffles everything by the artist, F1 returns to where they were chosen. */
function ArtistScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, artistItem, artistData, artistRows, artistCursor, artistPage, artistPages } = panel;
  const loading = panel.artistLoading && !panel.artistError;
  const title = artistData?.artist.title || artistItem?.title || "";
  const albumDetail = (item: MusicListItem) =>
    [
      item.year ?? null,
      item.trackCount ? t("music.tracks", { n: item.trackCount }) : null,
      item.genre ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <FullModal
      label={title || t("music.tab.artists")}
      actions={panel.modalActions}
      status={status}
      hint={t("artist.hint")}
      compactStatus
    >
      <header className="modal-heading radio-list-heading artist-heading">
        {artistItem && <MusicArt item={artistItem} size={64} alt="" />}
        <div>
          <h1>{title || "…"}</h1>
          <p>
            {artistData ? t("music.albums", { n: artistData.total }) : t("music.loading")}
            {artistPages > 1 && (
              <>
                {" · "}
                <Ltr>
                  {artistPage + 1}/{artistPages}
                </Ltr>
              </>
            )}
          </p>
        </div>
      </header>
      <div
        className="source-rows music-rows artist-rows"
        role="listbox"
        aria-label={t("music.tab.albums")}
        aria-busy={loading}
      >
        {loading && <p className="music-note">{t("music.loading")}</p>}
        {panel.artistError && <p className="radio-error">{panel.artistError}</p>}
        {!loading && !panel.artistError && artistRows.length === 0 && (
          <p className="music-note">{t("artist.empty")}</p>
        )}
        {artistRows.map((item, index) => (
          <Button
            key={item.id}
            variant="eink"
            className="source-row music-row artist-row"
            role="option"
            aria-selected={index === artistCursor}
            aria-pressed={index === artistCursor}
            data-kind={item.kind}
            onClick={() => panel.playItem(item)}
          >
            <MusicArt item={item} size={56} alt="" />
            <span className="source-row-text">
              <strong>{item.title}</strong>
              <span>{albumDetail(item) || "\u00a0"}</span>
            </span>
          </Button>
        ))}
      </div>
    </FullModal>
  );
}

/** F4 on the music screen: typed text, an on-screen keyboard for the 5-way, and the matching artists
 *  and albums (from the second character) below it. F1 cancel, F2 delete, F3 space, F4 enter. */
function SearchScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, searchQuery, searchFocus, searchKey, searchRows, searchCursor } = panel;
  const typed = searchQuery.trim().length >= SEARCH_MIN_CHARS;
  const loading = typed && panel.searchLoading && searchRows.length === 0 && !panel.searchError;
  const kindLabel = (item: MusicListItem) =>
    item.kind === "artist" ? t("search.artist") : item.kind === "album" ? t("search.album") : "";
  let keyIndex = 0;
  return (
    <FullModal
      label={t("search.title")}
      actions={panel.modalActions}
      status={status}
      hint={t("search.hint")}
      compactStatus
    >
      <div
        className="search-field"
        dir="ltr"
        data-empty={searchQuery === ""}
        role="textbox"
        aria-readonly="true"
        aria-label={t("search.title")}
      >
        {searchQuery === "" ? (
          <span className="search-placeholder">{t("search.placeholder")}</span>
        ) : (
          <>
            <span className="search-text">{searchQuery}</span>
            <span className="search-caret" aria-hidden />
          </>
        )}
      </div>
      <div
        className="search-keys"
        dir="ltr"
        role="grid"
        aria-label={t("search.keyboard")}
        data-focus={searchFocus}
      >
        {SEARCH_KEY_ROWS.en.map((row, r) => (
          <div key={r} role="row">
            {row.map((ch) => {
              const index = keyIndex++;
              const active = index === searchKey;
              return (
                <Button
                  key={ch}
                  variant="eink"
                  className="search-key"
                  role="gridcell"
                  aria-selected={searchFocus === "keys" && active}
                  aria-pressed={active}
                  tabIndex={-1}
                  onClick={() => {
                    panel.setSearchKey(index);
                    panel.typeSearchChar(SEARCH_KEYS[index] ?? ch);
                  }}
                >
                  {ch}
                </Button>
              );
            })}
          </div>
        ))}
      </div>
      <div
        className="source-rows music-rows search-rows"
        role="listbox"
        aria-label={t("search.results")}
        aria-busy={loading}
      >
        {loading && <p className="music-note">{t("music.loading")}</p>}
        {panel.searchError && <p className="radio-error">{panel.searchError}</p>}
        {typed && !loading && !panel.searchError && searchRows.length === 0 && (
          <p className="music-note">{t("search.empty")}</p>
        )}
        {searchRows.map((item, index) => (
          <Button
            key={`${item.kind}:${item.id}`}
            variant="eink"
            className="source-row music-row search-row"
            role="option"
            aria-selected={searchFocus === "results" && index === searchCursor}
            aria-pressed={searchFocus === "results" && index === searchCursor}
            data-kind={item.kind}
            onClick={() => panel.playItem(item)}
          >
            <MusicArt item={item} size={46} alt="" />
            <span className="source-row-text">
              <strong>{item.title}</strong>
              <span>{[kindLabel(item), musicItemDetail(item, t)].filter(Boolean).join(" · ")}</span>
            </span>
          </Button>
        ))}
      </div>
    </FullModal>
  );
}

/** F4 on the amp view while Jellyfin plays: the queue, 8 rows per page, Enter / F4 jumps to a track. */
function QueueScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, queueList, queueTracks, queueCursor, queuePage, queuePages } = panel;
  const rows = queueTracks.slice(queuePage * QUEUE_PAGE_SIZE, (queuePage + 1) * QUEUE_PAGE_SIZE);
  const current = queueList?.index ?? -1;
  return (
    <FullModal label={t("queue.title")} actions={panel.modalActions} status={status} compactStatus>
      <header className="modal-heading radio-list-heading">
        <h1>{t("queue.title")}</h1>
        <p>
          {queueList?.title ?? (panel.queueListLoading ? "…" : t("queue.empty"))}
          {queueList && (
            <>
              {" · "}
              <Ltr>
                {current + 1}/{queueTracks.length}
              </Ltr>
              {queuePages > 1 && (
                <>
                  {" · "}
                  <Ltr>
                    {queuePage + 1}/{queuePages}
                  </Ltr>
                </>
              )}
            </>
          )}
        </p>
      </header>
      <div className="source-rows music-rows" role="listbox" aria-label={t("queue.title")}>
        {queueList && rows.length === 0 && <p className="radio-empty">{t("queue.empty")}</p>}
        {rows.map((track, i) => {
          const index = queuePage * QUEUE_PAGE_SIZE + i;
          return (
            <Button
              key={`${index}-${track.id}`}
              variant="eink"
              className="source-row music-row queue-row"
              role="option"
              aria-selected={index === queueCursor}
              aria-pressed={index === queueCursor}
              data-current={index === current}
              onClick={() => panel.jumpQueueTo(index)}
            >
              <span className="source-row-icon queue-num">
                <Ltr>{index + 1}</Ltr>
              </span>
              <span className="source-row-text">
                <strong>{track.title}</strong>
                <span>{track.artist ?? "\u00a0"}</span>
              </span>
              <span className="radio-row-detail">
                <Ltr>{mmss(track.durationMs)}</Ltr>
              </span>
            </Button>
          );
        })}
      </div>
    </FullModal>
  );
}

export function MediaModal({ panel, status }: { panel: MediaPanel; status: string }) {
  switch (panel.screen) {
    case "now":
      return <AmpView panel={panel} status={status} />;
    case "queue":
      return <QueueScreen panel={panel} status={status} />;
    case "source":
      return <SourceList panel={panel} status={status} />;
    case "tv":
      return <TvModal panel={panel} status={status} />;
    case "radio":
      return <RadioScreen panel={panel} status={status} />;
    case "music":
      return <MusicScreen panel={panel} status={status} />;
    case "search":
      return <SearchScreen panel={panel} status={status} />;
    case "artist":
      return <ArtistScreen panel={panel} status={status} />;
    default:
      return null;
  }
}
