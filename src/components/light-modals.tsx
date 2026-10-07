import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DeviceActions, type DeviceAction } from "@/components/device-actions";
import { COLORS, SHADE_NAMES } from "@/lib/home";
import { useT } from "@/lib/lang-context";
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
  const t = useT();
  const colored = light.color !== "White";
  const look = colored
    ? t("modal.lookColor", { value: t(`color.${light.color as (typeof COLORS)[number]}`) })
    : t("modal.lookShade", { value: t(`shade.${light.shade}`) });
  return (
    <FullModal label={t("modal.light", { name })} actions={actions} status={status}>
      <header className="modal-heading">
        <h1>{name}</h1>
        <p>
          {room} · <strong>{light.on ? t("modal.on") : t("modal.off")}</strong>
        </p>
      </header>
      <div className="big-level" data-on={light.on} dir="ltr">
        {light.level}
        <small>%</small>
      </div>
      <div className="progress-track modal-track" dir="ltr">
        <span style={{ width: `${light.on ? light.level : 0}%` }} />
      </div>
      <p className="modal-look">{look}</p>
      <p className="modal-hint">{t("modal.hint")}</p>
    </FullModal>
  );
}

export type PickerKind = "shade" | "color";
export const pickerValues = (kind: PickerKind): readonly string[] =>
  kind === "shade" ? SHADE_NAMES : COLORS;

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
  const t = useT();
  const title = kind === "shade" ? t("modal.shadeTitle") : t("modal.colorTitle");
  return (
    <FullModal
      label={t("modal.pickerLabel", { title, name: lightName })}
      actions={actions}
      status={status}
    >
      <header className="modal-heading">
        <h1>{title}</h1>
        <p>{lightName}</p>
      </header>
      <div className="picker-grid" data-kind={kind}>
        {pickerValues(kind).map((value, index) => (
          <Button
            key={value}
            variant="eink"
            aria-pressed={index === cursor}
            onClick={() => onPick(index)}
          >
            {kind === "shade" && <span className={`shade-swatch shade-${value.toLowerCase()}`} />}
            <span>{t(`${kind}.${value}` as `shade.Warm`)}</span>
          </Button>
        ))}
      </div>
    </FullModal>
  );
}
