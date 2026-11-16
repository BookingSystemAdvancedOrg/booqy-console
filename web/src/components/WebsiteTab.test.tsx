import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteStatus, Tenant } from "../types";

const mocks = vi.hoisted(() => ({
  site: vi.fn(), retrySite: vi.fn(), inviteToSite: vi.fn(), redeploySite: vi.fn(), archiveSite: vi.fn(), mountSiteDomain: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import WebsiteTab from "./WebsiteTab";

const tenant = { tenantId: "t1", slug: "roma", name: "Roma", status: "active" } as Tenant;
const ready: SiteStatus = {
  enabled: true, repo: "site-roma", org: "BooqyCustomers", environment: "prod", status: "ready",
  createdAt: "2026-10-27T10:00:00Z", repoExists: true, repoUrl: "https://github.com/BooqyCustomers/site-roma",
  archived: false,
  deploys: {
    dev: { status: "completed", conclusion: "success", sha: "abc1234", at: "2026-10-27T10:05:00Z", by: "anna-dev",
           event: "push", url: "https://github.com/x/runs/1" },
    prod: null,
  },
  config: { tenantId: "t1", apiBaseUrl: "https://api.dev.example", menuImageBaseUrl: "https://img.example",
            stripePublishableKey: "pk_test_1", turnstileSiteKey: "0x4AAA", previewUrl: "https://roma.booqy.se" },
  hosting: {
    prod: { slugUrl: "https://roma.booqy.se", host: null, state: "slug_only", canMount: false },
    dev: { slugUrl: "https://roma.dev.booqy.se", state: "slug_only", canMount: false },
  },
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.site.mockResolvedValue(ready);
});

describe("WebsiteTab", () => {
  it("shows the repo, its deploys and the links", async () => {
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByRole("link", { name: "BooqyCustomers/site-roma" })).toHaveAttribute("href", ready.repoUrl);
    expect(screen.getByRole("link", { name: "roma.dev.booqy.se" })).toHaveAttribute("href", "https://roma.dev.booqy.se");
    expect(screen.getByRole("link", { name: "roma.booqy.se" })).toHaveAttribute("href", "https://roma.booqy.se");
    expect(screen.getAllByText("No own domain yet")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Mount/ })).toBeNull();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("anna-dev")).toBeInTheDocument();
    expect(screen.getByText("Not deployed yet")).toBeInTheDocument();
    expect(screen.getByText(/git clone git@github.com:BooqyCustomers\/site-roma.git/)).toBeInTheDocument();
  });

  it("keeps the .env.local values behind Show", async () => {
    render(<WebsiteTab tenant={tenant} />);
    await screen.findByText("Get started locally");
    expect(screen.queryByText(/VITE_API_BASE_URL=/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show .env.local values" }));
    expect(screen.getByText(/VITE_API_BASE_URL=https:\/\/api.dev.example/)).toBeInTheDocument();
    expect(screen.queryByText(/VITE_DEV_TENANT_SLUG/)).toBeNull();     // prod: the domain decides
    expect(screen.getByText("pk_test_1")).toBeInTheDocument();
  });

  it("invites a GitHub user and redeploys", async () => {
    mocks.inviteToSite.mockResolvedValue({ repo: "site-roma", username: "anna-dev", result: "invited" });
    mocks.redeploySite.mockResolvedValue({ repo: "site-roma", branch: "dev" });
    render(<WebsiteTab tenant={tenant} />);
    await userEvent.type(await screen.findByLabelText("GitHub username"), "anna-dev");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(mocks.inviteToSite).toHaveBeenCalledWith("t1", "anna-dev");
    expect(await screen.findByText(/Invitation sent to/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Redeploy main" }));
    expect(mocks.redeploySite).toHaveBeenCalledWith("t1");
  });

  it("archives only with the slug typed", async () => {
    mocks.archiveSite.mockResolvedValue({ repo: "site-roma", repoArchived: true });
    render(<WebsiteTab tenant={tenant} />);
    const button = await screen.findByRole("button", { name: "Archive site-roma" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type the slug/), "roma");
    await userEvent.click(button);
    expect(mocks.archiveSite).toHaveBeenCalledWith("t1", "roma");
  });

  it("offers Retry after a failed setup and says when site repos are off", async () => {
    mocks.site.mockResolvedValueOnce({ ...ready, status: "failed", lastError: "GitHub 403", repoExists: false, deploys: undefined });
    mocks.retrySite.mockResolvedValue({ status: "creating" });
    const { unmount } = render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByText("GitHub 403")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.retrySite).toHaveBeenCalledWith("t1");
    unmount();
    mocks.site.mockResolvedValue({ enabled: false });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByText(/aren't switched on/)).toBeInTheDocument();
  });

  it("shows a prod-born repo read-only in the dev console", async () => {
    mocks.site.mockResolvedValue({ ...ready, environment: "dev" });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByText(/Managed from the production console/)).toBeInTheDocument();
    for (const name of ["Invite", "Redeploy dev", "Run setup again", "Archive site-roma"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    await userEvent.click(screen.getByRole("button", { name: "Show .env.local values" }));
    expect(screen.getByText(/VITE_DEV_TENANT_SLUG=roma/)).toBeInTheDocument();
  });

  it("says a dev customer from before test sites is legacy", async () => {
    mocks.site.mockResolvedValue({ ...ready, environment: "dev", status: "legacy", kind: "legacy", repoExists: undefined,
                                   deploys: undefined, lastError: "Re-create it as a test customer." });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByText("Legacy dev customer.")).toBeInTheDocument();
    expect(screen.getByText("Re-create it as a test customer.")).toBeInTheDocument();
    expect(screen.queryByText(/Managed from the production console/)).toBeNull();
    expect(screen.queryByText("Where the site answers")).toBeNull();
  });

  it("gives a test customer full controls, both branches and both hosts", async () => {
    const run = { status: "completed", conclusion: "success", sha: "def5678", at: "2026-11-15T10:00:00Z", by: "anna-dev",
                  event: "push", url: "https://github.com/x/runs/2" };
    mocks.site.mockResolvedValue({
      ...ready, environment: "dev", kind: "test", org: "BooqyCustomersDev",
      repoUrl: "https://github.com/BooqyCustomersDev/site-roma",
      urls: { main: "https://roma.test.booqy.se", dev: "https://roma.test-dev.booqy.se" },
      deploys: { main: run, dev: null },
      hosting: {
        main: { slugUrl: "https://roma.test.booqy.se", host: "example-se.test.booqy.se", mappedFrom: "example.se", state: "live", status: "active" },
        dev: { slugUrl: "https://roma.test-dev.booqy.se", host: null, state: "slug_only" },
      },
    });
    mocks.redeploySite.mockResolvedValue({ repo: "site-roma", branch: "main" });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByRole("link", { name: "BooqyCustomersDev/site-roma" })).toBeInTheDocument();
    expect(screen.getByText("Test customer")).toBeInTheDocument();
    expect(screen.queryByText(/Managed from the production console/)).toBeNull();
    expect(screen.getAllByText("roma.test.booqy.se").length).toBeGreaterThan(0);        // deploy row target
    expect(screen.getByRole("link", { name: "roma.test-dev.booqy.se" })).toHaveAttribute("href", "https://roma.test-dev.booqy.se");
    expect(screen.getByRole("link", { name: "example-se.test.booqy.se" })).toBeInTheDocument();
    expect(screen.getByText("for example.se")).toBeInTheDocument();
    expect(screen.getByText("def5678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Redeploy main" }));
    expect(mocks.redeploySite).toHaveBeenCalledWith("t1", "main");
    await userEvent.click(screen.getByRole("button", { name: "Redeploy dev" }));
    expect(mocks.redeploySite).toHaveBeenLastCalledWith("t1", "dev");
    expect(screen.queryByRole("button", { name: /Mount/ })).toBeNull();
  });

  it("mounts the own domain per environment and says which CNAME dev needs", async () => {
    mocks.site.mockResolvedValue({ ...ready, hosting: {
      prod: { slugUrl: "https://roma.booqy.se", host: "www.roma.se", state: "live", canMount: false, dnsByBooqy: false },
      dev: { slugUrl: "https://roma.dev.booqy.se", host: "dev.roma.se", state: "not_mounted", canMount: true,
             cnameTarget: "ddev.cloudfront.net", dnsByBooqy: false },
    } });
    mocks.mountSiteDomain.mockResolvedValue({ hosting: {} });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByRole("link", { name: "www.roma.se" })).toHaveAttribute("href", "https://www.roma.se");
    expect(screen.getByText("ddev.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText(/per_tenant_sites/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mount dev.roma.se" }));
    expect(mocks.mountSiteDomain).toHaveBeenCalledWith("t1", "dev");
  });

  it("offers Retry for a failed mount", async () => {
    mocks.site.mockResolvedValue({ ...ready, hosting: {
      prod: { slugUrl: "https://roma.booqy.se", host: "www.roma.se", state: "failed", status: "validation_timeout",
              lastError: "CNAME missing", canMount: true },
      dev: { slugUrl: "https://roma.dev.booqy.se", state: "slug_only", waitsFor: "www.roma.se", canMount: false },
    } });
    mocks.mountSiteDomain.mockResolvedValue({ hosting: {} });
    render(<WebsiteTab tenant={tenant} />);
    expect(await screen.findByText("CNAME missing")).toBeInTheDocument();
    expect(screen.getByText("After www.roma.se is live in production")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.mountSiteDomain).toHaveBeenCalledWith("t1", "prod");
  });
});

describe("WebsiteTab when the first load fails (finding 180)", () => {
  it("offers Try again, which loads it", async () => {
    mocks.site.mockReset().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(ready);
    render(<WebsiteTab tenant={tenant} />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "BooqyCustomers/site-roma" })).toBeInTheDocument();
  });

  it("loads again when the page's Refresh is pressed", async () => {
    mocks.site.mockReset().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(ready);
    const { rerender } = render(<WebsiteTab tenant={tenant} refreshed={0} />);
    await screen.findByRole("button", { name: "Try again" });
    rerender(<WebsiteTab tenant={tenant} refreshed={1} />);
    expect(await screen.findByRole("link", { name: "BooqyCustomers/site-roma" })).toBeInTheDocument();
  });

  it("opened after an earlier Refresh, or refreshed mid load, loads once", async () => {
    let answer: (v: SiteStatus) => void = () => {};
    mocks.site.mockReset().mockReturnValue(new Promise<SiteStatus>((r) => { answer = r; }));
    const { rerender } = render(<WebsiteTab tenant={tenant} refreshed={2} />);
    rerender(<WebsiteTab tenant={tenant} refreshed={3} />);
    answer(ready);
    expect(await screen.findByRole("link", { name: "BooqyCustomers/site-roma" })).toBeInTheDocument();
    expect(mocks.site).toHaveBeenCalledTimes(1);
  });
});
