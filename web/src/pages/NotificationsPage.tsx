import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { InboxSwitch } from "../components/InboxSwitch";
import { ErrorNotice, fmtDate, useLoad } from "../components/ui";
import { RefreshButton } from "../components/save";
import { SkelPage, SkelTable } from "../components/Skeleton";
import { InfoTip } from "../components/StepFlow";
import { quietly } from "../live";
import { NOTICES_SEEN_EVENT } from "../notices";
import type { OperatorNotice } from "../types";

export function noticeText(n: OperatorNotice): string {
  return `Setup finished: ${n.tenantName || n.tenantId}`;
}

/**
 * Notifications (the bell): what Booqy tells the operators. Today: a
 * restaurant finished Kom igång in Booqy Admin (every step done or skipped),
 * so its website can be built. Opening the page marks them seen for every
 * operator; the ones that were new stay marked New until you leave.
 */
export default function NotificationsPage() {
  const { data, error, loading, reload } = useLoad(() => api.notices());
  // New as of opening the page: kept while you are here, though they are now seen.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const marked = useRef(false);

  useEffect(() => {
    if (!data) return;
    const unseen = data.notices.filter((n) => !n.seenAt).map((n) => n.id);
    if (unseen.length === 0) return;
    setFresh((f) => new Set([...f, ...unseen]));
    if (marked.current) return;
    marked.current = true;
    void quietly(() => api.markNoticesSeen())
      .then(() => window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)))
      .catch(() => { marked.current = false; });
  }, [data]);

  return (
    <>
      <InboxSwitch on="notifications" />
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted">
            Setup finished{" "}
            <InfoTip label="About notifications">
              A restaurant finished Kom igång in Booqy Admin: every step done or skipped, at every location. Time to
              build its website. You also get an email. Each restaurant is announced once.
            </InfoTip>
          </p>
        </div>
        <RefreshButton reload={reload} />
      </div>

      <ErrorNotice error={error} onRetry={() => void reload()} />

      {loading && !data ? <SkelPage label="Loading the notifications"><SkelTable rows={4} cols={2} /></SkelPage> : data && (
        <div className="table-wrap" data-help="notifications:list">
          <table className="table notices-table">
            <thead>
              <tr><th>When</th><th>Notification</th></tr>
            </thead>
            <tbody>
              {data.notices.length === 0 && (
                <tr><td colSpan={2} className="empty">No notifications.</td></tr>
              )}
              {data.notices.map((n) => (
                <tr key={n.id} className={fresh.has(n.id) ? "notices-row--new" : undefined}>
                  <td className="nowrap" data-label="When">{fmtDate(n.at)}</td>
                  <td className="cell-title" data-label="Notification">
                    <Link to={`/tenants/${encodeURIComponent(n.tenantId)}`}>{noticeText(n)}</Link>
                    {fresh.has(n.id) && <span className="status status--active notices-new">New</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
