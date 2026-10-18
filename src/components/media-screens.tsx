// Media tab cards, the full-page amp view (volume on the 5-way, power-on routine), the source list,
// the TV modal, the radio screen (dial bar, station list, band picker) and the music screen (Jellyfin
// lists in tabs, Enter plays). State and keys live in `useMediaPanel` (src/lib/media-panel.ts).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Boxes,
  Cable,
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
  Speaker,
  Square,
  Sun,
  Tv,
  Volume1,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeviceRow } from "@/components/device-row";
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
  albumDateLabel,
  displayDb,
  formatDb,
  musicItemDetail,
  musicItemTitle,
  ampNode,
  inputLabel,
  nodeLabel,
  powerOnStepKey,
} from "@/lib/media-ui";
import { nodeIcon, optionalIcon, pickIcon } from "@/lib/icons";
import { QUEUE_PAGE_SIZE, RADIO_PAGE_SIZE } from "@/lib/media-panel";
import type { MediaPanel } from "@/lib/media-panel";
import {
  FAVOURITES_BAND,
  bandLabel,
  isFmBand,
  listById,
  radioBands,
  stationDetail,
} from "@/lib/radio-dial";

const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr">{children}</bdi>;
const POWER_ON_STEPS: PowerOnStep[] = ["plug", "wait", "reload", "turn_on", "source"];
/** Glyphs of the inputs with a meaning for the panel; any other input (CD, LINE1, OPTICAL, …) is a plain input. */
const SOURCE_ICONS: Record<string, typeof Radio> = {
  SERVER: Server,
  PHONO: Disc3,
  "NET RADIO": Radio,
  TUNER: RadioTower,
};
const sourceIcon = (source: AmpSource) => SOURCE_ICONS[source] ?? Cable;
/** Input rows that fit above the footer with the hint line (74 px each); the window follows the cursor. */
const SOURCE_ROWS_SHOWN = 5;
const sourceWindow = <T,>(rows: T[], cursor: number): T[] => {
  const first = Math.max(
    0,
    Math.min(cursor - (SOURCE_ROWS_SHOWN - 1), rows.length - SOURCE_ROWS_SHOWN),
  );
  return rows.slice(first, first + SOURCE_ROWS_SHOWN);
};
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const stateLabel = (lang: Lang, state: string | undefined) =>
  state === undefined ? "—" : (tryT(lang, `state.${state}`) ?? state);
/** An input's name: its node's row name, else the receiver's own title (bus task 015). */
const sourceLabel = (panel: MediaPanel, source: AmpSource | null) => panel.sourceName(source);

/** Headline / sub lines for what the amp is doing, by kind. */
function nowPlayingLines(panel: MediaPanel, s: MediaSnapshot | null): [string, string, string] {
  const { t } = panel;
  if (!s) return ["—", "", ""];
  // Unknown (nothing answers) reads as off too, with the reason on the third line.
  if (!s.amp.on)
    return [
      t("amp.off"),
      // music through HA: no power key, playing wakes the output's receiver (task 015)
      t(s.output ? "amp.offHintPlay" : "amp.offHint"),
      s.amp.available ? "" : s.plugOn ? t("amp.noAnswer") : t("amp.unavailable"),
    ];
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
    case "input":
      return [
        sourceLabel(panel, s.amp.source),
        tryT(panel.lang, `source.${s.amp.source}.detail`) ?? "",
        "",
      ];
    case "phono":
      return [sourceLabel(panel, s.amp.source), t("source.PHONO.detail"), ""];
    default:
      return [t("amp.nothing"), "", ""];
  }
}

/** The music screen's output line (bus task 021): a move under way, a failed move, or, while the chosen output is
 *  quiet, which other output plays ("R-N500 AirPlay is playing · F3 to switch"). Null = nothing to say. */
function outputHint(panel: MediaPanel, s: MediaSnapshot | null): string | null {
  const o = s?.output;
  if (!o) return null;
  if (o.moving)
    return o.moving.failed
      ? panel.t("output.moveFailed", { name: o.moving.name })
      : panel.t("output.moving", { name: o.moving.name });
  if (o.playingElsewhere) return panel.t("output.elsewhere", { name: o.playingElsewhere.name });
  return null;
}

/** One-liner for the amp card: "1LIVE · Zara Larsson - Memory Lane". */
function nowPlayingLine(panel: MediaPanel, s: MediaSnapshot): string {
  if (!s.amp.on) return "";
  const [a, b] = nowPlayingLines(panel, s);
  return [a, b].filter(Boolean).join(" · ");
}

/** The Media tab (bus task 014): the music card (Music Assistant, its output and what plays) above one row per
 *  configured device node. Enter on a row opens that node's controls; the F-keys follow media.keys. */
export function MediaCards({ panel }: { panel: MediaPanel }) {
  const { t, lang, data: s } = panel;
  // While the power-on routine runs (or just failed) the card follows it: state line = the routine,
  // body = the current step or the error. Unknown (nothing answers) reads as off.
  const routine = panel.showPowerOn ? panel.powerOn : null;
  const out = s?.output ?? null;
  const ampLine = routine
    ? t(routine.step === "failed" ? "poweron.failed" : "poweron.title")
    : out
      ? out.entity && out.valid
        ? t("media.outputOn", { name: out.name ?? out.entity })
        : t("output.none")
      : s
        ? `${s.amp.on ? t("state.on") : t("state.off")}${
            s.amp.on && s.amp.source ? ` · ${sourceLabel(panel, s.amp.source)}` : ""
          }`
        : "—";
  const playing = routine
    ? routine.step === "failed"
      ? (routine.error ?? t("poweron.failed"))
      : t(powerOnStepKey(routine.step))
    : s
      ? nowPlayingLine(panel, s)
      : "";
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
          className="media-card media-card-amp"
          data-on={s?.amp.on ?? false}
          title={t("media.openMusic")}
          onClick={() => panel.openAmp()}
        >
          <span className="media-card-heading">
            <span className={`device-icon ${s?.amp.on ? "on" : ""}`}>
              <Music2 size={34} />
            </span>
            <span className="device-info">
              <strong>{t("media.music")}</strong>
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
        <div className="media-nodes">
          {panel.nodes.map((n) => {
            const name = nodeLabel(lang, n.name);
            const line = !n.available
              ? t("state.unavailable")
              : `${n.on ? t("state.on") : t("state.off")}${n.on && n.source ? ` · ${inputLabel(lang, n, n.source)}` : ""}`;
            return (
              <DeviceRow
                key={n.id}
                icon={nodeIcon(n)}
                name={name}
                on={n.on}
                state={line}
                reading={
                  n.on && n.volumeDb !== null ? (
                    <Ltr>
                      {formatDb(n.volumeDb)} <small>dB</small>
                    </Ltr>
                  ) : undefined
                }
                title={t("media.openNode", { name })}
                onClick={() => panel.openNode(n.id)}
              />
            );
          })}
          {s && panel.nodes.length === 0 && <p className="modal-hint">{t("media.noNodes")}</p>}
        </div>
      </div>
    </>
  );
}

/** A node's controls (receiver: on/off, volume, input, stream output; TV: on/off, volume, input, movie mode). */
function NodeScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, lang, node: n } = panel;
  if (!n) return null;
  const Icon = nodeIcon(n);
  return (
    <FullModal label={t("node.label")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{nodeLabel(lang, n.name)}</h1>
        <p>
          <strong>
            {n.available ? (n.on ? t("state.on") : t("state.off")) : t("state.unavailable")}
          </strong>
        </p>
      </header>
      <div className="tv-glyph" data-on={n.on}>
        <Icon size={120} strokeWidth={1.1} />
      </div>
      <p className="modal-look">
        {n.on
          ? `${t("media.source")} · ${n.source ? panel.nodeSourceName(n.source) : t("node.noSource")}`
          : "\u00a0"}
      </p>
      {n.on && n.source === "NET RADIO" && (n.nowTitle || n.station) && (
        // the receiver's own NET RADIO: station and song as the bridge reports them
        <p className="modal-look node-now">
          {n.nowArtist && n.nowTitle
            ? `${n.nowArtist} · ${n.nowTitle}`
            : (n.nowTitle ?? n.station?.split(" · ").pop())}
        </p>
      )}
      <p className="modal-look node-volume">
        {n.on && n.volumeDb !== null ? (
          <>
            {t("media.volume")} <Ltr>{formatDb(n.volumeDb)} dB</Ltr>
          </>
        ) : n.on && n.volume !== null ? (
          `${t("media.volume")} ${Math.round(n.volume * 100)}%`
        ) : (
          "\u00a0"
        )}
      </p>
      <p className="modal-hint">{t("node.hint")}</p>
    </FullModal>
  );
}

/** A node's inputs (its media_player's source list): up / down, Enter selects. */
function NodeSourceList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, lang, node: n, cursor } = panel;
  if (!n) return null;
  return (
    <FullModal label={t("source.title")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("source.title")}</h1>
        <p>{nodeLabel(lang, n.name)}</p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("source.title")}>
        {sourceWindow(n.sources, cursor).map((src) => {
          const index = n.sources.indexOf(src);
          const current = n.on && n.source === src;
          // an input row's icon (bus task 019); none set: no icon, as before
          const Icon = optionalIcon(n.inputIcons?.[src]);
          return (
            <Button
              key={src}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={current}
              onClick={() => panel.setCursor(index)}
            >
              {Icon && (
                <span className="source-row-icon">
                  <Icon size={30} strokeWidth={1.6} />
                </span>
              )}
              <span className="source-row-text">
                <strong>{panel.nodeSourceName(src)}</strong>
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

/** A receiver's NET RADIO stations (the bridge's station select, in its list order): up / down, Enter plays (the
 *  bridge turns the receiver on, selects NET RADIO and walks its menu), Back returns. Dial style: the FM frequency
 *  where the list has one, else the group. */
function NodeStationList({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, lang, node: n, cursor } = panel;
  if (!n) return null;
  const stations = n.stations ?? [];
  return (
    <FullModal label={t("node.stations")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("node.stations")}</h1>
        <p>{nodeLabel(lang, n.name)}</p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("node.stations")}>
        {sourceWindow(stations, cursor).map((st) => {
          const index = stations.indexOf(st);
          const current = n.on && n.source === "NET RADIO" && n.station === st.option;
          return (
            <Button
              key={st.option}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={current}
              onClick={() => panel.setCursor(index)}
            >
              <span className="source-row-text">
                <strong>{st.name}</strong>
                <small>{st.fm !== null ? <Ltr>{`FM ${st.fm.toFixed(1)}`}</Ltr> : st.group}</small>
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

/** The music output picker: every Music Assistant player / MA group in HA, single select. Up / down + Enter choose,
 *  Back closes with no change; F1..F4 (the legend row) are the configured quick outputs. */
function OutputPicker({ panel, status }: { panel: MediaPanel; status: string }) {
  const { t, output, outputRows, cursor } = panel;
  const first = Math.max(0, Math.min(cursor - 3, outputRows.length - 7));
  return (
    <FullModal label={t("output.title")} actions={panel.modalActions} status={status}>
      <header className="modal-heading">
        <h1>{t("output.title")}</h1>
        <p>
          {output?.moving
            ? outputHint(panel, panel.data)
            : output?.entity && output.valid
              ? (output.name ?? output.entity)
              : t("output.none")}
        </p>
      </header>
      <div className="source-rows" role="listbox" aria-label={t("output.title")}>
        {outputRows.slice(first, first + 7).map((o, i) => {
          const index = first + i;
          const current = o.entity_id === output?.entity;
          const OutputIcon = pickIcon(
            null,
            panel.data?.icons?.[o.entity_id],
            o.kind === "group" ? Boxes : Speaker,
          );
          // one line: state (+ group), then what it plays, or why it cannot be chosen
          const detail = [
            current ? t("output.current") : null,
            stateLabel(panel.lang, o.state),
            o.kind === "group" ? t("output.group") : null,
            o.exposed === false ? t("output.notInHa") : (o.now ?? null),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Button
              key={o.entity_id}
              variant="eink"
              className="source-row"
              role="option"
              aria-selected={index === cursor}
              aria-pressed={index === cursor}
              data-current={current}
              data-exposed={o.exposed === false ? "false" : undefined}
              onClick={() => panel.chooseOutput(o.entity_id)}
            >
              <span className="source-row-icon">
                <OutputIcon size={30} strokeWidth={1.6} />
              </span>
              <span className="source-row-text">
                <strong>{o.name}</strong>
                <span>{detail}</span>
              </span>
              {current && <Check size={28} strokeWidth={2.5} aria-hidden="true" />}
            </Button>
          );
        })}
        {outputRows.length === 0 && <p className="modal-hint">{t("output.empty")}</p>}
      </div>
      <p className="modal-hint">{t("output.hint")}</p>
    </FullModal>
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
  const [line1, line2, line3plain] = nowPlayingLines(panel, s);
  // the third line tells about the other outputs (moving / another output plays) when there is something to say
  const hint = outputHint(panel, s);
  const line3 = hint ?? line3plain;
  const on = s?.amp.on ?? false;
  const art = on && s?.nowPlaying.artItemId ? s.nowPlaying.artItemId : null;
  const Glyph = on && s?.amp.source ? sourceIcon(s.amp.source) : Power;
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
              <span className="amp-sub amp-sub2" data-hint={hint ? "true" : undefined}>
                {line3 || " "}
              </span>
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
                {queue.status === "paused"
                  ? ` · ${queue.stall ? t("queue.stalled") : t("act.pause")}`
                  : ""}
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
            sourceTitle={s?.output ? t("media.output") : t("media.source")}
            source={
              s?.output
                ? (s.output.name ?? s.output.entity ?? "—")
                : sourceLabel(panel, s?.amp.source ?? null)
            }
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
        {sourceWindow(panel.sourceRows, cursor).map((source) => {
          const index = panel.sourceRows.indexOf(source);
          const Icon = optionalIcon(ampNode(s)?.inputIcons?.[source]) ?? sourceIcon(source);
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
                <strong>{sourceLabel(panel, source)}</strong>
                <span>{tryT(panel.lang, `source.${source}.detail`) ?? "\u00a0"}</span>
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

/** Station art from the image route (grayscale PNG: the logo, else a generated cover); a glyph when there is none (404). */
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
  const show = !!id && !id.startsWith("yt:") && failed !== id;
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
  const { t, lang, data: s, dialPos, dialStation, radioLists } = panel;
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
              bandName={bandLabel(lang, dialPos.list, radioLists)}
              stations={list?.stations ?? []}
              list={dialPos.list}
              fmBand={isFmBand(radioLists, dialPos.list)}
              index={dialPos.index}
              emptyText={
                loading
                  ? ""
                  : dialPos.list === FAVOURITES_BAND
                    ? t("radio.noFavourites")
                    : t("radio.empty")
              }
            />
            {panel.dialNotice ? (
              <p className="radio-error" role="status">
                {panel.dialNotice}
              </p>
            ) : (
              panel.radioListsError && <p className="radio-error">{panel.radioListsError}</p>
            )}
            <div className="radio-transport-row" data-on={on}>
              <TransportControl
                db={db}
                label={t("media.volume")}
                sourceTitle={t("media.source")}
                source={sourceLabel(panel, s?.amp.source ?? null)}
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
  const { t, lang, dialPos, radioLists, cursor } = panel;
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
        <h1>{bandLabel(lang, dialPos.list, radioLists)}</h1>
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
            {dialPos.list === FAVOURITES_BAND ? t("radio.noFavourites") : t("radio.empty")}
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
  const { t, lang, dialPos, radioLists, cursor } = panel;
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
        {radioBands(radioLists).map((band, index) => {
          const n = listById(radioLists, band)?.stations.length ?? 0;
          const Icon = band === FAVOURITES_BAND ? Heart : Radio;
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
                <strong>{bandLabel(lang, band, radioLists)}</strong>
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
      albumDateLabel(item, panel.lang),
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
    case "node":
      return <NodeScreen panel={panel} status={status} />;
    case "nodesource":
      return <NodeSourceList panel={panel} status={status} />;
    case "nodestation":
      return <NodeStationList panel={panel} status={status} />;
    case "output":
      return <OutputPicker panel={panel} status={status} />;
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
