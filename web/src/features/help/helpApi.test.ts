import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCorpus } from "../../../scripts/help-corpus.mjs";
import { setCorpus } from "./corpus";

const mocks = vi.hoisted(() => ({ helpStatus: vi.fn(), helpAnswer: vi.fn() }));
vi.mock("../../api", () => ({
  api: mocks,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code = "error", message = "") {
      super(message);
    }
  },
}));

import { HELP_TIMEOUT_MS, askHelp } from "./helpApi";

describe("askHelp", () => {
  beforeAll(() => setCorpus(buildCorpus()));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("gives up on the server after 20 s and answers from the corpus", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_API_URL", "https://api.example");
    let signal: AbortSignal | undefined;
    mocks.helpAnswer.mockImplementation((_body: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const answer = askHelp("How do I add a new customer?", []);
    await vi.advanceTimersByTimeAsync(HELP_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const got = await answer;
    expect(got.actions.map((a) => a.label)).toContain("Open New customer");
    expect(HELP_TIMEOUT_MS).toBe(20_000);
  });
});
