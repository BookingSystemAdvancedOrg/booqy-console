import type { Plan } from "../types";

/** A plan's display name from the plans list (as the Plan tab shows it); the id capitalised until the list is there. */
export function planName(planId: string | null | undefined, plans?: Plan[] | null): string {
  if (!planId) return "";
  return plans?.find((p) => p.planId === planId)?.name || planId.charAt(0).toUpperCase() + planId.slice(1);
}
