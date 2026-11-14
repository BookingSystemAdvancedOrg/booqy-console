import { describe, expect, it } from "vitest";
import { buildCorpus } from "../../../scripts/help-corpus.mjs";
import cases from "./helpKbCases.json";
import { OWNER_TEXT, REFUSE_TEXT, UNKNOWN_TEXT, answerLocally } from "./retrieve";

/**
 * The eval: real operator questions against the corpus built from the code
 * right now. The same questions run against the server
 * (application/tests/test_help_assistant.py, test_eval_console). A new field,
 * page or changed text that breaks an answer shows up here.
 */

type Expect = {
  source?: string;
  route?: string;
  hash?: string;
  query?: Record<string, string>;
  highlight?: string[];
  live?: string | null;
  answer?: "owner" | "refuse" | "unknown";
};
type Case = { question: string; role: "operator"; features: "all"; expect: Expect };

const corpus = buildCorpus();

describe("help eval (console)", () => {
  it("has at least 40 questions", () => expect(cases.length).toBeGreaterThanOrEqual(40));

  it.each(cases as Case[])("$question", (c) => {
    const a = answerLocally(corpus, c.question);
    const e = c.expect;
    if (e.answer) {
      expect(a.known).toBe(false);
      expect(a.steps).toEqual([]);
      expect(a.text).toBe({ owner: OWNER_TEXT, refuse: REFUSE_TEXT, unknown: UNKNOWN_TEXT }[e.answer]);
      return;
    }
    expect(a.known).toBe(true);
    if (e.source) expect(a.sources[0]).toBe(e.source);
    const act = a.actions[0];
    if (e.route || e.hash || e.query || e.highlight) expect(act, "a button").toBeTruthy();
    if (e.route) expect(act.to).toBe(e.route);
    if (e.hash) expect(act.hash).toBe(e.hash);
    if (e.query) expect(act.query).toEqual(e.query);
    for (const h of e.highlight ?? []) expect(act.highlight ?? []).toContain(h);
    if (e.live !== undefined) expect(a.live?.metric ?? null).toBe(e.live);
  });
});

describe("follow-ups (console)", () => {
  it("a short question that stands on its own is not read with the previous one", () => {
    const a = answerLocally(corpus, "Where is the outbox?", "How do I add another operator?");
    expect(a.known).toBe(true);
    expect(a.sources[0]).not.toBe("operator-add");
  });
});
