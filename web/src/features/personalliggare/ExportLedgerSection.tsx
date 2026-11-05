import { useState } from "react";
import { api } from "../../api";
import { Card, ErrorNotice, Field, Notice, useAction, useLoad } from "../../components/ui";
import { SaveButton } from "../../components/save";
import { exportLedger, type LedgerExport } from "./api";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function download(file: LedgerExport) {
  const url = URL.createObjectURL(new Blob([file.content], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Tenant > Suspend or offboard: export the staff ledger (personalliggare, H9) as CSV.
 * Always shown, offboarded tenants too: the ledger outlives the subscription. Every export is audited.
 */
export default function ExportLedgerSection({ tenantId }: { tenantId: string }) {
  const { data } = useLoad(() => api.tenant(tenantId), [tenantId]);
  const locations = data?.locations ?? [];
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState(() => `${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [result, setResult] = useState<LedgerExport | null>(null);
  const a = useAction();
  const chosen = locationId || locations[0]?.locationId || "";

  return (
    <Card title="Export staff ledger">
      <p className="muted">
        The staff ledger (personalliggare) is kept after offboarding. Download one location's records as CSV,
        with the result of the tamper check. Each export is written to the audit log.
      </p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const file = await a.run(() => exportLedger(tenantId, { locationId: chosen, from, to }));
        if (file) {
          setResult(file);
          download(file);
        }
      }}>
        <div className="grid">
        <Field label="Location" required>
          {locations.length > 0 ? (
            <select className="input" value={chosen} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => <option key={l.locationId} value={l.locationId}>{l.name || l.locationId}</option>)}
            </select>
          ) : (
            <input className="input mono" value={locationId} placeholder="Location id" onChange={(e) => setLocationId(e.target.value)} />
          )}
        </Field>
        <Field label="From" required error={a.fields.from}>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" required>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        </div>
        <SaveButton label="Download CSV" busy={a.busy} busyLabel="Exporting…" done={a.done} doneLabel="Downloaded"
                    disabled={!chosen || !from || !to} />
      </form>
      {a.error ? <ErrorNotice error={a.error} /> : null}
      {result && (
        result.chainOk
          ? <Notice kind="ok">{result.count} records exported. Tamper check: the chain is intact.</Notice>
          : <Notice kind="warn">{result.count} records exported. Tamper check failed at record {result.firstBadSeq}: tell the engineering team before sharing the file.</Notice>
      )}
    </Card>
  );
}
