import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CtaButton, Disclosure } from "../components/ds";
import { BarLineChart, HBarChart, LineChart } from "../components/charts";
import { CountUp, Delta, deltaPct, useTrendPop } from "../components/motion";
import PaymentsView from "../components/PaymentsView";
import { Ring } from "../components/Ring";
import { Card, ErrorNotice, Modal, Notice, Status, fmtDate, useAction, useLoad } from "../components/ui";
import { SPANS, Span, SortKey, addDays, bucketSeries, costSplitTotals, daysBetween, fmtDay, fmtInt, fmtPct, fmtSek, grainFor, insightTitle, isoDay, matchesCustomer, periodChoices, periodLabel, previousSpanRange, sortRows, spanRange, topAndBottom, customersCsv, dailyCsv, csvName } from "../finance";
import { toneClass, trendOf } from "../trend";
import type { Trend, TrendTone } from "../trend";
import type { FinanceOverview, FinanceTenantRow, TenantSummary } from "../types";
import { RefreshButton, SaveButton } from "../components/save";
import { SkelCard, SkelKpis, SkelPage, SkelTable } from "../components/Skeleton";
import { useRowOpen } from "../components/rowLink";
import { helpSlug } from "../features/help/helpId";
import { FreeBadge } from "../components/FreeFields";
import { InfoTip } from "../components/StepFlow";
import { Select } from "../components/Select";
import { DateInput } from "../components/DateInput";
import { ScrollEdges } from "../components/ScrollEdges";
import { billingPhaseText } from "../billingPhase";
import "./finance.css";

const VIEWS = ["Overview", "Payments"] as const;

export default function FinancePage({ view: initialView = "Overview" }: { view?: (typeof VIEWS)[number] }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>(initialView);
  // A billing period (a calendar month) and how many months back from it; the month in progress runs to today.
  const choices = useMemo(() => periodChoices(24), []);
  const [periodFrom, setPeriodFrom] = useState(() => choices[0].from);
  const [span, setSpan] = useState<Span>(1);
  const range = useMemo(() => spanRange(periodFrom, span), [periodFrom, span]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [customer, setCustomer] = useState<TenantSummary | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [needle, setNeedle] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "marginSek", dir: "desc" });
  const [rebuild, setRebuild] = useState(false);
  const tenants = useLoad(() => api.tenants());
  // The period and the one before it (same length), for the comparisons.
  const { data: loaded, error, loading, reload } = useLoad(
    () => {
      const scope = { includeInactive, tenantId: customer?.tenantId ?? null, locationId: customer ? locationId : null };
      return Promise.all([
        api.financeOverview({ ...range, ...scope }),
        api.financeOverview({ ...previousSpanRange(range, span), ...scope }).catch(() => null),
      ]).then(([now, before]) => ({ now, before }));
    },
    [range.from, range.to, includeInactive, customer?.tenantId, locationId],
  );
  const data: FinanceOverview | null = loaded?.now ?? null;
  const before = loaded?.before?.kpis ?? null;
  const sync = useAction();
  // The header Refresh reloads the view on screen: the Payments list registers its own reload here.
  const paymentsReload = useRef<(() => Promise<boolean>) | null>(null);

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
  const split = useMemo(() => data?.kpis.costSplitSek ?? costSplitTotals(data?.tenants ?? []), [data]);
  const wholeBill = k?.costScope === "platform";
  const mrrStart = data?.series.length ? Number(data.series[0].mrrSek) : null;
  const mrrEnd = data?.series.length ? Number(data.series[data.series.length - 1].mrrSek) : null;
  // How each figure is doing against the period before (or, for MRR, the start of the period): green, red or neutral.
  const prev = "previous period";
  const trends = k && {
    margin: trendOf(k.marginSek, before?.marginSek, "margin", prev),
    revenue: trendOf(k.revenueSek, before?.revenueSek, "revenue", prev),
    mrr: trendOf(mrrEnd, mrrStart, "mrr", "the start of the period"),
    cost: trendOf(k.costSek, before?.costSek, "cost", prev),
    customers: trendOf(k.payingCustomers, before?.payingCustomers, "customers", prev),
    arpu: trendOf(k.arpuSek, before?.arpuSek, "arpu", prev),
    costPerBooking: trendOf(k.costPerBookingSek, before?.costPerBookingSek, "unitCost", prev),
    costPerOrder: trendOf(k.costPerOrderSek, before?.costPerOrderSek, "unitCost", prev),
    sms: trendOf(k.smsCostSek, before?.smsCostSek, "cost", prev),
  };
  // A loss is red whatever the period before was.
  const marginTone: TrendTone = k && k.marginSek < 0 ? "bad" : trends?.margin.tone ?? "neutral";
  const heroRef = useTrendPop<HTMLElement>(marginTone);
  const empty = !!data && data.tenants.length === 0 && data.series.length === 0;
  const pastDue = data?.attention.pastDue.length ?? 0;
  const noFigures = !!data && !empty && data.series.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Finance</h1>
          <p className="muted">
            {data?.asOf ? `As of ${fmtDate(data.asOf)} · SEK ex VAT` : data ? "No nightly figures yet" : "SEK ex VAT"}{" "}
            <InfoTip label="About the figures">
              {data?.costAsOf ? `AWS cost known up to ${fmtDay(data.costAsOf)} (Cost Explorer lags about a day). ` : ""}
              Revenue and cost in SEK excluding VAT. The figures come from the nightly job (Cost Explorer plus each
              customer's usage) and from Stripe when invoices are created and paid.
            </InfoTip>
          </p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" disabled={!data || data.tenants.length === 0}
                  title="One row per customer for the chosen period (SEK ex VAT)"
                  onClick={() => data && downloadCsv(csvName("customers", data.period), customersCsv(rows))}>
            Export customers (CSV)
          </button>
          <button className="btn btn--ghost" disabled={!data || data.series.length === 0}
                  title="One row per day for the chosen period (the chart data)"
                  onClick={() => data && downloadCsv(csvName("daily", data.period), dailyCsv(data.series))}>
            Export daily (CSV)
          </button>
          <RefreshButton reload={() => (view === "Payments" && paymentsReload.current ? paymentsReload.current() : reload())} />
          <SaveButton kind="ghost" type="button" label="Import from Stripe" busy={sync.busy} busyLabel="Reading Stripe…" done={sync.done} doneLabel="Imported"
                      onClick={async () => { if (await sync.run(() => api.financeStripeSync())) void reload(); }} />
          <CtaButton label="Rebuild" win="Kör!" onClick={() => setRebuild(true)} />
        </div>
      </div>

      <nav className="tabs">
        {VIEWS.map((name) => (
          <button key={name} className={`tab${view === name ? " tab--on" : ""}`} data-help={`finance-tab:${helpSlug(name)}`} onClick={() => setView(name)}>{name}</button>
        ))}
      </nav>

      {view === "Payments" && <PaymentsView reloadRef={paymentsReload} />}
      {view === "Overview" && <>
      <div className="toolbar finance-toolbar">
        <div className="range">
          <label className="range__field range__field--period">
            <Select aria-label="Billing period" title="Billing period" value={periodFrom} onChange={setPeriodFrom}
                    options={choices.map((p) => ({ value: p.from, label: `${periodLabel(p)}${p.current ? " (now)" : ""}` }))} />
          </label>
        </div>
        <div className="chips" role="group" aria-label="How many periods">
          {SPANS.map((s) => (
            <button key={s.id} className={`chip${span === s.id ? " chip--on" : ""}`} aria-pressed={span === s.id}
                    onClick={() => setSpan(s.id)}>{s.label}</button>
          ))}
        </div>
        <label className="switch">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          <span>Include inactive customers</span>
        </label>
        {customer && (data?.locations?.length ?? 0) > 0 && (
          <label className="range__field">
            <Select value={locationId ?? ""} aria-label="Location" title="Location" onChange={(v) => setLocationId(v || null)}
                    options={[{ value: "", label: "All locations" }, ...data!.locations!.map((l) => ({ value: l.locationId, label: l.name ?? l.locationId }))]} />
          </label>
        )}
        <div className="customer-filter">
          {customer ? (
            <span className="chip chip--on chip--customer">
              {customer.name}
              <button className="chip__x" aria-label="Show all customers" onClick={() => { setCustomer(null); setLocationId(null); }}>✕</button>
            </span>
          ) : (
            <>
              <input className="input search" placeholder="Customer: name, org. number or slug…" value={needle}
                     aria-label="Filter by customer" onChange={(e) => setNeedle(e.target.value)} />
              {needle.trim() && (
                <ul className="suggestions" role="listbox">
                  {suggestions.map((t) => (
                    <li key={t.tenantId}>
                      <button role="option" aria-selected={false} onClick={() => { setCustomer(t); setLocationId(null); setNeedle(""); }}>
                        <strong>{t.name}</strong> <span className="muted mono small">{t.slug}</span> <Status value={t.status} />
                      </button>
                    </li>
                  ))}
                  {suggestions.length === 0 && (tenants.error
                    ? <li className="suggestions__none"><ErrorNotice error={tenants.error} onRetry={() => void tenants.reload()} /></li>
                    : tenants.loading && !tenants.data
                      ? <li className="muted small suggestions__none" role="status">Loading customers…</li>
                      : <li className="muted small suggestions__none">No customer matches.</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <ErrorNotice error={error ?? sync.error} onRetry={error ? () => void reload() : undefined} />
      {data?.period.locationId && (
        <Notice kind="info">
          One location{" "}
          <InfoTip label="One location">
            Usage and its share of the AWS cost. Revenue, collected, outstanding and MRR are the whole
            restaurant's, since there is one subscription per restaurant.
          </InfoTip>
        </Notice>
      )}

      {loading && !data ? (
        <SkelPage label="Adding up">
          <SkelKpis className="kpis--lead" />
          <SkelKpis n={3} className="kpis--units" />
          <div className="charts">
            <SkelCard chart />
            <SkelCard chart />
          </div>
          <SkelTable rows={5} cols={6} />
        </SkelPage>
      ) : data && k && trends && (
        <>
          {empty && (
            <Card title="Nothing to add up yet">
              <p>{customer || includeInactive ? "No figures for this selection." : "No active customers yet."}</p>
            </Card>
          )}
          {noFigures && (
            <Notice kind="info">
              No day rows in this period yet.{" "}
              <InfoTip label="Day rows">
                The nightly job writes yesterday's figures every morning; use Rebuild for older days (requests can be
                counted for the last 30 days, the logs' retention).
              </InfoTip>
            </Notice>
          )}

          {/* 1. Recurring revenue, customers and cash: what the founder checks first (docs/DASHBOARD.md). */}
          <section className="kpis kpis--lead" aria-label="Recurring revenue and cash">
            <Kpi label="MRR" value={<CountUp value={k.mrrSek} format={fmtSek} />} trend={trends.mrr} />
            <Kpi label="Paying customers" value={<CountUp value={k.payingCustomers} format={(n) => fmtInt(Math.round(n))} />}
                 trend={trends.customers} />
            <Kpi label="Collected" value={<CountUp value={k.collectedSek} format={fmtSek} />}
                 info={(k.refundedSek ?? 0) > 0 ? <>After {fmtSek(k.refundedSek)} refunded to cards (ex VAT).</> : undefined} />
            <Kpi label="Outstanding" value={<CountUp value={k.outstandingSek} format={fmtSek} />}
                 tone={k.outstandingSek > 0 || pastDue > 0 ? "warn" : undefined} />
          </section>

          {/* 2. Is it profitable: gross margin, AWS cost against revenue. */}
          <section className="hero" aria-label="The period at a glance">
            <div className="kpi kpi--hero">
              <span className="kpi__head"><span className="kpi__label">Gross margin</span><Delta trend={trends.margin} /></span>
              <strong ref={heroRef} className={`kpi__value${toneClass(marginTone)}`}><CountUp value={k.marginSek} format={fmtSek} /></strong>
            </div>
            <div className="kpi kpi--rings">
              <Ring title="Where the revenue goes" total={Math.max(k.revenueSek, k.costSek, 0)} centerLabel="profit" empty="No revenue yet"
                    segments={[
                      { key: "margin", label: "Profit", value: Math.max(0, k.marginSek), tone: "ink" },
                      { key: "cost", label: "AWS cost", value: k.costSek, tone: "red" },
                    ]} />
              <Ring title="What the AWS cost is for" total={k.costSek} centerLabel="requests" empty="No cost yet"
                    segments={[
                      { key: "requests", label: "Requests", value: split.requests, tone: "ink" },
                      { key: "baseline", label: "Baseline", value: split.baseline, tone: "steel" },
                      { key: "email", label: "Emails", value: split.email, tone: "warn" },
                      { key: "sms", label: "SMS", value: split.sms, tone: "red" },
                    ]} />
              <Ring title="How much is collected" total={k.collectedSek + k.outstandingSek} centerLabel="collected" empty="Nothing invoiced"
                    segments={[
                      { key: "collected", label: "Collected", value: k.collectedSek, tone: "ok" },
                      { key: "outstanding", label: "Outstanding", value: k.outstandingSek, tone: "warn" },
                    ]} />
            </div>
          </section>

          {/* 3. What needs action: unpaid customers, customers without a subscription, the nightly job. */}
          {(data.attention.pastDue.length > 0 || data.attention.noSubscription.length > 0) && (
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
          {data.job?.warnings?.length ? (
            <Notice kind="warn">
              <strong>The nightly job reported problems:</strong>
              <ul className="plain-list">{data.job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Notice>
          ) : null}

          {/* 4. Revenue and unit economics, then the charts and the per-customer detail. */}
          <Disclosure title="Revenue and unit economics" meta="ARPU, cost per booking and order, SMS">
            <section className="kpis kpis--units" aria-label="Revenue and unit economics">
              <Kpi label="Revenue" value={<CountUp value={k.revenueSek} format={fmtSek} />} trend={trends.revenue} />
              <Kpi label={wholeBill ? "AWS bill" : "AWS cost"} value={<CountUp value={k.costSek} format={fmtSek} />} trend={trends.cost} />
              <Kpi label="ARPU" value={<CountUp value={k.arpuSek} format={fmtSek} />} trend={trends.arpu} />
              <Kpi label="Cost per booking" value={<CountUp value={k.costPerBookingSek} format={(n) => fmtSek(n, { decimals: true })} />}
                   trend={trends.costPerBooking} />
              <Kpi label="Cost per order" value={<CountUp value={k.costPerOrderSek} format={(n) => fmtSek(n, { decimals: true })} />}
                   trend={trends.costPerOrder} />
              <Kpi label="SMS" value={<CountUp value={k.smsCostSek} format={(n) => fmtSek(n, { decimals: true })} />} trend={trends.sms} />
            </section>
          </Disclosure>

          <div className="charts">
            <Card title={insightTitle("MRR", deltaPct(mrrEnd ?? NaN, mrrStart ?? NaN))}>
              <LineChart points={buckets.map((b) => ({ key: b.key, value: b.mrr }))} label="MRR" ariaLabel="Monthly recurring revenue over time" />
            </Card>
            <Card title={insightTitle("Revenue", deltaPct(k.revenueSek, before?.revenueSek ?? NaN))}>
              {k.revenueSek > 0 && <p className="insight">AWS cost {fmtPct((k.costSek / k.revenueSek) * 100)} of revenue</p>}
              <BarLineChart points={buckets.map((b) => ({ key: b.key, bar: b.revenue, line: b.cost }))}
                            barLabel="Revenue" lineLabel="AWS cost" ariaLabel={`Revenue and AWS cost per ${grain}`} />
            </Card>
          </div>

          {data.tenants.length > 1 && (
            <div className="charts">
              <Card title="Best margin">
                <HBarChart rows={top.map((t) => ({ key: t.tenantId, label: t.name, value: t.marginSek }))} ariaLabel="Customers with the best margin" valueLabel="Margin" />
              </Card>
              {bottom.length > 0 && (
                <Card title="Weakest margin">
                  <HBarChart rows={bottom.map((t) => ({ key: t.tenantId, label: t.name, value: t.marginSek }))} ariaLabel="Customers with the weakest margin" valueLabel="Margin" />
                </Card>
              )}
            </div>
          )}

          <ScrollEdges>
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
                  <Th k="smsParts" sort={sort} setSort={setSort}>SMS</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => <TenantRow key={t.tenantId} t={t} />)}
                {rows.length === 0 && <tr><td colSpan={11} className="empty">No customers in this selection.</td></tr>}
              </tbody>
            </table>
          </div>
          </ScrollEdges>
        </>
      )}

      </>}

      {rebuild && <RebuildModal range={range} onClose={() => setRebuild(false)} onStarted={() => { setRebuild(false); }} />}
    </>
  );
}

/** A key figure: only its label and number. With a `trend` the figure turns
 * green or red by how it is doing (src/trend.ts) and the change is a chip by the label. */
function Kpi({ label, value, tone, trend, info }: {
  label: string; value: ReactNode; tone?: "warn"; trend?: Trend; info?: ReactNode;
}) {
  const shade: TrendTone = trend?.tone ?? "neutral";
  const ref = useTrendPop<HTMLElement>(shade);
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ""}`} data-help={`kpi:${helpSlug(label)}`}>
      <span className="kpi__head"><span className="kpi__label">{label}{info && <> <InfoTip label={`About ${label}`}>{info}</InfoTip></>}</span>{trend && <Delta trend={trend} />}</span>
      <strong ref={ref} className={`kpi__value${toneClass(shade)}`}>{value}</strong>
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
  const openRow = useRowOpen();
  return (
    <tr className="row-link" onClick={(e) => openRow(e, `/tenants/${t.tenantId}?tab=billing`)}>
      <td className="cell-title">
        <Link to={`/tenants/${t.tenantId}?tab=billing`} className="strong row-link__name">{t.name}</Link>
        <div className="muted small mono"><span className="finance-org">{t.orgNumber ?? t.slug}</span>{t.status !== "active" ? " · " : ""}{t.status !== "active" && <Status value={t.status} />}</div>
      </td>
      <td className="cell-badge">
        <span className={`status status--billing-${t.billingStatus}`}>{billingPhaseText(t.billingStatus)}</span>
        {t.free && <div><FreeBadge until={t.freeUntil ?? null} /></div>}
      </td>
      <td className="num" data-label="MRR">{fmtSek(t.mrrSek)}</td>
      <td className="num" data-label="Revenue">{fmtSek(t.revenueSek)}</td>
      <td className="num" data-label="Collected">{fmtSek(t.collectedSek)}</td>
      <td className={`num${t.outstandingSek > 0 ? " warn" : ""}`} data-label="Outstanding">{fmtSek(t.outstandingSek)}</td>
      <td className="num" data-label="AWS cost">{fmtSek(t.costSek)}</td>
      <td className={`num${t.marginSek < 0 ? " bad" : ""}`} data-label="Margin">
        {fmtSek(t.marginSek)}<div className="muted small">{t.marginPct === null ? "-" : fmtPct(t.marginPct)}</div>
      </td>
      <td className="num" data-label="Bookings">{fmtInt(t.bookings)}</td>
      <td className="num" data-label="Orders">{fmtInt(t.orders)}</td>
      <td className="num" data-label="SMS">{fmtInt(t.smsParts)}<div className="muted small">{fmtSek(t.smsCostSek, { decimals: true })} cost</div></td>
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
          Up to 92 days, yesterday at the latest.{" "}
          <InfoTip label="About Rebuild">
            Recomputes the AWS cost, usage and allocation for a date range. Use it after changing the exchange rate or
            the cost allocation, or when a night was missed. The run takes a few minutes; refresh the page afterwards.
            Request counts exist for the last 30 days only (log retention).
          </InfoTip>
        </p>
        <div className="range">
          <label className="range__field"><span>From</span><DateInput value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="range__field"><span>To</span><DateInput value={to} min={from} max={yesterday} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <ErrorNotice error={a.error} />
        {done && <Notice kind="ok">Rebuild started for {done}.</Notice>}
        <div className="row">
          <SaveButton label="Start rebuild" busy={a.busy} busyLabel="Starting…" done={!!done} doneLabel="Started" />
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </Modal>
  );
}

function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
