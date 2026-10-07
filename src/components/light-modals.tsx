import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DeviceActions, type DeviceAction } from "@/components/device-actions";
import { COLOR_LABELS, COLORS, SHADE_LABELS, SHADE_NAMES } from "@/lib/home";
import type { LightState } from "@/lib/home";

/** Full 600x800 page with its own soft-key footer; nothing of the main screen shows through. */
function FullModal({
  label,
  actions,
  status,
  children,
}: {
  label: string;
  actions: DeviceAction[];
  status: string;
  children: ReactNode;
}) {
  return (
    <div className="full-modal" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <div className="full-modal-body">{children}</div>
      <div className="demo-status" role="status">
        {status}
      </div>
      <DeviceActions actions={actions} />
    </div>
  );
}

export function LightModal({
  name,
  room,
  light,
  actions,
  status,
}: {
  name: string;
  room: string;
  light: LightState;
  actions: DeviceAction[];
  status: string;
}) {
  const colored = light.color !== "White";
  const look = colored
    ? `Farbe · ${COLOR_LABELS[light.color as (typeof COLORS)[number]] ?? light.color}`
    : `Weißton · ${SHADE_LABELS[light.shade]}`;
  return (
    <FullModal label={`Licht ${name}`} actions={actions} status={status}>
      <header className="modal-heading">
        <h1>{name}</h1>
        <p>
          {room} · <strong>{light.on ? "An" : "Aus"}</strong>
        </p>
      </header>
      <div className="big-level" data-on={light.on}>
        {light.level}
        <small>%</small>
      </div>
      <div className="progress-track modal-track">
        <span style={{ width: `${light.on ? light.level : 0}%` }} />
      </div>
      <p className="modal-look">{look}</p>
      <p className="modal-hint">Pfeiltasten: Helligkeit ± 10</p>
    </FullModal>
  );
}

export type PickerKind = "shade" | "color";
export const pickerOptions = (kind: PickerKind) =>
  kind === "shade"
    ? SHADE_NAMES.map((value) => ({ value, label: SHADE_LABELS[value] }))
    : COLORS.map((value) => ({ value: value as string, label: COLOR_LABELS[value] }));

export function PickerModal({
  kind,
  lightName,
  cursor,
  onPick,
  actions,
  status,
}: {
  kind: PickerKind;
  lightName: string;
  cursor: number;
  onPick: (index: number) => void;
  actions: DeviceAction[];
  status: string;
}) {
  const options = pickerOptions(kind);
  return (
    <FullModal
      label={`${kind === "shade" ? "Weißton" : "Farbe"} für ${lightName}`}
      actions={actions}
      status={status}
    >
      <header className="modal-heading">
        <h1>{kind === "shade" ? "Weißton" : "Farbe"}</h1>
        <p>{lightName}</p>
      </header>
      <div className="picker-grid" data-kind={kind}>
        {options.map(({ value, label }, index) => (
          <Button
            key={value}
            variant="eink"
            aria-pressed={index === cursor}
            onClick={() => onPick(index)}
          >
            {kind === "shade" && <span className={`shade-swatch shade-${value.toLowerCase()}`} />}
            <span>{label}</span>
          </Button>
        ))}
      </div>
    </FullModal>
  );
}
