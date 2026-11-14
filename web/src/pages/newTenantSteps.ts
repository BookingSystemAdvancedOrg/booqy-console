/** The New customer form as steps: what each step asks for, when it counts
 * as done, and how full the progress bar is. Pure, so it is tested alone. */

export const STEPS = [
  { id: "company", title: "Restaurant company" },
  { id: "owner", title: "Owner login" },
  { id: "contact", title: "Contact & communication" },
  { id: "plan", title: "Plan & invoicing" },
  { id: "locations", title: "Locations" },
  { id: "notes", title: "Internal notes" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

/** Front-loaded: the first step fills half the bar, each next one half of
 * what is left, and the last one fills it (6 steps: 50, 75, 87.5, 93.75,
 * 96.875, 100). */
export function progressPct(done: number, total: number = STEPS.length): number {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return 100;
  return 100 * (1 - 0.5 ** done);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailProblem = (v: string) => (v && !EMAIL.test(v.trim()) ? "Not an email address" : undefined);

export interface StepInput {
  name: string; slug: string; orgProblem?: string;
  ownerName: string; ownerEmail: string;
  contactEmail: string; billingEmail: string; replyToEmail: string;
  planId: string;
  locationCount: number; maxLocations: number;
}

/** What stops a step from being done, by the field key the form uses
 * (the same keys the API reports). Empty = the step is done. */
export function stepProblems(step: StepId, s: StepInput): Record<string, string> {
  const out: Record<string, string | undefined> = {};
  if (step === "company") {
    if (!s.name.trim()) out.name = "Required";
    // the slug fills itself in from the name: only its own problem once there is a name
    if (s.name.trim() && !s.slug) out.slug = "Required";
    out.orgNumber = s.orgProblem;
  } else if (step === "owner") {
    if (!s.ownerName.trim()) out.ownerName = "Required";
    out.ownerEmail = s.ownerEmail.trim() ? emailProblem(s.ownerEmail) : "Required";
  } else if (step === "contact") {
    out.contactEmail = emailProblem(s.contactEmail);
    out.billingEmail = emailProblem(s.billingEmail);
    out.replyToEmail = emailProblem(s.replyToEmail);
  } else if (step === "plan") {
    if (!s.planId) out.planId = "Pick a plan";
  } else if (step === "locations") {
    if (s.locationCount > s.maxLocations) out.locations = `The plan allows ${s.maxLocations}: remove one or raise "Locations allowed"`;
  }
  return Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => !!e[1]));
}

/** The step a field (as the API names it) lives in, so an error opens it. */
export function stepOfField(key: string): number {
  const k = key.split(".")[0];
  if (["name", "slug", "legalName", "orgNumber", "vatNumber", "address"].includes(k)) return 0;
  if (k.startsWith("owner")) return 1;
  if (["contactEmail", "contactPhone", "billingEmail", "senderName", "replyToEmail"].includes(k)) return 2;
  if (k === "planId" || k === "overrides" || k === "billing") return 3;
  if (k === "locations") return 4;
  if (k === "notes") return 5;
  return -1;
}
