import type { CSSProperties, ReactNode } from "react";

/**
 * While a page fetches its data: the page is already in place, built from
 * the same cards, tiles and tables as the real one, with blurry glass blocks
 * where text, numbers and rows will land and a slow glass sheen over the
 * cards. When the data arrives it lands where the operator already sees the
 * boxes. Each page assembles its own skeleton from these parts, with its own
 * layout classes, so nothing jumps. Same look as Booqy Admin. Reduced
 * motion: the blocks hold still. Styles: "Skeletons" in styles.css.
 */

type Size = number | string;

/** One blurry glass block. */
export function SkelBlock({ w = "100%", h = 14, round, className = "", style }: {
  w?: Size; h?: Size; round?: boolean; className?: string; style?: CSSProperties;
}) {
  return <span className={`skel-block${round ? " skel-round" : ""}${className ? ` ${className}` : ""}`} style={{ width: w, height: h, ...style }} />;
}

/** The sheen that sweeps across a card. */
function Sheen() {
  return <i className="skel-sheen" aria-hidden="true" />;
}

/** Outermost: tells screen readers the page is loading. */
export function SkelPage({ label, children }: { label: string; children: ReactNode }) {
  return <div className="skel" role="status" aria-label={label} aria-busy="true">{children}</div>;
}

const LINE_WIDTHS = ["94%", "86%", "72%", "90%", "64%", "80%"];

/** Lines of text, like a paragraph. */
export function SkelLines({ n = 3 }: { n?: number }) {
  return <div className="skel-lines">{Array.from({ length: n }, (_, i) => <SkelBlock key={i} w={LINE_WIDTHS[i % LINE_WIDTHS.length]} />)}</div>;
}

/** List rows: one wide column and a few narrow ones. */
export function SkelRows({ n = 4, cols = 3 }: { n?: number; cols?: number }) {
  return (
    <div className="skel-rows">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel-row">
          <SkelBlock w="38%" />
          {Array.from({ length: cols - 1 }, (_, j) => <SkelBlock key={j} w="14%" />)}
        </div>
      ))}
    </div>
  );
}

const BARS = [18, 30, 22, 46, 34, 58, 40, 70, 52, 38, 64, 48, 80, 56, 36, 44, 28, 62, 50, 34];

/** A bar chart. */
export function SkelChart({ height = 200 }: { height?: number }) {
  return (
    <div className="skel-chart" style={{ height }}>
      {BARS.map((h, i) => <SkelBlock key={i} className="skel-bar" h={`${h}%`} style={{ animationDelay: `${i * 40}ms` }} />)}
    </div>
  );
}

/** A card (the same .card as the real ones) with a title and rows, lines or a chart. */
export function SkelCard({ rows = 4, cols = 3, lines, chart, children }: {
  rows?: number; cols?: number; lines?: number; chart?: boolean; children?: ReactNode;
}) {
  return (
    <section className="card skel-card" aria-hidden="true">
      <Sheen />
      <header className="card__head"><SkelBlock w={170} h={16} /></header>
      <div className="card__body">
        {children ?? (chart ? <SkelChart /> : lines ? <SkelLines n={lines} /> : <SkelRows n={rows} cols={cols} />)}
      </div>
    </section>
  );
}

/** Number tiles in the page's own grid (.kpis, .kpis--lead, .kpis--units, .kpis--row). */
export function SkelKpis({ n = 4, className = "" }: { n?: number; className?: string }) {
  return (
    <section className={`kpis${className ? ` ${className}` : ""}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="kpi skel-card">
          <Sheen />
          <SkelBlock w="46%" h={12} />
          <SkelBlock w="40%" h={32} style={{ borderRadius: 'var(--r-md)' }} />
          <SkelBlock w="70%" h={12} />
        </div>
      ))}
    </section>
  );
}

const CELL_WIDTHS = ["70%", "55%", "40%", "62%", "48%", "58%"];

/** A whole table card: header row and body rows, like .table-wrap > .table. */
export function SkelTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="table-wrap skel-card" aria-hidden="true">
      <Sheen />
      <table className="table">
        <thead><tr>{Array.from({ length: cols }, (_, j) => <th key={j}><SkelBlock w="50%" h={11} /></th>)}</tr></thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>{Array.from({ length: cols }, (_, j) => <td key={j}><SkelBlock w={CELL_WIDTHS[(i + j) % CELL_WIDTHS.length]} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The whole console while sign-in is checked: the menu and a page of tiles and a table. */
export function SkelShell({ label }: { label: string }) {
  return (
    <div className="app" role="status" aria-label={label} aria-busy="true">
      <header className="topbar skel-topbar" aria-hidden="true">
        <SkelBlock w={130} h={26} />
        <nav className="topbar__nav">
          {[70, 82, 74, 0, 66, 50, 0, 62, 70].map((w, i) => (w ? <SkelBlock key={i} className="skel-nav" w={`${w}%`} h={14} /> : <SkelBlock key={i} className="skel-nav-head" w="40%" h={11} />))}
        </nav>
      </header>
      <main className="main">
        <div className="skel">
          <SkelBlock w={220} h={34} />
          <SkelKpis className="kpis--lead" />
          <SkelTable rows={6} cols={5} />
        </div>
      </main>
    </div>
  );
}
