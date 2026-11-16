import { ApiError, api } from "../../api";
import { isBooqyFault } from "../../errors";
import { loadCorpus } from "./corpus";
import type { HelpAnswer } from "./kb";
import { answerLocally } from "./retrieve";

/**
 * GET /platform/help-assistant and POST /platform/help-assistant/answers,
 * with the operator's own token (api.ts). Without an API URL (local runs,
 * tests) or when the server fails, the corpus answers right here with the
 * same rules as the server's answer without a model.
 */

export type HelpMode = "ai" | "kb" | "off";
export type HelpTurn = { role: "user" | "assistant"; text: string };

export const apiConfigured = () => Boolean(import.meta.env.VITE_API_URL);

export async function getHelpStatus(): Promise<{ enabled: boolean; mode: HelpMode }> {
  if (!apiConfigured()) return { enabled: true, mode: "kb" };
  try {
    return await api.helpStatus();
  } catch {
    // No route (older API) or unreachable: no assistant.
    return { enabled: false, mode: "off" };
  }
}

/** 429: too many questions in a short time. */
export class HelpLimited extends Error {}

/** 403 help_assistant_off: switched off while the tab was open. No local answer then. */
export class HelpOff extends Error {}

/** A question the server hasn't answered by then is answered from the corpus. */
export const HELP_TIMEOUT_MS = 20_000;

async function locally(question: string, history: HelpTurn[]): Promise<HelpAnswer> {
  const previous = [...history].reverse().find((t) => t.role === "user")?.text ?? "";
  return answerLocally(await loadCorpus(), question, previous);
}

/**
 * The server's answer, else the corpus's. Throws HelpLimited (429), HelpOff
 * (switched off) or, when not even the corpus can answer, the error to show:
 * the server's Booqy fault (with its request id) when there was one.
 */
export async function askHelp(question: string, history: HelpTurn[]): Promise<HelpAnswer> {
  if (!apiConfigured()) return locally(question, history);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HELP_TIMEOUT_MS);
  let serverError: unknown;
  try {
    return (await api.helpAnswer({ question, history: history.slice(-4) }, ctrl.signal)).answer;
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throw new HelpLimited();
    if (err instanceof ApiError && err.status === 403 && err.code === "help_assistant_off") throw new HelpOff();
    serverError = err;
  } finally {
    clearTimeout(timer);
  }
  // The server didn't answer (or too slowly): the corpus is here too.
  try {
    return await locally(question, history);
  } catch (err) {
    throw serverError instanceof ApiError && isBooqyFault(serverError.status, serverError.code) ? serverError : err;
  }
}
