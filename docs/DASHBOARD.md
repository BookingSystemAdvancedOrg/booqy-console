# Finance dashboard: what goes where

The console's Finance page (`web/src/pages/FinancePage.tsx`, Overview tab) is
Booqy's own dashboard. Its order follows the questions the founder asks, in
the order they ask them. Put a new figure where its question belongs.

Filters (billing period 25th to 24th, number of periods, inactive customers,
one customer or location), the CSV exports, Refresh, Import from Stripe and
Rebuild stay at the top, as they set the scope for everything below.

## 1. "Is recurring revenue growing, and is the cash coming in?"

`kpis--lead`, four larger tiles, 2 x 2 on a phone:

- **MRR**, change since the period started, with the annual run rate.
- **Paying customers**, with new and churned (churn %) in the period, against
  the period before.
- **Collected**, and the share of what is invoiced.
- **Outstanding**, amber when anything is open, with the number of customers
  past due.

## 2. "Are we profitable?"

The hero: **gross margin** (red at a loss) with revenue, AWS cost and the
allocated part, plus the rings for where revenue goes, what the AWS cost is
for and how much is collected.

## 3. "What needs me?"

- **Needs attention**: customers past due and active customers without a
  subscription, each linking to their Billing tab.
- **The nightly job reported problems**: warnings from the finance job, which
  mean some figures above may be incomplete.

## 4. "Why, and who?"

- Revenue and unit economics (`kpis--units`, two rows of three): revenue,
  AWS cost or bill, ARPU, cost per booking, cost per order, SMS.
- Charts: MRR over time first, then revenue against AWS cost.
- Best and weakest margin per customer, then the sortable customer table.

## Rules for new figures

- Colours come from `web/src/trend.ts` (green better, red worse, neutral when
  there is nothing to compare or the change is noise); the text change always
  stands beside the colour.
- Figures count up with `CountUp`; reduced motion shows the final value.
- A new action item goes in "Needs attention", and if it is about money also
  as a count in the lead row's sub text, not as a new tile.

## Proposals (not in `GET /finance/overview` today)

- **Net MRR movement**: new, expansion, contraction and churned MRR for the
  period (today only MRR at the start and end of the series).
- **Net revenue retention** and **trial to paid conversion**.
- **Failed Stripe payments** (count and amount) separate from outstanding
  invoices, and days sales outstanding.
- **Failed operational jobs**: onboarding runs, print jobs and outbox mail that
  failed, as one count on this page (each lives on its own page today).
- **AWS cost forecast** for the rest of the billing period.
