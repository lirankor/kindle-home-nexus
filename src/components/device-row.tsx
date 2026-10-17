import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** One row of a device list (Power tab plugs, custom tab toggles): icon (filled when on), name, a state line and an
 *  optional reading on the right. The footer keys of the tab carry the F1..F4 hints. */
export function DeviceRow({
  icon: Icon,
  name,
  on,
  state,
  reading,
  title,
  onClick,
}: {
  icon: ComponentType<{ size?: number }>;
  name: string;
  on: boolean;
  state: ReactNode;
  reading?: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <Button variant="eink" className="power-row" data-on={on} title={title} onClick={onClick}>
      <span className={`device-icon ${on ? "on" : ""}`}>
        <Icon size={32} />
      </span>
      <span className="device-info">
        <strong>{name}</strong>
        <span className="light-state">{state}</span>
      </span>
      {reading !== undefined && <strong className="watt-reading">{reading}</strong>}
    </Button>
  );
}
