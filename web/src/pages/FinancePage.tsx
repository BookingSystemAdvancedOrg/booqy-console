import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BarLineChart, HBarChart, LineChart } from "../components/charts";
import { Card, ErrorNotice, Modal, Notice, Printing, Status, fmtDate, useAction, useLoad } from "../components/ui";
import {
  PRESETS, Preset, SortKey, addDays, bucketSeries, daysBetween, fmtDay, fmtInt, fmtPct, fmtSek, grainFor, isoDay,
  matchesCustomer, presetRange, sortRows, topAndBottom,
} from "../finance";
import type { FinanceTenantRow, TenantSummary } from "../types";

const BILLING_TEXT: Record<string, string> = {
  none: "No subscription", active: "Subscribed", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid",
  paused: "Paused", canceled: "Cancelled", incomplete: "Incomplete", incomplete_expired: "Expired", unknown: "Unknown",
};

export default function FinancePage() {
  const [preset, setPreset] = useState<Preset>("month");
  const [range, setRange] = useState(() => presetRange("month"));
  const [includeInactive, setIncludeInactive] = useState(false);
  const [customer, setCustomer] = useState<TenantSummary | null>(null);
  const [needle, setNeedle] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "marginSek", dir: "desc" });
  const [rebuild, setRebuild] = useState(false);
  const tenants = useLoad(() => api.tenants());
  const { data, error, loading, reload } = useLoad(
    () => api.financeOverview({ ...range, includeInactive, tenantId: customer?.tenantId ?? null }),
    [range.from, range.to, includeInactive, customer?.tenantId],
  );
  const sync = useAction();

  function pick(p: Preset) {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  }

  const days = daysBetween(range.from, range.to);
  const grain = grainFor(days);
  const buckets = useMemo(() => bucketSeries(data?.series ?? [], grain), [data, grain]);
  const rows = useMemo(() => sortRows(data?.tenants ?? [], sort.key, sort.dir), [data, sort]);
  const { top, bottom } = useMemo(() => topAndBottom(data?.tenants ?? [], 5), [data]);
  const suggestions = useMemo(
    () => (tenants.data ?? []).filter((t) => matchesCustomer(t, needle)).slice(0, 8),
    [tenants.data, needle],
  );
  const k = data?.kpis;
  const empty = !!data && data.tenants.length === 0 && data.series.length === 0;
  const noFigures = !!data && !empty && data.series.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Finance</h1>
          <p className="muted">
            {data?.asOf ? `Figures as of ${fmtDate(data.asOf)}. ` : "No nightly figures yet. "}
            Revenue and cost in SEK excluding VAT.
          </p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => reload()}>Refresh</button>
          <button className="btn btn--ghost" disabled={sync.busy}
                  onClick={async () => { if (await sync.run(() => api.financeStripeSync())) void reload(); }}>
            {sync.busy ? "Reading Stripe…" : "Import from Stripe"}
          </button>
          <button className="btn btn--primary" onClick={() => setRebuild(true)}>Rebuild</button>
        </div>
      </div>

      <div className="toolbar finance-toolbar">
        <div className="chips" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.id} className={`chip${preset === p.id ? " chip--on" : ""}`} onClick={() => pick(p.id)}>{p.label}</button>
          ))}
        </div>
        <div className="range">
          <label className="range__field">
            <span>From</span>
            <input className="input" type="date" value={range.from} max={range.to}
                   onChange={(e) => { setPreset("custom"); if (e.target.value) setRange({ ...range, from: e.target.value }); }} />
          </label>
          <label className="range__field">
            <span>To</span>
            <input className="input" type="date" value={range.to} min={range.from} max={isoDay(new Date())}
                   onChange={(e) => { setPreset("custom"); if (e.target.value) setRange({ ...range, to: e.target.value }); }} />
          </label>
        </div>
        <label className="switch">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          <span>Include inactive customers</span>
        </label>
        <div className="customer-filter">
          {customer ? (
            <span className="chip chip--on chip--customer">
              {customer.name}
              <button className="chip__x" aria-label="Show all customers" onClick={() => setCustomer(null)}>✕</button>
            </span>
          ) : (
            <>
              <input className="input search" placeholder="Customer: name, org. number or slug…" value={needle}
                     aria-label="Filter by customer" onChange={(e) => setNeedle(e.target.value)} />
              {needle.trim() && (
                <ul className="suggestions" role="listbox">
                  {suggestions.map((t) => (
                    <li key={t.tenantId}>
                      <button role="option" aria-selected={false} onClick={() => { setCustomer(t); setNeedle(""); }}>
                        <strong>{t.name}</strong> <span className="muted mono small">{t.slug}</span> <Status value={t.status} />
                      </button>
                    </li>
                  ))}
                  {suggestions.length === 0 && <li className="muted small suggestions__none">No customer matches.</li>}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <ErrorNotice error={error ?? sync.error} />
      {sync.error === null && sync.busy === false && null}
      {data?.job?.warnings?.length ? (
        <Notice kind="warn">
          <strong>The nightly job reported problems:</strong>
          <ul className="plain-list">{data.job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      ) : null}
      {data && (data.attention.pastDue.length > 0 || data.attention.noSubscription.length > 0) && (
        <Notice kind="info">
          <strong>Needs attention.</strong>
          <ul className="plain-list">
            {data.attention.pastDue.map((p) => (
              <li key={p.tenantId}>
                <Link to={`/tenants/${p.tenantId}?tab=billing`}>{p.name}</Link> is past due since {fmtDay(p.since)}
                {p.status === "suspended" ? " (suspended)" : ""}.
              </li>
            ))}
            {data.attention.noSubscription.map((p) => (
              <li key={p.tenantId}>
                <Link to={`/tenants/${p.tenantId}?tab=billing`}>{p.name}</Link> is active without a subscription
                {p.createdAt ? ` (customer since ${fmtDay(p.createdAt)})` : ""}.
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {loading && !data ? <Printing label="Adding up" /> : data && k && (
        <>
          {empty && (
            <Card title="Nothing to add up yet">
              <p>
                {customer || includeInactive ? "No figures for this selection." : "No active customers yet."} The figures
                come from the nightly job (Cost Explorer plus each customer's usage) and from Stripe when invoices are
                created and paid. Rebuild recomputes a date range once Cost Explorer is enabled in the AWS account.
              </p>
            </Card>
          )}
          {noFigures && (
            <Notice kind="info">
              No day rows in this period yet. The nightly job writes yesterday's figures every morning; use Rebuild for
              older days (requests can be counted for the last 30 days, the logs' retention).
            </Notice>
          )}

          <section className="kpis" aria-label="Key figures">
            <Kpi label="MRR" value={fmtSek(k.mrrSek)} sub={`${fmtInt(k.payingCustomers)} paying customers`} />
            <Kpi label="Revenue" value={fmtSek(k.revenueSek)} sub={`${fmtSek(k.collectedSek)} collected`} />
            <Kpi label="Outstanding" value={fmtSek(k.outstandingSek)} sub="open invoices, ex VAT" tone={k.outstandingSek > 0 ? "warn" : undefined} />
            <Kpi label="AWS cost" value={fmtSek(k.costSek)} sub={`${fmtInt(k.requests)} requests`} />
            <Kpi label="Gross margin" value={fmtSek(k.marginSek)} sub={k.marginPct === null ? "no revenue in the period" : `${fmtPct(k.marginPct)} of revenue`}
                 tone={k.marginSek < 0 ? "bad" : "good"} />
            <Kpi label="Customers" value={fmtInt(k.customers)} sub={`${fmtInt(k.newCustomers)} new, ${fmtInt(k.churnedCustomers)} churned${k.churnPct !== null ? ` (${fmtPct(k.churnPct)})` : ""}`} />
            <Kpi label="ARPU" value={fmtSek(k.arpuSek)} sub="MRR per paying customer" />
            <Kpi label="Cost per booking" value={fmtSek(k.costPerBookingSek, { decimals: true })} sub={`${fmtInt(k.bookings)} bookings`} />
            <Kpi label="Cost per order" value={fmtSek(k.costPerOrderSek, { decimals: true })} sub={`${fmtInt(k.orders)} orders`} />
          </section>

          <div className="charts">
            <Card title={`Revenue and AWS cost per ${grain}`}>
              <BarLineChart points={buckets.map((b) => ({ key: b.key, bar: b.revenue, line: b.cost }))}
                            barLabel="Revenue" lineLabel="AWS cost" ariaLabel={`Revenue and AWS cost per ${grain}`} />
            </Card>
            <Card title="MRR">
              <LineChart points={buckets.map((b) => ({ key: b.key, value: b.mrr }))} label="MRR" ariaLabel="Monthly recurring revenue over time" />
            </Card>
          </div>

          {data.tenants.length > 1 && (
            <div className="charts">
              <Card title="Best margin">
                <HBarChart rows={top.map((t) => ({ key: t.tenantId, label: t.name, value: t.marginSek }))} ariaLabel="Customers with the best margin" />
              </Card>
              {bottom.length > 0 && (
                <Card title="Weakest margin">
                  <HBarChart rows={bottom.map((t) => ({ key: t.tenantId, label: t.name, value: t.marginSek }))} ariaLabel="Customers with the weakest margin" />
                </Card>
              )}
            </div>
          )}

          <div className="table-wrap">
            <table className="table finance-table">
              <thead>
                <tr>
                  <Th k="name" sort={sort} setSort={setSort}>Customer</Th>
                  <th>Subscription</th>
                  <Th k="mrrSek" sort={sort} setSort={setSort}>MRR</Th>
                  <Th k="revenueSek" sort={sort} setSort={setSort}>Revenue</Th>
                  <Th k="collectedSek" sort={sort} setSort={setSort}>Collected</Th>
                  <Th k="outstandingSek" sort={sort} setSort={setSort}>Outstanding</Th>
                  <Th k="costSek" sort={sort} setSort={setSort}>AWS cost</Th>
                  <Th k="marginSek" sort={sort} setSort={setSort}>Margin</Th>
                  <Th k="bookings" sort={sort} setSort={setSort}>Bookings</Th>
                  <Th k="orders" sort={sort} setSort={setSort}>Orders</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => <TenantRow key={t.tenantId} t={t} />)}
                {rows.length === 0 && <tr><td colSpan={10} className="empty">No customers in this selection.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rebuild && <RebuildModal range={range} onClose={() => setRebuild(false)} onStarted={() => { setRebuild(false); }} />}
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ""}`}>
      <span className="kpi__label">{label}</span>
      <strong className="kpi__value">{value}</strong>
      {sub && <span className="kpi__sub">{sub}</span>}
    </div>
  );
}

function Th({ k, sort, setSort, children }: {
  k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; setSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void; children: string;
}) {
  const on = sort.key === k;
  return (
    <th aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className={`th-sort${on ? " th-sort--on" : ""}`}
              onClick={() => setSort({ key: k, dir: on && sort.dir === "desc" ? "asc" : "desc" })}>
        {children}{on ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}

function TenantRow({ t }: { t: FinanceTenantRow }) {
  return (
    <tr>
      <td>
        <Link to={`/tenants/${t.tenantId}?tab=billing`} className="strong">{t.name}</Link>
        <div className="muted small mono">{t.orgNumber ?? t.slug}{t.status !== "active" ? " · " : ""}{t.status !== "active" && <Status value={t.status} />}</div>
      </td>
      <td><span className={`status status--billing-${t.billingStatus}`}>{BILLING_TEXT[t.billingStatus] ?? t.billingStatus}</span></td>
      <td className="num">{fmtSek(t.mrrSek)}</td>
      <td className="num">{fmtSek(t.revenueSek)}</td>
      <td className="num">{fmtSek(t.collectedSek)}</td>
      <td className={`num${t.outstandingSek > 0 ? " warn" : ""}`}>{fmtSek(t.outstandingSek)}</td>
      <td className="num">{fmtSek(t.costSek)}</td>
      <td className={`num${t.marginSek < 0 ? " bad" : ""}`}>
        {fmtSek(t.marginSek)}<div className="muted small">{t.marginPct === null ? "-" : fmtPct(t.marginPct)}</div>
      </td>
      <td className="num">{fmtInt(t.bookings)}</td>
      <td className="num">{fmtInt(t.orders)}</td>
    </tr>
  );
}

function RebuildModal({ range, onClose, onStarted }: { range: { from: string; to: string }; onClose: () => void; onStarted: () => void }) {
  const yesterday = addDays(isoDay(new Date()), -1);
  const [from, setFrom] = useState(range.from < yesterday ? range.from : addDays(yesterday, -6));
  const [to, setTo] = useState(range.to < yesterday ? range.to : yesterday);
  const a = useAction();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (done) { const id = window.setTimeout(onStarted, 2500); return () => window.clearTimeout(id); } }, [done, onStarted]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await a.run(() => api.financeRebuild(from, to));
    if (r) setDone(`${r.from} to ${r.to}`);
  }
  return (
    <Modal title="Rebuild figures" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          Recomputes the AWS cost, usage and allocation for a date range (up to 92 days, yesterday at the latest).
          Use it after changing the exchange rate or the cost allocation, or when a night was missed. The run takes a
          few minutes; refresh the page afterwards. Request counts exist for the last 30 days only (log retention).
        </p>
        <div className="range">
          <label className="range__field"><span>From</span><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="range__field"><span>To</span><input className="input" type="date" value={to} min={from} max={yesterday} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <ErrorNotice error={a.error} />
        {done && <Notice kind="ok">Rebuild started for {done}.</Notice>}
        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={a.busy || !!done}>{a.busy ? "Starting…" : "Start rebuild"}</button>
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </Modal>
  );
}
