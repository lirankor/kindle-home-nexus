export function SpotLightIcon({
  size = 24,
  strokeWidth = 1.5,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h18M12 4v4M9 8l-3 6 8 4 3-6zM5 18l-2 3M10 20l-1 3M16 20v3" />
    </svg>
  );
}

export function StripLightIcon({
  size = 24,
  strokeWidth = 1.5,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="7" width="20" height="7" rx="1" />
      <path d="M6 7v7M10 7v7M14 7v7M18 7v7M5 18v2M12 18v2M19 18v2" />
    </svg>
  );
}
