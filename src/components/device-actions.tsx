import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';

export type DeviceAction = {
  label: string;
  icon: ComponentType<{ size?: number }>;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
};

export function DeviceActions({ actions }: { actions: DeviceAction[] }) {
  return <footer className="device-actions" aria-label="Physical button actions">
    {actions.map(({ label, icon: Icon, onClick, pressed, disabled }) =>
      <Button key={label} variant="eink" onClick={onClick} aria-pressed={pressed} disabled={disabled}>
        <Icon size={30} /><span>{label}</span>
      </Button>)}
  </footer>;
}
