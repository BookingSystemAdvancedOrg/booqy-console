import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plans: vi.fn(), createTenant: vi.fn(), tenant: vi.fn(), updateTenant: vi.fn(), retryOnboarding: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import NewTenantPage, { setupFailure } from "./NewTenantPage";
import { burst, confetti } from "../components/StepFlow";
import { pick, selectValue } from "../test/select";

const OWNER_TAKEN = "OwnerEmailInUse: The owner email is already registered to another tenant (t-9). Use a different address for this tenant.";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewTenantPage />} />
        <Route path="/tenants/:id" element={<p>customer page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Presses the Done button of the step that is open. */
function done() {
  act(() => { fireEvent.click(screen.getByRole("button", { name: /^Done/ })); });
}

/** Steps 1 and 2 filled in and done; step 3 open. */
function company(owner = "taken@example.se") {
  fireEvent.change(document.getElementById("f-name")!, { target: { value: "Test Pizza" } });
  done();
  fireEvent.change(document.getElementById("f-ownerName")!, { target: { value: "Lamo" } });
  fireEvent.change(document.getElementById("f-ownerEmail")!, { target: { value: owner } });
  done();
}

/** From step 3 on: contact, a plan, locations, notes. */
async function restAndCreate(pickPlan = true) {
  done();
  await screen.findByText("Starter");
  if (pickPlan) fireEvent.click(document.getElementById("f-planId")!);
  done();
  done();
  done();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
}

async function fillAndCreate() {
  company();
  await restAndCreate();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.plans.mockResolvedValue([{ planId: "starter", name: "Starter", maxLocations: 1, features: {}, priceSek: 499 }]);
  mocks.createTenant.mockResolvedValue({ tenantId: "t1", status: "provisioning" });
});
afterEach(() => vi.useRealTimers());

describe("setupFailure", () => {
  it("points a taken owner email at its field", () => {
    expect(setupFailure(OWNER_TAKEN).fields).toEqual({ ownerEmail: expect.stringContaining("another customer") });
    expect(setupFailure("Stripe.Error: card declined")).toEqual({ fields: {}, message: "card declined" });
  });
});

describe("NewTenantPage", () => {
  it("prints while setting up, then opens the customer", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    await fillAndCreate();
    expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(screen.getByText("customer page")).toBeInTheDocument();
  });

  it("goes back to the form with the owner email highlighted, then saves and retries", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "provisioning_failed", lastError: OWNER_TAKEN } });
    mocks.updateTenant.mockResolvedValue({ tenant: {} });
    mocks.retryOnboarding.mockResolvedValue({ status: "provisioning" });
    renderPage();
    await fillAndCreate();
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    const email = document.getElementById("f-ownerEmail")!;
    expect(email.closest(".field")).toHaveClass("field--error");
    expect(screen.getByText(/Setup stopped/)).toBeInTheDocument();
    expect(document.getElementById("f-slug")).toBeDisabled();
    // back on the form: nothing rises in or replays
    expect(document.querySelector(".step--enter")).toBeNull();
    expect(document.querySelector("form")).toHaveClass("form-page--back");
    fireEvent.change(email, { target: { value: "new@example.se" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save and retry" })); });
    expect(mocks.updateTenant).toHaveBeenCalledWith("t1", expect.objectContaining({ ownerEmail: "new@example.se", name: "Test Pizza" }));
    expect(mocks.retryOnboarding).toHaveBeenCalledWith("t1");
    expect(mocks.createTenant).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
  });
});

describe("NewTenantPage Free plan", () => {
  const PLANS = [
    { planId: "starter", name: "Starter", maxLocations: 1, features: {}, priceSek: 499 },
    { planId: "growth", name: "Growth", maxLocations: 3, features: { catering: true }, priceSek: 899 },
    { planId: "free", name: "Free", maxLocations: 3, features: { catering: true }, priceSek: 0, free: true },
  ];

  async function pickFree() {
    mocks.plans.mockResolvedValue(PLANS);
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    company("lamo@example.se");
    done();
    await screen.findByText("Free");
    fireEvent.click(screen.getAllByRole("radio", { name: /Free/ })[0]);
  }

  it("Free for 3 months by default; Done waits for the plan and price after it, then sends the preset", async () => {
    await pickFree();
    expect(screen.getByText("No charge")).toBeInTheDocument();
    expect(screen.getByText("Multiple locations")).toBeInTheDocument();
    expect(screen.getByText("1 location")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Free for 3 months/ })).toBeChecked();
    expect(screen.getByTestId("free-until")).toHaveTextContent(/^Free until \d{1,2} \w{3} \d{4}$/);
    expect(selectValue(screen.getByLabelText(/^Then switch to/))).toBe("");
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(1);               // Free starts at 1
    done();
    expect(screen.getByText("Pick the plan after Free")).toBeInTheDocument();
    expect(screen.getByText("Set the monthly price after Free")).toBeInTheDocument();
    expect(document.getElementById("f-locations.0.name")).toBeNull();          // still on step 4
    pick(screen.getByLabelText(/^Then switch to/), "Starter");
    expect(screen.getByLabelText(/^Monthly price after Free/)).toHaveValue(499);
    expect(screen.queryByText("Pick the plan after Free")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More locations" }));
    done(); done(); done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    const body = mocks.createTenant.mock.calls[0][0];
    expect(body).toMatchObject({ planId: "free", free: { preset: "3m", thenPlanId: "starter" }, overrides: { maxLocations: 2 } });
    expect(body.billing).toMatchObject({ priceSek: 499, collectionPreference: "card" });
  });

  it("the price after Free follows the plan after it unless the operator typed one", async () => {
    await pickFree();
    const plan = screen.getByLabelText(/^Then switch to/), price = screen.getByLabelText(/^Monthly price after Free/);
    pick(plan, "Starter");
    expect(price).toHaveValue(499);
    pick(plan, "Growth");
    expect(price).toHaveValue(899);                                            // not Starter's price on Growth
    fireEvent.change(price, { target: { value: "700" } });
    pick(plan, "Starter");
    expect(price).toHaveValue(700);                                            // an own price stays
  });

  it("the Free option error is linked to the radio group", async () => {
    await pickFree();
    fireEvent.click(screen.getByRole("radio", { name: /Free for 3 months/ }));
    const group = screen.getByRole("radiogroup", { name: "Free period" });
    expect(group).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("radio", { name: /Free for 3 months/ })).toBeVisible();   // in the a11y tree, not display: none
  });

  it("six months, then an own price after Free, invoiced with 30 days", async () => {
    await pickFree();
    fireEvent.click(screen.getByRole("radio", { name: /Free for 6 months/ }));
    pick(screen.getByLabelText(/^Then switch to/), "Growth");
    fireEvent.change(screen.getByLabelText(/^Monthly price after Free/), { target: { value: "0" } });
    done();
    expect(screen.getByText("Set the monthly price after Free")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Monthly price after Free/), { target: { value: "350" } });
    fireEvent.click(screen.getByRole("radio", { name: /Invoice \(pay within 30 days\)/ }));
    done(); done(); done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    const body = mocks.createTenant.mock.calls[0][0];
    expect(body.free).toEqual({ preset: "6m", thenPlanId: "growth" });
    expect(body.billing).toMatchObject({ priceSek: 350, collectionPreference: "invoice" });
  });

  it("the end counts from the agreement's start date", async () => {
    await pickFree();
    fireEvent.change(document.getElementById("f-billing.startDate")!, { target: { value: "2027-01-31" } });
    expect(screen.getByTestId("free-until")).toHaveTextContent("Free until 29 Apr 2027");   // 31 Jan + 3 months clamps to 30 Apr, the first paid day
    fireEvent.click(screen.getByRole("radio", { name: /Free for 6 months/ }));
    expect(screen.getByTestId("free-until")).toHaveTextContent("Free until 30 Jul 2027");
  });

  it("free until changed: no end, no plan or price needed", async () => {
    await pickFree();
    fireEvent.click(screen.getByRole("radio", { name: /Free until changed/ }));
    expect(screen.queryByLabelText(/^Then switch to/)).toBeNull();
    expect(screen.queryByTestId("free-until")).toBeNull();
    done(); done(); done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    expect(mocks.createTenant.mock.calls[0][0]).toMatchObject({ planId: "free", free: { preset: "until_changed" } });
  });
});

describe("NewTenantPage plan features", () => {
  it("labels every feature and sends a limit override", async () => {
    renderPage();
    company("lamo@example.se");
    done();
    await screen.findByText("Starter");
    fireEvent.click(document.getElementById("f-planId")!);
    expect(screen.getByLabelText("Meta ads")).not.toBeChecked();
    expect(screen.getByLabelText("Staff ledger (personalliggare)")).not.toBeChecked();
    expect(screen.queryByLabelText(/AI site edits per month/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Phone agent minutes per month/), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText("Gift cards"));
    done(); done(); done();
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    expect(mocks.createTenant).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { maxLocations: 1, features: { giftCards: true }, limits: { phoneAgentMinutesPerMonth: 10 } },
    }));
  });

  it("labels the addendum features and sends a phone minutes override only when typed", async () => {
    renderPage();
    company("lamo@example.se");
    done();
    await screen.findByText("Starter");
    fireEvent.click(document.getElementById("f-planId")!);
    expect(screen.getByLabelText("Events and tickets")).not.toBeChecked();
    expect(screen.getByLabelText("Phone agent")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/Phone agent minutes per month/), { target: { value: "300" } });
    fireEvent.click(screen.getByLabelText("Phone agent"));
    done(); done(); done();
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    expect(mocks.createTenant).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { maxLocations: 1, features: { phoneAgent: true }, limits: { phoneAgentMinutesPerMonth: 300 } },
    }));
  });

  it("sends only the plan's number of locations when nothing else is changed", async () => {
    renderPage();
    await fillAndCreate();
    expect(mocks.createTenant.mock.calls[0][0].overrides).toEqual({ maxLocations: 1 });
  });

  it("Select all ticks every feature and sends them; Clear all unticks them", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    company("lamo@example.se");
    done();
    await screen.findByText("Starter");
    fireEvent.click(document.getElementById("f-planId")!);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByLabelText("Gift cards")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByLabelText("Gift cards")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    done(); done(); done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    const features = mocks.createTenant.mock.calls[0][0].overrides.features;
    expect(Object.values(features).every(Boolean)).toBe(true);
    expect(features.giftCards).toBe(true);
  });

  it("Growth starts at 3 locations; the stepper's number is sent", async () => {
    mocks.plans.mockResolvedValue([{ planId: "starter", name: "Starter", maxLocations: 1, features: {}, priceSek: 499 },
                                   { planId: "growth", name: "Growth", maxLocations: 3, features: {}, priceSek: 899 }]);
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    company("lamo@example.se");
    done();
    fireEvent.click(await screen.findByText("Growth"));
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(3);
    fireEvent.click(screen.getByRole("button", { name: "Fewer locations" }));
    done(); done(); done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    expect(mocks.createTenant.mock.calls[0][0]).toMatchObject({ planId: "growth", overrides: { maxLocations: 2 },
                                                                billing: { priceSek: 899 } });
  });
});

describe("NewTenantPage steps", () => {
  const progress = () => screen.getByRole("progressbar", { name: "Progress" });

  it("opens only step 1, and Done on an empty step shows its errors inline instead of moving on", async () => {
    renderPage();
    expect(document.getElementById("f-name")).toBeInTheDocument();
    expect(document.getElementById("f-ownerName")).toBeNull();
    expect(progress()).toHaveAttribute("aria-valuenow", "0");
    expect(screen.queryByRole("button", { name: "Create customer" })).toBeNull();
    done();
    expect(document.getElementById("f-name")!.closest(".field")).toHaveClass("field--error");
    expect(document.getElementById("f-ownerName")).toBeNull();
    fireEvent.change(document.getElementById("f-name")!, { target: { value: "Test Pizza" } });
    expect(document.getElementById("f-name")!.closest(".field")).not.toHaveClass("field--error");
    done();
    expect(document.getElementById("f-ownerName")).toBeVisible();
    expect(document.getElementById("f-name")).not.toBeVisible();
    expect(screen.getByText("Next: Owner login")).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuenow", "50");
    expect(document.activeElement).toBe(document.getElementById("f-ownerName"));
  });

  it("fills the bar 50, 75, 88, 94, 97, 100 and shows Create only after the last step", async () => {
    renderPage();
    company("lamo@example.se");
    expect(progress()).toHaveAttribute("aria-valuenow", "75");
    done();
    expect(progress()).toHaveAttribute("aria-valuenow", "88");
    await screen.findByText("Starter");
    done();
    expect(screen.getByText("Pick a plan.")).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuenow", "88"); // no plan picked: still step 4
    fireEvent.click(document.getElementById("f-planId")!);
    done();
    expect(progress()).toHaveAttribute("aria-valuenow", "94");
    done();
    expect(progress()).toHaveAttribute("aria-valuenow", "97");
    expect(screen.queryByRole("button", { name: "Create customer" })).toBeNull();
    done();
    expect(progress()).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("button", { name: "Create customer" })).toBeEnabled();
  });

  it("Edit reopens a done step with its values, and Done folds it again", async () => {
    renderPage();
    company("lamo@example.se");
    expect(screen.getAllByText("Test Pizza").length).toBeGreaterThan(0); // in the summary
    fireEvent.click(screen.getByRole("button", { name: "Edit Restaurant company" }));
    const name = document.getElementById("f-name") as HTMLInputElement;
    expect(name).toBeVisible();
    expect(name.value).toBe("Test Pizza");
    fireEvent.change(name, { target: { value: "Roma" } });
    act(() => { fireEvent.click(document.querySelector("#step-company .step__done")!); });
    expect(name).not.toBeVisible();
    expect(screen.getByText("Roma")).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuenow", "75");
  });

  it("sends the same create payload as before, plus the number of locations", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    fireEvent.change(document.getElementById("f-name")!, { target: { value: "Test Pizza" } });
    fireEvent.change(document.getElementById("f-orgNumber")!, { target: { value: "5566778899" } });
    fireEvent.change(document.getElementById("f-address.city")!, { target: { value: "Malmö" } });
    done();
    fireEvent.change(document.getElementById("f-ownerName")!, { target: { value: "Lamo" } });
    fireEvent.change(document.getElementById("f-ownerEmail")!, { target: { value: "lamo@example.se" } });
    done();
    fireEvent.change(document.getElementById("f-senderName")!, { target: { value: "Roma" } });
    done();
    await screen.findByText("Starter");
    fireEvent.click(document.getElementById("f-planId")!);
    done();
    fireEvent.change(document.getElementById("f-locations.0.name")!, { target: { value: "Roma City" } });
    done();
    fireEvent.change(document.getElementById("f-notes")!, { target: { value: "VIP" } });
    done();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
    expect(mocks.createTenant).toHaveBeenCalledWith({
      name: "Test Pizza", slug: "test-pizza", planId: "starter", ownerName: "Lamo", ownerEmail: "lamo@example.se",
      orgNumber: "556677-8899", vatNumber: expect.stringMatching(/^SE5566778899/), senderName: "Roma", notes: "VIP",
      address: { street: "", postalCode: "", city: "Malmö" },
      locations: [{ name: "Roma City" }],
      overrides: { maxLocations: 1 },
      billing: { terms: "trial", startInvoicing: true, priceSek: 499, collectionPreference: "card" },
    });
  });

  it("with reduced motion: no sparks or confetti, and setup starts at once", async () => {
    expect(burst(document.body)).toBeNull();
    expect(confetti()).toBeNull();
    renderPage();
    await fillAndCreate();
    expect(document.querySelector(".spark-layer, .confetti-layer")).toBeNull();
    expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
  });

  it("with motion: celebrates once, ignores a second Create, then sets up", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...mm(q), matches: false })) as typeof window.matchMedia;
    const ctx = { scale() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {} };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    try {
      sessionStorage.clear();   // the finish fires once per customer per session
      mocks.tenant.mockResolvedValue({ tenant: { status: "provisioning" } });
      renderPage();
      await fillAndCreate();
      // the celebration: the button says Created, the form is still there
      const btn = screen.getByRole("button", { name: "Created" });
      expect(document.querySelector(".confetti-layer")).not.toBeNull();
      await act(async () => { fireEvent.click(btn); });
      await act(async () => { fireEvent.submit(btn.closest("form")!); });
      expect(mocks.createTenant).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("status", { name: "Setting up Test Pizza" })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
      expect(mocks.createTenant).toHaveBeenCalledTimes(1);
    } finally {
      getContext.mockRestore();
      window.matchMedia = mm;
    }
  });

  it("with motion: a burst of sparks from the tick", () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...mm(q), matches: false })) as typeof window.matchMedia;
    try {
      const layer = burst(document.body, 6);
      expect(layer).not.toBeNull();
      // jsdom has no Web Animations: the sparks clean up at once
      expect(document.querySelector(".spark-layer")).toBeNull();
    } finally {
      window.matchMedia = mm;
    }
  });
});
