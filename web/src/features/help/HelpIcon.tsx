/** The help launcher's question mark: the same drawing as admin's Icon "help" (24x24, 1.8 px stroke, like ds.tsx Icon). */
export function HelpIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="icon" data-icon="help" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2-2.4 3.5M12 17h.01" />
    </svg>
  );
}
