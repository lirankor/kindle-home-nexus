// Media tab cards, the full-page amp view (volume on the 5-way, power-on routine), the source list,
// the TV modal, the radio screen (dial bar, station list, band picker) and the music placeholder
// (milestone 4 drops in here). State and keys live in `useMediaPanel` (src/lib/media-panel.ts).
import { useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Disc3,
  ListMusic,
  Music2,
  Power,
  Radio,
  RadioTower,
  Server,
  Tv,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FullModal } from "@/components/light-modals";
import { tryT } from "@/lib/i18n";
import type { Key, Lang } from "@/lib/i18n";
import type { AmpSource, MediaSnapshot, PowerOnStep, RadioStationView } from "@/lib/media";
import { SOURCE_ROWS, displayDb, formatDb, powerOnStepKey } from "@/lib/media-ui";
import { RADIO_PAGE_SIZE } from "@/lib/media-panel";
import type { MediaPanel } from "@/lib/media-panel";
import {
  DIAL,
  RADIO_BANDS,
  bandKey,
  dialSegments,
  estimateWidth,
  listById,
  planDialLabels,
  stationDetail,
  stationLabel,
  stationX,
} from "@/lib/radio-dial";
import type { DialLabel } from "@/lib/radio-dial";

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
          onClick={() => panel.open("now")}
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

function AmpView({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, data: s } = panel;
  const [line1, line2, line3] = nowPlayingLines(panel, s);
  const on = s?.amp.on ?? false;
  const art = on && s?.nowPlaying.artItemId ? s.nowPlaying.artItemId : null;
  const Glyph = on && s?.amp.source ? SOURCE_ICONS[s.amp.source] : Power;
  const queue = on && s?.nowPlaying.kind === "music" ? s.queue : null;
  const db = on && s ? displayDb(s.amp) : null;
  return (
    <FullModal label={t("amp.label")} actions={panel.modalActions} status={status}>
      {panel.showPowerOn ? (
        <PowerOnBlock panel={panel} />
      ) : (
        <header className="amp-head" data-on={on}>
          <span className="amp-art" aria-hidden="true">
            {art ? (
              <img
                src={`/media/img?item=${encodeURIComponent(art)}&w=160`}
                alt=""
                width={160}
                height={160}
              />
            ) : (
              <Glyph size={72} strokeWidth={1.4} />
            )}
          </span>
          <span className="amp-meta">
            <span className="amp-badge">
              {on ? sourceLabel(t, s?.amp.source ?? null) : t("media.amp")}
            </span>
            <strong className="amp-title">{line1}</strong>
            <span className="amp-sub">{line2 || " "}</span>
            <span className="amp-sub amp-sub2">{line3 || " "}</span>
          </span>
        </header>
      )}
      {queue && queue.track && (
        <div className="amp-progress" dir="ltr">
          <div className="progress-track">
            <span
              style={{
                width: `${queue.durationMs ? Math.min(100, (queue.positionMs / queue.durationMs) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="amp-times">
            <span>{mmss(queue.positionMs)}</span>
            <span>{t("media.queuePos", { index: queue.index + 1, count: queue.count })}</span>
            <span>{mmss(queue.durationMs)}</span>
          </div>
        </div>
      )}
      <div className="amp-knob-block" data-on={on}>
        <ChevronUp size={30} aria-hidden="true" />
        <div className="amp-knob" role="meter" aria-label={t("media.volume")}>
          <Ltr>
            <strong>{formatDb(db)}</strong>
            <small>dB</small>
          </Ltr>
        </div>
        <ChevronDown size={30} aria-hidden="true" />
        <p className="modal-hint">{t("amp.volHint")}</p>
        <p className="modal-hint amp-nav-hint">{t("amp.navHint")}</p>
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

/**
 * The retro dial bar after docs/design/radio-dial-reference.svg: one segmented black bar across the
 * content width, a thick rounded needle, a name above the left end ("AM" / "FM" in the reference)
 * and labels above / below the bar. Pure black on white. `stops` are x positions that get a longer
 * solid block in the bar; `needleX` is in viewBox units (see DIAL in src/lib/radio-dial.ts).
 */
export function DialBar({
  name,
  labels,
  stops,
  needleX,
  emptyText,
  ...rest
}: {
  name: string;
  labels: DialLabel[];
  stops: number[];
  needleX: number | null;
  emptyText?: string | undefined;
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <svg
      className="radio-dial"
      viewBox={`0 0 ${DIAL.width} ${DIAL.height}`}
      width={DIAL.width}
      height={DIAL.height}
      role="img"
      aria-label={name}
      direction="ltr"
      {...rest}
    >
      <text x={4} y={DIAL.aboveY} fontSize={DIAL.namePx} fontWeight={700} textAnchor="start">
        {name}
      </text>
      {dialSegments(stops).map((seg, i) => (
        <rect key={i} x={seg.x} y={DIAL.barY} width={seg.w} height={DIAL.barH} />
      ))}
      {emptyText && (
        <text
          x={DIAL.width / 2}
          y={DIAL.aboveY}
          fontSize={DIAL.currentPx}
          fontWeight={700}
          textAnchor="middle"
        >
          {emptyText}
        </text>
      )}
      {labels.map((l) => (
        <text
          key={`${l.side}-${l.index}`}
          x={l.x}
          y={l.side === "above" ? DIAL.aboveY : DIAL.belowY}
          fontSize={l.current ? DIAL.currentPx : DIAL.labelPx}
          fontWeight={l.current ? 700 : 400}
          textAnchor={l.anchor}
          data-current={l.current || undefined}
        >
          {l.text}
        </text>
      ))}
      {needleX !== null && (
        <rect
          className="radio-needle"
          x={needleX - DIAL.needleW / 2}
          y={6}
          width={DIAL.needleW}
          height={DIAL.height - 12}
          rx={DIAL.needleW / 2}
        />
      )}
    </svg>
  );
}

/** The radio band on the dial bar: stations spread evenly, the needle on the current one. */
export function RadioDial({
  bandName,
  stations,
  list,
  index,
  emptyText,
}: {
  bandName: string;
  stations: RadioStationView[];
  list: string;
  index: number;
  emptyText: string;
}) {
  const n = stations.length;
  const labels = planDialLabels(
    stations.map((s) => stationLabel(s, list)),
    n > 0 ? index : -1,
    [0, estimateWidth(bandName, DIAL.namePx)],
  );
  const stops = stations.map((_, i) => stationX(i, n));
  return (
    <DialBar
      name={bandName}
      labels={labels}
      stops={stops}
      needleX={n > 0 ? stationX(Math.min(index, n - 1), n) : null}
      emptyText={n === 0 ? emptyText : undefined}
      data-list={list}
      data-index={n > 0 ? index : -1}
    />
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
    <FullModal label={t("radio.title")} actions={panel.modalActions} status={status}>
      {panel.showPowerOn ? (
        <PowerOnBlock panel={panel} />
      ) : (
        <>
          <div className="radio-bands" role="tablist" aria-label={t("radio.bandsLabel")}>
            {RADIO_BANDS.map((band) => (
              <Button
                key={band}
                variant="eink"
                className="radio-band"
                role="tab"
                aria-selected={band === dialPos.list}
                aria-pressed={band === dialPos.list}
                onClick={() => panel.selectBand(band)}
              >
                {t(bandKey(band))}
              </Button>
            ))}
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
          <div className="radio-now" data-on={on}>
            <StationLogo station={on ? playing : dialStation} size={96} alt={t("radio.logoAlt")} />
            <div className="radio-now-text">
              <strong className="radio-now-name">{name}</strong>
              <span className="radio-now-song">{song || "\u00a0"}</span>
              <span className="radio-now-detail">{detail ? <Ltr>{detail}</Ltr> : "\u00a0"}</span>
            </div>
            <div className="radio-now-db" role="meter" aria-label={t("media.volume")}>
              <Ltr>
                <strong>{formatDb(db)}</strong>
                <small>dB</small>
              </Ltr>
            </div>
          </div>
          {panel.radioListsError && <p className="radio-error">{panel.radioListsError}</p>}
          <p className="modal-hint radio-hint">{t("radio.hint")}</p>
        </>
      )}
    </FullModal>
  );
}

/** Enter on the dial: the stations of the current band, 8 per page, Enter tunes. */
function RadioStationList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, dialPos, radioLists, cursor } = panel;
  const stations = listById(radioLists, dialPos.list)?.stations ?? [];
  const page = Math.floor(cursor / RADIO_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(stations.length / RADIO_PAGE_SIZE));
  const rows = stations.slice(page * RADIO_PAGE_SIZE, (page + 1) * RADIO_PAGE_SIZE);
  return (
    <FullModal label={t("radio.stationsTitle")} actions={panel.modalActions} status={status}>
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
      <p className="modal-hint">{t("radio.listHint")}</p>
    </FullModal>
  );
}

/** F2 on the dial: the four bands; Enter / F4 shows one on the dial without tuning. */
function RadioBandPicker({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, dialPos, radioLists, cursor } = panel;
  return (
    <FullModal label={t("radio.bandsTitle")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("radio.bandsTitle")}</h1>
        <p>{t("radio.title")}</p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("radio.bandsTitle")}>
        {RADIO_BANDS.map((band, index) => {
          const count = listById(radioLists, band)?.stations.length ?? 0;
          const current = band === dialPos.list;
          return (
            <Button
              key={band}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={current}
              onClick={() => panel.selectBand(band)}
            >
              <span className="source-row-icon">
                <Radio size={30} strokeWidth={1.6} />
              </span>
              <span className="source-row-text">
                <strong>{t(bandKey(band))}</strong>
                <span>
                  {count === 0 && band === RADIO_BANDS[0]
                    ? t("radio.noFavourites")
                    : t("radio.count", { n: count })}
                </span>
              </span>
              {current && <Check size={28} strokeWidth={2.5} aria-hidden="true" />}
            </Button>
          );
        })}
      </div>
      <p className="modal-hint">{t("radio.bandHint")}</p>
    </FullModal>
  );
}

function RadioScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  switch (panel.radioView) {
    case "stations":
      return <RadioStationList panel={panel} status={status} />;
    case "bands":
      return <RadioBandPicker panel={panel} status={status} />;
    default:
      return <RadioDialView panel={panel} status={status} />;
  }
}

/** Milestone 4 replaces this with the music screen. */
function SoonScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t } = panel;
  return (
    <FullModal label={t("music.title")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("music.title")}</h1>
        <p>{t("media.amp")}</p>
      </header>
      <div className="soon-block">
        <ListMusic size={120} strokeWidth={1.1} />
        <strong>{t("soon.title")}</strong>
        <p>{t("soon.music")}</p>
      </div>
    </FullModal>
  );
}

export function MediaModal({ panel, status }: { panel: MediaPanel; status: string }) {
  switch (panel.screen) {
    case "now":
      return <AmpView panel={panel} status={status} />;
    case "source":
      return <SourceList panel={panel} status={status} />;
    case "tv":
      return <TvModal panel={panel} status={status} />;
    case "radio":
      return <RadioScreen panel={panel} status={status} />;
    case "music":
      return <SoonScreen panel={panel} status={status} />;
    default:
      return null;
  }
}
