import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorNotice, Notice, fmtDate, useAction, useLoad, Printing } from "../components/ui";
import type { OutboxMessage, OutboxSummary } from "../types";

/** Every http(s) link in the message - the magic links are what you test. */
function linksOf(m: OutboxMessage): string[] {
  const found = new Set<string>();
  for (const source of [m.text ?? "", m.html ?? ""]) {
    for (const match of source.matchAll(/https?:\/\/[^\s"'<>)]+/g)) found.add(match[0].replace(/&amp;/g, "&"));
  }
  return [...found];
}

function MessageView({ id }: { id: string }) {
  const { data: m, error, loading } = useLoad(() => api.outboxMessage(id), [id]);
  const [tab, setTab] = useState<"html" | "text">("html");
  useEffect(() => setTab("html"), [id]);

  if (error) return <ErrorNotice error={error} />;
  if (loading || !m) return <Printing />;
  const links = linksOf(m);
  const showHtml = m.channel === "email" && !!m.html && tab === "html";

  return (
    <div className="card">
      <div className="card__head">
        <h2>{m.channel === "sms" ? "SMS" : m.subject || "(no subject)"}</h2>
        {m.channel === "email" && m.html && (
          <div className="row">
            <button className={`btn ${tab === "html" ? "btn--primary" : "btn--ghost"}`} onClick={() => setTab("html")}>HTML</button>
            <button className={`btn ${tab === "text" ? "btn--primary" : "btn--ghost"}`} onClick={() => setTab("text")}>Text</button>
          </div>
        )}
      </div>
      <div className="card__body">
        <dl className="outbox-meta">
          <dt>To</dt><dd>{m.to}</dd>
          {m.from && <><dt>From</dt><dd>{m.from}</dd></>}
          {m.replyTo && m.replyTo.length > 0 && <><dt>Reply-To</dt><dd>{m.replyTo.join(", ")}</dd></>}
          <dt>Saved</dt><dd>{fmtDate(m.at)}</dd>
        </dl>
        {showHtml ? (
          // Sandboxed with no permissions: no scripts, no forms, no navigation,
          // no access to this page - the email is shown, nothing in it runs.
          <iframe className="outbox-html" title="Email" sandbox="" srcDoc={m.html ?? ""} />
        ) : (
          <pre className="outbox-text">{m.text}</pre>
        )}
        {links.length > 0 && (
          <>
            <h3 className="outbox-links-title">Links</h3>
            <ul className="outbox-links">
              {links.map((l) => (
                <li key={l}><a href={l} target="_blank" rel="noreferrer noopener">{l}</a></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Dev mail outbox: what the platform would have emailed (and a copy of each
 * SMS) while the sending domain isn't verified in SES. Saved by the
 * notification Lambda, kept 30 days. Dev only.
 */
export default function OutboxPage({ embedded = false }: { embedded?: boolean }) {
  const { data, error, loading, reload } = useLoad(() => api.outbox());
  const [more, setMore] = useState<OutboxSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const paging = useAction();

  useEffect(() => {
    setMore([]);
    setNext(data?.next ?? null);
  }, [data]);

  const rows = [...(data?.messages ?? []), ...more];

  const loadMore = async () => {
    if (!next) return;
    const page = await paging.run(() => api.outbox(next));
    if (page) {
      setMore((m) => [...m, ...page.messages]);
      setNext(page.next ?? null);
    }
  };

  return (
    <>
      <div className={embedded ? "panel-head" : "page-head"}>
        <div>
          {embedded ? <h2>Mail outbox</h2> : <h1>Mail outbox</h1>}
          <p className="muted">
            Emails the platform would have sent (news from the Mail page included), plus a copy of every SMS -
            saved instead of sent until the sending domain is verified. Kept 30 days.
          </p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => reload()}>Refresh</button>
        </div>
      </div>

      <ErrorNotice error={error} />
      <ErrorNotice error={paging.error} />
      {data && !data.enabled && (
        <Notice kind="info">The outbox is off here - emails are sent normally (infrastructure <code>mail_outbox</code>).</Notice>
      )}

      {loading && !data ? <Printing /> : data?.enabled && (
        <div className="outbox">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Saved</th><th>Type</th><th>To</th><th>Subject / text</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={4} className="empty">Nothing yet. Make a booking or an order in dev.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id} className={`clickable${selected === r.id ? " selected" : ""}`} onClick={() => setSelected(r.id)}>
                    <td className="nowrap">{fmtDate(r.at)}</td>
                    <td>{r.channel === "sms" ? "SMS" : "Email"}</td>
                    <td>{r.to}</td>
                    <td>{r.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {next && (
              <div className="outbox-more">
                <button className="btn btn--ghost" disabled={paging.busy} onClick={() => void loadMore()}>
                  {paging.busy ? "Loading…" : "Load older"}
                </button>
              </div>
            )}
          </div>
          {selected ? <MessageView id={selected} /> : <p className="muted">Pick a message to read it.</p>}
        </div>
      )}
    </>
  );
}
