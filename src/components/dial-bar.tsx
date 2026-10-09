// The retro dial bar after docs/design/radio-dial-reference.svg for the radio stations: one segmented
// black bar across the content width, a thick rounded needle, a caption above the left end ("AM" /
// "FM" in the reference) and labels above / below the bar. Pure black on white; geometry and label
// planning live in src/lib/radio-dial.ts. (Volume uses the circle knob, not this bar.)
import type { RadioStationView } from "@/lib/media";
import {
  DIAL,
  dialSegments,
  estimateWidth,
  planDialLabels,
  stationLabel,
  stationX,
} from "@/lib/radio-dial";
import type { DialGeometry, DialLabel } from "@/lib/radio-dial";

export function DialBar({
  caption,
  labels,
  stops,
  needleX,
  arrows = false,
  emptyText,
  geometry: g = DIAL,
  ...rest
}: {
  /** Text above the left end of the bar: the band name, or "dB". */
  caption: string;
  labels: DialLabel[];
  /** x positions that get a longer solid block in the bar (stations, volume ticks). */
  stops: number[];
  /** Needle x in viewBox units; null draws no needle. */
  needleX: number | null;
  /** Small "<|>" arrows at the top of the needle: left / right moves it. */
  arrows?: boolean;
  /** Centred above the bar when there is nothing to show (empty favourites). */
  emptyText?: string | undefined;
  geometry?: DialGeometry;
} & Record<`data-${string}`, string | number | undefined>) {
  const arrowY = 10;
  const arrowDx = g.needleW / 2 + 8;
  return (
    <svg
      className="radio-dial"
      viewBox={`0 0 ${g.width} ${g.height}`}
      width={g.width}
      height={g.height}
      role="img"
      aria-label={caption}
      direction="ltr"
      {...rest}
    >
      <text x={4} y={g.aboveY} fontSize={g.namePx} fontWeight={700} textAnchor="start">
        {caption}
      </text>
      {dialSegments(stops, g).map((seg, i) => (
        <rect key={i} x={seg.x} y={g.barY} width={seg.w} height={g.barH} />
      ))}
      {emptyText && (
        <text
          x={g.width / 2}
          y={g.aboveY}
          fontSize={g.currentPx}
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
          y={l.side === "above" ? g.aboveY : g.belowY}
          fontSize={l.current ? g.currentPx : g.labelPx}
          fontWeight={l.current ? 700 : 400}
          textAnchor={l.anchor}
          data-current={l.current || undefined}
        >
          {l.text}
        </text>
      ))}
      {needleX !== null && (
        <>
          <rect
            className="radio-needle"
            x={needleX - g.needleW / 2}
            y={25}
            width={g.needleW}
            height={g.height - 49}
            rx={g.needleW / 2}
          />
          {arrows && (
            <g
              className="radio-needle-arrows"
              fill="none"
              stroke="#000"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={`M${needleX - arrowDx} ${arrowY - 7} l-8 7 8 7`} />
              <path d={`M${needleX + arrowDx} ${arrowY - 7} l8 7 -8 7`} />
            </g>
          )}
        </>
      )}
    </svg>
  );
}

/** A radio band on the dial: stations spread evenly, the needle on the current one. */
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
  return (
    <DialBar
      caption={bandName}
      labels={labels}
      stops={stations.map((_, i) => stationX(i, n))}
      needleX={n > 0 ? stationX(Math.min(index, n - 1), n) : null}
      emptyText={n === 0 ? emptyText : undefined}
      data-list={list}
      data-index={n > 0 ? index : -1}
    />
  );
}
