import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "../types";

const mocks = vi.hoisted(() => ({ addDomain: vi.fn(), searchDomains: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {}, uploadToS3: vi.fn() }));

import DomainWizard from "./DomainWizard";

const tenant = { tenantId: "t1", slug: "roma", name: "Roma", status: "active" } as Tenant;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("DomainWizard", () => {
  it("offers only the test mapping outside prod", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "dev");
    mocks.addDomain.mockResolvedValue({ domain: "example.se", test: true, hosts: [
      { stage: "main", host: "example-se.test.booqy.se" }, { stage: "dev", host: "example-se.test-dev.booqy.se" }] });
    const onChanged = vi.fn();
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={onChanged} />);
    for (const text of [/Buy a new domain/, /Connect a domain/, /Just a CNAME/]) expect(screen.queryByText(text)).toBeNull();
    const add = screen.getByRole("button", { name: "Add test mapping" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Domain"), "www.example.se");
    expect(screen.getByText("example-se.test.booqy.se")).toBeInTheDocument();
    expect(screen.getByText("example-se.test-dev.booqy.se")).toBeInTheDocument();
    await userEvent.click(add);
    expect(mocks.addDomain).toHaveBeenCalledWith("t1", "www.example.se", true);
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/Mapped:/)).toBeInTheDocument();
    expect(mocks.searchDomains).not.toHaveBeenCalled();
  });

  it("offers buy, connect and CNAME in prod", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.getByText("Buy a new domain")).toBeInTheDocument();
    expect(screen.getByText("Connect a domain they already have")).toBeInTheDocument();
    expect(screen.getByText("Just a CNAME")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add test mapping" })).toBeNull();
  });
});
