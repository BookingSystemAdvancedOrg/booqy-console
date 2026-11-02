import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./features/site-builder/SiteBuilderSection", () => ({
  default: ({ tenantId }: { tenantId: string }) => <p>site builder for {tenantId}</p>,
}));
vi.mock("./features/personalliggare/ExportLedgerSection", () => ({ default: () => <p>ledger export</p> }));

import { SLOT_LOADERS, Slot, slotOn } from "./slots";
import { CONSOLE_SLOTS } from "./contracts";

describe("console slots", () => {
  it("has a loader for every contract slot", () => {
    expect(Object.keys(SLOT_LOADERS).sort()).toEqual(Object.keys(CONSOLE_SLOTS).sort());
  });

  it("renders nothing while the feature is off", () => {
    const { container } = render(<Slot id="tenant.website.siteBuilder" features={{ siteBuilder: false }} props={{ tenantId: "t1" }} />);
    expect(container).toBeEmptyDOMElement();
    expect(slotOn("tenant.integrations.metaAds", {})).toBe(false);
  });

  it("loads the feature's component with its props when on", async () => {
    render(<Slot id="tenant.website.siteBuilder" features={{ siteBuilder: true }} props={{ tenantId: "t1" }} />);
    expect(await screen.findByText("site builder for t1")).toBeInTheDocument();
  });

  it("always shows a slot without a feature", async () => {
    render(<Slot id="tenant.offboard.personalliggare" props={{ tenantId: "t1" }} />);
    expect(await screen.findByText("ledger export")).toBeInTheDocument();
  });

  it("the Run 0 placeholders render nothing", async () => {
    const { default: C } = await SLOT_LOADERS["tenant.integrations.metaAds"]();
    const { container } = render(<C tenantId="t1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gates the phone agent slots on phoneAgent", () => {
    expect(slotOn("tenant.integrations.phoneAgent", {})).toBe(false);
    expect(slotOn("tenant.integrations.phoneAgent", { phoneAgent: true })).toBe(true);
  });

  it("the platform-wide settings card has no tenant feature (CONTRACTS.md 8.3, like settings.metaAds)", () => {
    expect(CONSOLE_SLOTS["settings.phoneAgent"].feature).toBeNull();
    expect(slotOn("settings.phoneAgent")).toBe(true);
  });

  it("the addendum placeholders render nothing", async () => {
    const { default: Section } = await SLOT_LOADERS["tenant.integrations.phoneAgent"]();
    const { default: Card } = await SLOT_LOADERS["settings.phoneAgent"]();
    expect(render(<Section tenantId="t1" />).container).toBeEmptyDOMElement();
    expect(render(<Card />).container).toBeEmptyDOMElement();
  });
});
