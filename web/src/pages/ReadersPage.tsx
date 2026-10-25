import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DEVICE } from "../components/TerminalModal";
import { ErrorNotice, Notice, Printing, useLoad } from "../components/ui";
import type { FleetReader } from "../types";

const FILTERS = ["all", "online", "offline", "unassigned"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = { all: "All", online: "Online", offline: "Offline", unassigned: "Not at a Booqy location" };

function lastSeen(ms?: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

function matches(r: FleetReader, filter: Filter) {
  if (filter === "unassigned") return r.locationId === null;
  if (filter === "online") return r.status === "online";
  if (filter === "offline") return r.status !== "online";
  return true;
}

/**
 * Every card reader on the platform with the customer and location it
 * belongs to. Readers live on each restaurant's own Stripe account and are
 * paired per location (customer -> Locations -> Card terminals); this page
 * is the overview across customers.
 */
export default function ReadersPage() {
  const { data, error, loading, reload } = useLoad(() => api.allReaders());
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.readers ?? []).filter(
      (r) =>
        matches(r, filter) &&
        (!needle || [r.label, r.serial_number, r.tenantName, r.locationName, r.id].some((s) => s?.toLowerCase().includes(needle))),
    );
  }, [data, q, filter]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, online: 0, offline: 0, unassigned: 0 };
    for (const r of data?.readers ?? []) for (const f of FILTERS) if (matches(r, f)) c[f] += 1;
    return c;
  }, [data]);

  const waiting = (data?.locations ?? []).filter((l) => l.readerCount === 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Card readers</h1>
          <p className="muted">
            {data ? `${data.readers.length} readers at ${data.locations.length} locations with card terminals` : " "}
          </p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => reload()}>Refresh</button>
        </div>
      </div>

      <div className="toolbar">
        <input className="input search" placeholder="Search reader, serial number, customer, location…" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f} className={`chip${filter === f ? " chip--on" : ""}`} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]}
              {f !== "all" && counts[f] ? <span className="chip__n">{counts[f]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <ErrorNotice error={error} />
      {data?.errors.map((e) => (
        <Notice key={e.accountId} kind="warn">
          Couldn't read the readers of <Link to={`/tenants/${e.tenantId}`}>{e.tenantName ?? e.tenantId}</Link> ({e.accountId}): {e.message}
        </Notice>
      ))}

      {loading && !data ? <Printing label="Asking Stripe" /> : (
        <>
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr><th>Reader</th><th>Status</th><th>Customer and location</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="strong">{r.label}</span>
                      <div className="muted small">{DEVICE[r.device_type] ?? r.device_type}{r.serial_number ? ` · ${r.serial_number}` : ""}</div>
                    </td>
                    <td>
                      <span className={`status status--${r.status === "online" ? "active" : "suspended"}`}>
                        {r.status === "online" ? "Online" : "Offline"}
                      </span>
                    </td>
                    <td>
                      <Link to={`/tenants/${r.tenantId}`}>{r.tenantName ?? r.tenantId}</Link>
                      <div className={r.locationId ? "small" : "muted small"}>
                        {r.locationId ? r.locationName ?? r.locationId
                          : "Not at a Booqy location: remove it in the restaurant's Stripe account"}
                      </div>
                    </td>
                    <td className="small"><span className="stack-label">Last seen </span>{lastSeen(r.last_seen_at)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      {data?.readers.length ? "No readers match." : "No card readers yet. Pair one under a customer's location (Card terminals)."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {waiting.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th colSpan={2}>Card terminals on, no reader paired yet</th></tr>
                </thead>
                <tbody>
                  {waiting.map((l) => (
                    <tr key={l.terminalLocationId}>
                      <td><Link to={`/tenants/${l.tenantId}`}>{l.tenantName ?? l.tenantId}</Link></td>
                      <td>{l.locationName ?? l.locationId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
