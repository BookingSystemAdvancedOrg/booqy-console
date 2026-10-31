/** Booqys ordmärke "booqy" (samma teckning som booqy.se och admin), i currentColor. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="52 191 416 180" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={14} strokeLinecap="round">
        <circle cx={104.5} cy={281.5} r={35.5} />
        <circle cx={186} cy={281.5} r={35.5} />
        <circle cx={265.5} cy={281.5} r={35.5} />
        <circle cx={345} cy={281.5} r={35.5} />
        <path d="M66.5 205.5V311.5" />
        <path d="M379 281.5V351" />
        <path d="M387 240 424 315" />
        <path d="M453 238 405 356" />
      </g>
      <g fill="currentColor">
        <path d="M84 280.5A20.5 20.5 0 0 1 125 280.5Z" />
        <rect x={79.5} y={282.5} width={50} height={5} />
      </g>
    </svg>
  )
}

/** b-märket: vitt b på espressobrun botten, för ytor där namnet inte får plats. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="300 115 1400 1400" aria-hidden="true" focusable="false">
      <rect x={300} y={115} width={1400} height={1400} rx={308} fill="#1a120e" />
      <path
        fill="#fff"
        d="M620.5 937.5A379.5 379.5 0 1 1 1379.5 937.5A379.5 379.5 0 1 1 620.5 937.5ZM727 937.5A273 286.5 0 1 0 1273 937.5A273 286.5 0 1 0 727 937.5ZM620 368A55 55 0 0 1 730 368V937.5H620ZM814 937.5A186 163.5 0 0 1 1186 937.5ZM729.2 972H1270.8L1257.2 1029H742.8Z"
      />
    </svg>
  )
}
