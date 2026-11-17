import type { BillingStatus } from "./types";

/** The agreement phase as the API reports it (finance._billing_status and
 * billing.phase), in words. One map for the Finance table and the Billing tab. */
export const BILLING_PHASE_TEXT: Record<BillingStatus, string> = {
  none: "No agreement", scheduled: "Starts later", active: "Active", ending: "Ending", ended: "Ended", past_due: "Past due",
};

export function billingPhaseText(status: string | null | undefined): string {
  if (!status) return BILLING_PHASE_TEXT.none;
  return (BILLING_PHASE_TEXT as Record<string, string>)[status] ?? status;
}
