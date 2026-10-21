/**
 * The icons for light (sun) and dark (moon) mode, in currentColor and one
 * stroke weight. The same drawing as in admin, the customer site and booqy.se.
 */

const ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...ICON}>
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </svg>
  );
}

export function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...ICON}>
      <path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8Z" />
    </svg>
  );
}
