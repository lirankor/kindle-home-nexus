import { Battery, BatteryCharging, BatteryLow } from "lucide-react";
import type { KindleBattery } from "@/lib/battery";
import { useT } from "@/lib/lang-context";

export const LOW_BATTERY = 15;

/** Kindle battery: icon and percent, or a charging glyph. Below 15 % it is inverted and bold. */
export function BatteryBadge({
  battery,
  variant,
}: {
  battery: KindleBattery;
  variant: "tabs" | "photo";
}) {
  const t = useT();
  const low = battery.level < LOW_BATTERY && !battery.charging;
  const Icon = battery.charging ? BatteryCharging : low ? BatteryLow : Battery;
  return (
    <span
      className={`battery-badge battery-${variant}`}
      data-low={low}
      role="img"
      aria-label={
        battery.charging
          ? t("battery.charging", { n: battery.level })
          : t("battery.label", { n: battery.level })
      }
    >
      <Icon size={variant === "photo" ? 30 : 26} strokeWidth={low ? 2.5 : 1.75} />
      {!battery.charging && <bdi dir="ltr">{battery.level}%</bdi>}
    </span>
  );
}
