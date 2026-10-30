import { ReactNode, useMemo, useState } from "react";
import { api } from "../api";
import { BarLineChart, HBarChart, countTick } from "../components/charts";
import { CountUp, Delta, useTrendPop } from "../components/motion";
import { Card, ErrorNotice, Notice, Printing, fmtDate, useLoad } from "../components/ui";
import { daysBetween, fmtDay, fmtInt, fmtPct } from "../finance";
import { toneClass, trendOf } from "../trend";
import type { Trend, TrendMetric, TrendTone } from "../trend";
import {
  PRESETS, Preset, SOURCE_HINT, SOURCE_LABEL, breakdownsCsv, campaignParts, countryName, csvName, dailyCsv, fmtDuration,
  lastDays, placeParts, previousRange, scrollReach, share,
} from "../website";
import type { PageRow, VisitRow, WebsiteOverview } from "../website";
import "./WebsitePage.css";
import { RefreshButton } from "../components/save";

const PLACES = ["Countries", "Regions", "Cities"] as const;
const TECH = ["Devices", "Browsers", "Operating systems", "Languages"] as const;
const DEVICE_LABEL: Record<string, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop" };
const fmtCount = (n: number) => fmtInt(Math.round(n));

export default function WebsitePage() {
  const [preset, setPreset] = useState<Preset>(30);
  const [custom, setCustom] = useState(() => lastDays(30));
  const range = useMemo(() => (preset === "custom" ? custom : lastDays(preset)), [preset, custom]);
  const { data, error, loading, reload } = useLoad(() => api.website(range), [range.from, range.to]);
  const [places, setPlaces] = useState<(typeof PLACES)[number]>("Countries");
  const [tech, setTech] = useState<(typeof TECH)[number]>("Devices");

  if (data && !data.enabled) {
    return (
      <>
        <Head data={null} reload={reload} />
        <Notice kind="info">Statistics are off in this environment (no platform domain).</Notice>
      </>
    );
  }

  const k = data?.kpis;
  const b = data?.previousKpis ?? null;
  const prev = data ? `${fmtDay(data.previous.from)} to ${fmtDay(data.previous.to)}` : "previous period";
  const t = (metric: TrendMetric, now: number | null | undefined, then: number | null | undefined) =>
    b ? trendOf(now, then, metric, "previous period") : trendOf(null, null, metric, "");
  const trends = k && {
    visitors: t("visits", k.visitors, b?.visitors),
    visits: t("visits", k.visits, b?.visits),
    pageviews: t("visits", k.pageviews, b?.pageviews),
    conversions: t("conversions", k.conversions, b?.conversions),
    rate: t("rate", k.conversionRate, b?.conversionRate),
    bounce: t("bounce", k.bounceRate, b?.bounceRate),
    seconds: t("seconds", k.avgEngagedSeconds, b?.avgEngagedSeconds),
  };
  const empty = !!k && k.visits === 0 && (!b || b.visits === 0);

  return (
    <>
      <Head data={data} reload={reload} />

      <div className="toolbar web-toolbar">
        <div className="chips" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.id} className={`chip${preset === p.id ? " chip--on" : ""}`} aria-pressed={preset === p.id}
                    onClick={() => { if (p.id === "custom") setCustom(range); setPreset(p.id); }}>{p.label}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="range">
            <label className="range__field"><span>From</span>
              <input className="input" type="date" value={custom.from} max={custom.to}
                     onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="range__field"><span>To</span>
              <input className="input" type="date" value={custom.to} min={custom.from}
                     onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
        <span className="web-compare">
          {daysBetween(range.from, range.to)} days, compared with the {daysBetween(range.from, range.to)} days before
          ({fmtDay(previousRange(range.from, range.to).from)} to {fmtDay(previousRange(range.from, range.to).to)})
        </span>
      </div>

      <ErrorNotice error={error} />

      {loading && !data ? <Printing label="Counting visits" /> : data && k && trends && (
        <>
          {empty && (
            <Card title="No visits counted yet">
              <p>
                The figures come from booqy.se itself: every page sends one cookieless hit, and the counts are added up
                every 15 minutes. Open the site (without Global Privacy Control or Do Not Track, which are never counted)
                and the visit shows here within a quarter of an hour.
              </p>
            </Card>
          )}

          {/* 1. Reach and the one conversion that matters: a booked demo. */}
          <section className="kpis kpis--lead" aria-label="Visitors and demo bookings">
            <Kpi label="Visitors" value={<CountUp value={k.visitors} format={fmtCount} />} trend={trends.visitors}
                 sub="unique per day, summed" />
            <Kpi label="Visits" value={<CountUp value={k.visits} format={fmtCount} />} trend={trends.visits}
                 sub={k.pagesPerVisit === null ? "no visits" : `${fmtInt(k.pagesPerVisit)} pages per visit`} />
            <Kpi label="Page views" value={<CountUp value={k.pageviews} format={fmtCount} />} trend={trends.pageviews} />
            <Kpi label="Demo bookings" value={<CountUp value={k.conversions} format={fmtCount} />} trend={trends.conversions}
                 sub={k.conversionRate === null ? "conversion rate -" : `${fmtPct(k.conversionRate)} of visits booked`} />
          </section>

          <section className="kpis kpis--units" aria-label="Engagement">
            <Kpi label="Conversion rate" value={k.conversionRate === null ? "-" : fmtPct(k.conversionRate)} trend={trends.rate}
                 sub={`${fmtInt(k.convertedVisits)} visits with a demo booking`} />
            <Kpi label="Bounce rate" value={k.bounceRate === null ? "-" : fmtPct(k.bounceRate)} trend={trends.bounce}
                 sub="one page, under 10 s, no booking" />
            <Kpi label="Engaged time" value={fmtDuration(k.avgEngagedSeconds)} trend={trends.seconds}
                 sub="average per visit, tab in view" />
          </section>

          <div className="charts">
            <Card title="Visits per day">
              <p className="insight">Bars are visits, the line is unique visitors. Compared with {prev}</p>
              <BarLineChart points={data.series.map((p) => ({ key: p.day, bar: p.visits, line: p.visitors }))}
                            barLabel="Visits" lineLabel="Visitors" ariaLabel="Visits and visitors per day"
                            format={fmtCount} tick={countTick} />
            </Card>
            <Card title="Traffic sources">
              <SourcesTable data={data} />
            </Card>
          </div>

          <Card title="Campaigns (UTM)">
            <CampaignTable rows={data.breakdowns.campaigns} />
            {(data.breakdowns.contents.length > 0 || data.breakdowns.terms.length > 0) && (
              <div className="web-pair">
                <VisitTable title="utm_content" rows={data.breakdowns.contents} />
                <VisitTable title="utm_term" rows={data.breakdowns.terms} />
              </div>
            )}
          </Card>

          <div className="charts">
            <Card title="Landing pages">
              <VisitTable title="Page" rows={data.breakdowns.landing} mono />
            </Card>
            <Card title="Top pages">
              <PageTable rows={data.breakdowns.pages} />
            </Card>
          </div>

          <div className="charts">
            <Card title="Where visitors are">
              <Tabs names={PLACES} on={places} set={setPlaces} />
              {places === "Countries" && (
                <VisitTable title="Country" rows={data.breakdowns.countries} label={(key) => `${countryName(key)} (${key})`} />
              )}
              {places === "Regions" && <VisitTable title="Region" rows={data.breakdowns.regions} label={placeLabel} />}
              {places === "Cities" && <VisitTable title="City" rows={data.breakdowns.cities} label={placeLabel} />}
            </Card>
            <Card title="Devices and browsers">
              <Tabs names={TECH} on={tech} set={setTech} />
              {tech === "Devices" && <VisitTable title="Device" rows={data.breakdowns.devices} label={(key) => DEVICE_LABEL[key] ?? key} />}
              {tech === "Browsers" && <VisitTable title="Browser" rows={data.breakdowns.browsers} />}
              {tech === "Operating systems" && <VisitTable title="System" rows={data.breakdowns.os} />}
              {tech === "Languages" && <VisitTable title="Language" rows={data.breakdowns.languages} />}
            </Card>
          </div>

          <div className="charts">
            <Card title="Scroll depth">
              <p className="insight">How far down the page readers got, of the page views that reported it.</p>
              <HBarChart rows={scrollReach(data.scroll).map((r) => ({ key: r.band, label: `${r.band} % of the page`, value: r.pct ?? 0 }))}
                         ariaLabel="Share of page views reaching each scroll depth" valueLabel="Page views"
                         format={(n) => fmtPct(n)} />
            </Card>
            <Card title="Clicks">
              <div className="web-pair">
                <EventTable title="Call to action" rows={data.events.cta ?? []} />
                <EventTable title="Showcase tab" rows={data.events.tab ?? []} />
              </div>
            </Card>
          </div>

          <div className="charts">
            <Card title="Referring sites">
              <VisitTable title="Site" rows={data.breakdowns.referrers} mono />
            </Card>
            <Card title="Time of day">
              <p className="insight">Visits by the hour they started, Stockholm time.</p>
              <HourStrip hours={data.hours} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Head({ data, reload }: { data: WebsiteOverview | null; reload: () => Promise<boolean> }) {
  return (
    <div className="page-head">
      <div>
        <h1>Website</h1>
        <p className="muted">
          booqy.se, counted without cookies.{" "}
          {data?.asOf ? `Figures as of ${fmtDate(data.asOf)}. ` : ""}Days in Stockholm time.
        </p>
      </div>
      <div className="row">
        {data?.live && (
          <span className="web-live" title={`Distinct visitors in the last ${data.live.minutes} minutes`}>
            <i aria-hidden="true" /> {fmtInt(data.live.visitors)} {data.live.visitors === 1 ? "visitor" : "visitors"} in the last {data.live.minutes} min
          </span>
        )}
        <button className="btn btn--ghost" disabled={!data?.series?.length}
                title="One row per day for the chosen period"
                onClick={() => data && downloadCsv(csvName("daily", data.period), dailyCsv(data))}>Export daily (CSV)</button>
        <button className="btn btn--ghost" disabled={!data?.breakdowns}
                title="Sources, campaigns, pages, places and devices for the chosen period"
                onClick={() => data && downloadCsv(csvName("breakdowns", data.period), breakdownsCsv(data))}>Export breakdowns (CSV)</button>
        <RefreshButton reload={reload} />
      </div>
    </div>
  );
}

function placeLabel(key: string): string {
  const { country, place } = placeParts(key);
  return `${place}, ${country}`;
}

/** A key figure, green or red by how it is doing against the previous period (src/trend.ts). */
function Kpi({ label, value, sub, trend }: { label: string; value: ReactNode; sub?: string; trend: Trend }) {
  const shade: TrendTone = trend.tone;
  const ref = useTrendPop<HTMLElement>(shade);
  return (
    <div className="kpi">
      <span className="kpi__label">{label}</span>
      <strong ref={ref} className={`kpi__value${toneClass(shade)}`}>{value}</strong>
      {sub && <span className="kpi__sub">{sub}</span>}
      {trend.text && <span className="kpi__delta"><Delta trend={trend} /></span>}
    </div>
  );
}

function Tabs<T extends string>({ names, on, set }: { names: readonly T[]; on: T; set: (t: T) => void }) {
  return (
    <div className="chips web-tabs" role="group">
      {names.map((n) => (
        <button key={n} className={`chip${on === n ? " chip--on" : ""}`} aria-pressed={on === n} onClick={() => set(n)}>{n}</button>
      ))}
    </div>
  );
}

function SourcesTable({ data }: { data: WebsiteOverview }) {
  const rows = data.breakdowns.sources;
  const total = rows.reduce((a, r) => a + r.visits, 0);
  if (!rows.length) return <p className="web-none">No visits in this period.</p>;
  return (
    <div className="web-scroll">
      <table className="table web-table">
        <thead><tr><th>Source</th><th className="num">Visits</th><th className="num web-col-share">Share</th><th className="num">Demo</th><th className="num">Conv.</th><th className="num">Bounce</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const before = data.previousKpis ? data.previousSources[r.key]?.visits ?? 0 : null;
            const tr = trendOf(r.visits, before, "visits", "previous period");
            return (
              <tr key={r.key}>
                <td title={SOURCE_HINT[r.key]}>
                  <span className="strong">{SOURCE_LABEL[r.key] ?? r.key}</span>
                  {tr.text && <div className={`web-delta${toneClass(tr.tone)}`}>{tr.text}<span className="sr-only"> {tr.spoken}</span></div>}
                </td>
                <td className="num">{fmtInt(r.visits)}</td>
                <td className="num web-col-share"><Bar pct={share(r.visits, total)} /></td>
                <td className="num">{fmtInt(r.conversions)}</td>
                <td className="num">{fmtPct(share(r.conversions, r.visits))}</td>
                <td className="num">{fmtPct(share(r.bounces, r.visits))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HourStrip({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  const total = hours.reduce((a, b) => a + b, 0);
  return (
    <figure className="web-hours" aria-label="Visits per hour of the day, Stockholm time">
      <div className="web-hours__bars">
        {hours.map((v, h) => (
          <span key={h} className="web-hours__col" title={`${String(h).padStart(2, "0")}:00: ${fmtInt(v)} visits (${fmtPct(share(v, total))})`}>
            <span className="web-hours__bar" style={{ height: `${(v / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <figcaption className="web-hours__axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></figcaption>
    </figure>
  );
}

function Bar({ pct }: { pct: number | null }) {
  return (
    <span className="web-bar">
      <span className="web-bar__fill" style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      <span className="web-bar__text">{fmtPct(pct)}</span>
    </span>
  );
}

function CampaignTable({ rows }: { rows: VisitRow[] }) {
  if (!rows.length) {
    return <p className="web-none">No tagged visits. Add utm_source, utm_medium and utm_campaign to the links in ads, mails and posts to see them here.</p>;
  }
  return (
    <div className="web-scroll">
      <table className="table web-table">
        <thead><tr><th>Source</th><th>Medium</th><th>Campaign</th><th className="num">Visits</th><th className="num">Demo</th><th className="num">Conv.</th><th className="num">Bounce</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const c = campaignParts(r.key);
            return (
              <tr key={r.key}>
                <td className="mono">{c.source}</td><td className="mono">{c.medium}</td><td className="mono">{c.campaign}</td>
                <td className="num">{fmtInt(r.visits)}</td>
                <td className="num">{fmtInt(r.conversions)}</td>
                <td className={`num${r.conversions > 0 ? " web-good" : ""}`}>{fmtPct(share(r.conversions, r.visits))}</td>
                <td className="num">{fmtPct(share(r.bounces, r.visits))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VisitTable({ title, rows, label, mono }: { title: string; rows: VisitRow[]; label?: (key: string) => string; mono?: boolean }) {
  const total = rows.reduce((a, r) => a + r.visits, 0);
  if (!rows.length) return <p className="web-none">Nothing in this period.</p>;
  return (
    <div className="web-scroll">
      <table className="table web-table">
        <thead><tr><th>{title}</th><th className="num">Visits</th><th className="num web-col-share">Share</th><th className="num">Demo</th><th className="num">Bounce</th></tr></thead>
        <tbody>
          {rows.slice(0, 25).map((r) => (
            <tr key={r.key}>
              <td className={`web-key${mono ? " mono" : ""}`}>{label ? label(r.key) : r.key}</td>
              <td className="num">{fmtInt(r.visits)}</td>
              <td className="num web-col-share"><Bar pct={share(r.visits, total)} /></td>
              <td className="num">{fmtInt(r.conversions)}</td>
              <td className="num">{fmtPct(share(r.bounces, r.visits))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PageTable({ rows }: { rows: PageRow[] }) {
  if (!rows.length) return <p className="web-none">Nothing in this period.</p>;
  return (
    <div className="web-scroll">
      <table className="table web-table">
        <thead><tr><th>Page</th><th className="num">Views</th><th className="num">Engaged time</th></tr></thead>
        <tbody>
          {rows.slice(0, 25).map((r) => (
            <tr key={r.key}>
              <td className="web-key mono">{r.key}</td>
              <td className="num">{fmtInt(r.pageviews)}</td>
              <td className="num">{fmtDuration(r.avgSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventTable({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  return (
    <div className="web-scroll">
      <table className="table web-table">
        <thead><tr><th>{title}</th><th className="num">Clicks</th></tr></thead>
        <tbody>
          {rows.slice(0, 15).map((r) => (
            <tr key={r.key}><td className="web-key mono">{r.key}</td><td className="num">{fmtInt(r.count)}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={2} className="web-none">No clicks.</td></tr>}
        </tbody>
      </table>
    </div>
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
