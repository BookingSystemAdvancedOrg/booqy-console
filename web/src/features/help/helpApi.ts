import { ApiError, api } from "../../api";
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

async function locally(question: string, history: HelpTurn[]): Promise<HelpAnswer> {
  const previous = [...history].reverse().find((t) => t.role === "user")?.text ?? "";
  return answerLocally(await loadCorpus(), question, previous);
}

export async function askHelp(question: string, history: HelpTurn[]): Promise<HelpAnswer> {
  if (!apiConfigured()) return locally(question, history);
  try {
    return (await api.helpAnswer({ question, history: history.slice(-4) })).answer;
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throw new HelpLimited();
    // The server didn't answer: the corpus is here too.
    return locally(question, history);
  }
}
