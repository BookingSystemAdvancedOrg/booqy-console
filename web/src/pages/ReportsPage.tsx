import { useEffect, useState } from "react";
import { InboxSwitch } from "../components/InboxSwitch";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, fmtDate, useAction, useLoad } from "../components/ui";
import { RefreshButton } from "../components/save";
import { SkelPage, SkelTable } from "../components/Skeleton";
import type { SupportReport } from "../types";
import { InfoTip } from "../components/StepFlow";
import { usePagedList } from "../paging";

type Show = "open" | "handled" | "all";

const SHOW: { key: Show; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "handled", label: "Handled" },
  { key: "all", label: "All" },
];

/** "Mozilla/5.0 (Macintosh ...) Chrome/131" -> "Chrome on Mac": enough to spot a browser pattern. */
export function browserOf(ua: string | null): string {
  if (!ua) return "-";
  const app = /BooqyAdmin|Electron/.test(ua) ? "Desktop app"
    : /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${app} on ${os}` : app;
}

const reportKey = (r: SupportReport) => r.reportId;
/** Report ids start with the time, so a larger one is newer (listed first). */
const newerReport = (a: SupportReport, b: SupportReport) => a.reportId > b.reportId;

/**
 * Reports: errors restaurants sent with "Rapportera till Booqy" in Booqy
 * Admin, newest first. Each is a Booqy fault (5xx, *_unavailable, unknown
 * codes); the request id finds it in the logs. Mark handled when fixed or
 * explained. Kept 180 days; the operators get an email per new report.
 */
export default function ReportsPage() {
  const [show, setShow] = useState<Show>("open");
  const { data, error, loading, reload } = useLoad(() => api.supportReports(show), [show]);
  // Live: a quiet refetch of the first page keeps the older pages already
  // loaded (and the scroll); only a new filter starts over.
  const { rows: listed, cursor, append } = usePagedList(data?.items, data?.cursor, reportKey, newerReport);
  const [changed, setChanged] = useState<Record<string, SupportReport>>({});
  const paging = useAction();
  const marking = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => setChanged({}), [show]);
  // The server's answer wins over a local mark for every row the new first page has.
  useEffect(() => {
    if (!data) return;
    setChanged((c) => {
      const keep = Object.fromEntries(Object.entries(c).filter(([id]) => !data.items.some((r) => r.reportId === id)));
      return Object.keys(keep).length === Object.keys(c).length ? c : keep;
    });
  }, [data]);

  const rows = listed.map((r) => changed[r.reportId] ?? r);

  const loadMore = async () => {
    if (!cursor) return;
    const page = await paging.run(() => api.supportReports(show, cursor));
    if (page) append(page.items, page.cursor);
  };

  const mark = async (r: SupportReport) => {
    setBusyId(r.reportId);
    const updated = await marking.run(() => api.markReport(r.reportId, !r.handled));
    setBusyId(null);
    if (updated) setChanged((c) => ({ ...c, [r.reportId]: updated }));
  };

  return (
    <>
      <InboxSwitch on="reports" />
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            From Booqy Admin · kept 180 days{" "}
            <InfoTip label="About reports">
              Errors restaurants reported from Booqy Admin with Rapportera till Booqy. Each one is ours to fix: look the
              request id up in the logs, then mark it handled.
            </InfoTip>
          </p>
        </div>
        <div className="row">
          <div className="row reports-filter" role="group" aria-label="Show">
            {SHOW.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`btn btn--small ${show === s.key ? "btn--primary" : "btn--ghost"}`}
                aria-pressed={show === s.key}
                onClick={() => setShow(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <RefreshButton reload={reload} />
        </div>
      </div>

      <ErrorNotice error={error} onRetry={() => void reload()} />
      <ErrorNotice error={paging.error} onRetry={() => void loadMore()} />
      <ErrorNotice error={marking.error} />

      {loading && !data ? <SkelPage label="Loading the reports"><SkelTable rows={6} cols={5} /></SkelPage> : data && (
        <div className="table-wrap" data-help="reports:list">
          <table className="table reports-table">
            <thead>
              <tr><th>Reported</th><th>Restaurant</th><th>Error</th><th>Page</th><th>Request id</th><th>Browser</th><th /></tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="empty">{show === "open" ? "No open reports." : "No reports."}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.reportId} className={r.handled ? "reports-row--handled" : undefined}>
                  <td className="nowrap" data-label="Reported">{fmtDate(r.createdAt)}</td>
                  <td className="cell-title" data-label="Restaurant">
                    <Link to={`/tenants/${encodeURIComponent(r.tenantId)}`}>{r.tenantName || r.tenantId}</Link>
                    <span className="small muted reports-who">{r.role === "staff_user" ? "Staff" : r.role === "owner_user" ? "Owner" : r.role ?? ""}</span>
                  </td>
                  <td data-label="Error"><code>{r.code}</code> <span className="small muted">HTTP {r.status || "-"}</span></td>
                  <td data-label="Page"><code>{r.path}</code></td>
                  <td data-label="Request id"><code className="reports-id">{r.requestId ?? "-"}</code></td>
                  <td data-label="Browser" title={r.userAgent ?? undefined}>
                    {browserOf(r.userAgent)}
                    {r.appVersion && <span className="small muted reports-who">v {r.appVersion}</span>}
                  </td>
                  <td className="nowrap">
                    <button
                      type="button"
                      className={`btn btn--small ${r.handled ? "btn--ghost" : "btn--primary"}`}
                      disabled={busyId === r.reportId}
                      onClick={() => void mark(r)}
                      title={r.handled && r.handledBy ? `Handled by ${r.handledBy} ${fmtDate(r.handledAt ?? undefined)}` : undefined}
                    >
                      {busyId === r.reportId ? "Saving…" : r.handled ? "Reopen" : "Mark handled"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div className="outbox-more">
              <button className="btn btn--ghost" disabled={paging.busy} onClick={() => void loadMore()}>
                {paging.busy ? "Loading…" : "Load older"}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
