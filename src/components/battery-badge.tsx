import { Battery, BatteryCharging, BatteryLow, MoonStar } from "lucide-react";
import type { KindleBattery, KindleSleep } from "@/lib/battery";
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

/**
 * Kindle sleep cycle on the screensaver: "sleeping · next HH:MM". The time label is formatted by the
 * bridge in the owner's time zone (the browser's clock is UTC). Shown only while a sleep is in progress.
 */
export function SleepBadge({ sleep }: { sleep: KindleSleep }) {
  const t = useT();
  return (
    <span className="sleep-badge" data-night={sleep.night} role="status">
      <MoonStar size={26} strokeWidth={1.75} />
      {t("sleep.badge", { time: sleep.label })}
    </span>
  );
}
