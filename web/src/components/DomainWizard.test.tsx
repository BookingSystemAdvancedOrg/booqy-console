import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant, Zone } from "../types";

const mocks = vi.hoisted(() => ({
  addDomain: vi.fn(), searchDomains: vi.fn(), recordsDomain: vi.fn(), transferInCheck: vi.fn(), scanDns: vi.fn(),
  transferIn: vi.fn(), connectDomain: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {}, uploadToS3: vi.fn() }));

import DomainWizard from "./DomainWizard";

const tenant = { tenantId: "t1", slug: "roma", name: "Roma", status: "active" } as Tenant;
const testTenant = { ...tenant, siteKind: "test" } as Tenant;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("DomainWizard", () => {
  it("in dev, a customer managed from prod gets only the test mapping", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "dev");
    mocks.addDomain.mockResolvedValue({ domain: "example.se", test: true, hosts: [
      { stage: "main", host: "example-se.test.booqy.se" }, { stage: "dev", host: "example-se.test-dev.booqy.se" }] });
    const onChanged = vi.fn();
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={onChanged} />);
    expect(screen.getByText(/managed from the production console/)).toBeInTheDocument();
    for (const text of [/Buy new/, /Move to Booqy/, /Keep current registrar/]) expect(screen.queryByText(text)).toBeNull();
    const add = screen.getByRole("button", { name: "Add test mapping" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Domain"), "www.example.se");
    expect(screen.getByText("example-se.test.booqy.se")).toBeInTheDocument();
    await userEvent.click(add);
    expect(mocks.addDomain).toHaveBeenCalledWith("t1", "www.example.se", true);
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/Mapped:/)).toBeInTheDocument();
  });

  it("in dev, a test customer gets all three ways, simulated, and the direct mapping", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "dev");
    render(<DomainWizard tenant={testTenant} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    for (const text of ["Buy new", "Move to Booqy", "Keep current registrar"]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Map directly onto the test sites" })).toBeInTheDocument();
  });

  it("offers the three ways in prod, nothing simulated", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={() => {}} />);
    for (const text of ["Buy new", "Move to Booqy", "Keep current registrar"]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText("Simulated")).toBeNull();
    expect(screen.queryByRole("button", { name: "Map directly onto the test sites" })).toBeNull();
  });

  it("keep current registrar: DNS records shows what to add and the restaurant's Swedish steps", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    const zone: Partial<Zone> = {
      domain: "roma.se", mode: "records", status: "awaiting_records", canonicalHost: "www.roma.se",
      records: [{ type: "CNAME", name: "www", host: "www.roma.se", value: "d111.cloudfront.net", purpose: "site" },
                { type: "CNAME", name: "dev", host: "dev.roma.se", value: "ddev.cloudfront.net", purpose: "dev site" },
                { type: "Forwarding", name: "roma.se", host: "roma.se", value: "https://www.roma.se", purpose: "apex" }],
      restaurantSteps: "Er hemsida ska snart synas på www.roma.se.",
    };
    mocks.recordsDomain.mockResolvedValue({ zone });
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={() => {}} />);
    await userEvent.click(screen.getByText("Keep current registrar"));
    expect(screen.getByRole("button", { name: "Add records" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(screen.getByLabelText(/Their domain/), "roma.se");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(mocks.recordsDomain).toHaveBeenCalledWith("t1", "roma.se");
    expect(await screen.findByText("d111.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText("ddev.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText(/Er hemsida ska snart synas/)).toBeInTheDocument();
  });

  it("move to Booqy: an unsupported TLD points to keeping the registrar", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    mocks.transferInCheck.mockResolvedValue({ domain: "roma.nu", supported: false, transferable: false });
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={() => {}} />);
    await userEvent.click(screen.getByText("Move to Booqy"));
    await userEvent.type(screen.getByLabelText(/Their domain/), "roma.nu");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/can't be moved to Booqy/)).toBeInTheDocument();
    expect(mocks.scanDns).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep current registrar" }));
    expect(screen.getByRole("button", { name: "Change name servers" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Their domain/)).toHaveValue("roma.nu");
  });

  it("move to Booqy: DNSSEC on shows what the restaurant does, in Swedish", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    mocks.transferInCheck.mockResolvedValue({
      domain: "roma.se", supported: true, transferable: false, dnssec: true, errorCode: "dnssec", who: "restaurant",
      lastError: "DNSSEC is on for roma.se.", lastErrorSv: "Stäng av DNSSEC för roma.se hos er leverantör." });
    mocks.scanDns.mockResolvedValue({ domain: "roma.se", nameServers: [], dnssec: true, registered: true, records: [] });
    render(<DomainWizard tenant={tenant} onClose={() => {}} onChanged={() => {}} />);
    await userEvent.click(screen.getByText("Move to Booqy"));
    await userEvent.type(screen.getByLabelText(/Their domain/), "roma.se");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("DNSSEC is on for roma.se.")).toBeInTheDocument();
    expect(screen.getByText(/Stäng av DNSSEC/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move roma.se/ })).toBeNull();
  });

  it("move to Booqy: price confirmed, code given, records copied", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    const price = { amount: 16, currency: "USD" };
    mocks.transferInCheck.mockResolvedValue({ domain: "roma.com", supported: true, transferable: true, price, renewalPrice: price });
    mocks.scanDns.mockResolvedValue({ domain: "roma.com", nameServers: ["ns01.one.com"], dnssec: false, registered: true,
      records: [{ name: "roma.com", type: "MX", ttl: 3600, values: ["10 mx.one.com."], skip: null }] });
    mocks.transferIn.mockResolvedValue({ zone: { domain: "roma.com", restaurantSteps: "Nu flyttar vi roma.com till Booqy." }, supportCase: null });
    const onChanged = vi.fn();
    render(<DomainWizard tenant={{ ...tenant, legalName: "Roma AB" } as Tenant} onClose={() => {}} onChanged={onChanged} />);
    await userEvent.click(screen.getByText("Move to Booqy"));
    await userEvent.type(screen.getByLabelText(/Their domain/), "roma.com");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    const move = await screen.findByRole("button", { name: "Move roma.com" });
    expect(move).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Transfer code/), "Ab12");
    await userEvent.click(screen.getByLabelText(/Move roma.com for/));
    await userEvent.click(move);
    expect(mocks.transferIn).toHaveBeenCalledWith("t1", expect.objectContaining({
      domain: "roma.com", authCode: "Ab12", acceptedPrice: price,
      records: [{ name: "roma.com", type: "MX", ttl: 3600, values: ["10 mx.one.com."] }] }));
    expect(await screen.findByText(/Nu flyttar vi roma.com/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("Registreringsbevis upload (finding 181)", () => {
  it("tells the operator a non-PDF is the wrong file, not a Booqy fault", async () => {
    const { RegistreringsbevisUpload } = await import("./DomainWizard");
    const { fireEvent } = await import("@testing-library/react");
    render(<RegistreringsbevisUpload tenantId="t1" onKey={() => {}} onBusy={() => {}} />);
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "bevis.png", { type: "image/png" })] } });
    expect(await screen.findByText("The registreringsbevis must be a PDF.")).toBeInTheDocument();
    expect(screen.queryByText(/Booqy's side/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();
  });

  it("says At most 10 MB for a PDF that is too big", async () => {
    const { RegistreringsbevisUpload } = await import("./DomainWizard");
    const { fireEvent } = await import("@testing-library/react");
    const { api } = await import("../api");
    (api as unknown as Record<string, unknown>).documentUpload = vi.fn().mockResolvedValue({ maxBytes: 1, upload: {}, documentKey: "k" });
    render(<RegistreringsbevisUpload tenantId="t1" onKey={() => {}} onBusy={() => {}} />);
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["xx"], "bevis.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("At most 10 MB.")).toBeInTheDocument();
    expect(screen.queryByText(/Booqy's side/)).toBeNull();
  });
});
