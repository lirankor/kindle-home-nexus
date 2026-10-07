import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/lang-context";

export type DeviceAction = {
  label: string;
  icon: ComponentType<{ size?: number }>;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
};

export const SOFT_KEYS = ["F1", "F2", "F3", "F4"] as const;

/** Always four slots, left to right = Kindle buttons F1..F4 (Back, Keyboard, Menu, Home). */
export function DeviceActions({ actions }: { actions: (DeviceAction | null | undefined)[] }) {
  const t = useT();
  // Always laid out left to right: slot 1 sits over the physical Back button, also in RTL languages.
  return (
    <footer className="device-actions" aria-label={t("footer.label")} dir="ltr">
      {SOFT_KEYS.map((key, slot) => {
        const action = actions[slot];
        if (!action)
          return (
            <Button key={key} variant="eink" data-soft-key={key} data-blank="true" disabled>
              <span aria-hidden="true">&nbsp;</span>
            </Button>
          );
        const { label, icon: Icon, onClick, pressed, disabled } = action;
        return (
          <Button
            key={key}
            variant="eink"
            data-soft-key={key}
            onClick={onClick}
            aria-pressed={pressed}
            disabled={disabled}
          >
            <Icon size={34} />
            <span>{label}</span>
          </Button>
        );
      })}
    </footer>
  );
}

/** Runs the action behind a soft key; blank and disabled slots do nothing. */
export function pressSoftKey(actions: (DeviceAction | null | undefined)[], key: string): boolean {
  const slot = SOFT_KEYS.indexOf(key as (typeof SOFT_KEYS)[number]);
  if (slot < 0) return false;
  const action = actions[slot];
  if (action && !action.disabled) action.onClick();
  return true;
}

/** Briefly shows the footer button of a pressed soft key as pressed (an indicator, not a focus change). */
export function flashSoftKey(key: string, ms = 120) {
  const button = document.querySelector<HTMLElement>(`.device-actions [data-soft-key="${key}"]`);
  if (!button || button.hasAttribute("disabled")) return;
  button.setAttribute("data-flash", "true");
  setTimeout(() => button.removeAttribute("data-flash"), ms);
}
