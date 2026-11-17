import { request, type ErrorMessages } from "../../api";

/** Operator route H9 (CONTRACTS.md 6.H), forwarded by platform-tenants to personalliggare; audited per call. */

export interface LedgerExport {
  locationId: string;
  from: string;
  to: string;
  format: "csv";
  filename: string;
  count: number;
  chainOk: boolean;
  firstBadSeq?: number;
  content: string;
}

const messages: ErrorMessages = (status) =>
  status === 404 ? "There is no staff ledger for this location, or the staff ledger isn't switched on here."
  : status === 400 ? "Check the dates. From must be on or before To, at most one year apart."
  : status === 503 ? "The staff ledger didn't answer. Try again in a minute."
  : undefined;

/** Through api.ts: busy bar, 401 refresh and request id, as every call. */
export function exportLedger(tenantId: string, q: { locationId: string; from: string; to: string }): Promise<LedgerExport> {
  const query = new URLSearchParams(q).toString();
  return request<LedgerExport>("GET", `/platform/tenants/${encodeURIComponent(tenantId)}/personalliggare/export?${query}`, undefined, { messages });
}
