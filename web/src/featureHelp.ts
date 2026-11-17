import type { FeatureKey } from "./contracts";

/**
 * What each plan feature is, in plain words: `line` under the name (about 10 words at most),
 * `about` and `example` in the "?" popover. Console owned (FEATURE_LABELS stays generated).
 * Typed by FeatureKey, so a new contract feature without text fails the type check.
 * Facts: online only (no till or card readers), personalliggare is under legal review.
 */
export type FeatureHelp = { line: string; about: string; example: string };

export const FEATURE_HELP: Record<FeatureKey, FeatureHelp> = {
  reservations: {
    line: "Guests book a table online, day and night.",
    about: "Guests pick a day, time and party size on the restaurant's site. Staff see every booking and the table plan in Booqy Admin, and a table can never be booked twice. A card guarantee can charge a fee for a no-show.",
    example: "A couple books a table for two on Friday at 19:00 from their phone while the restaurant is closed. It is in the bookings list the next morning.",
  },
  ordering: {
    line: "Guests order food online, for pickup or at the table.",
    about: "Guests order from the menu on the restaurant's site and pay online, then get an SMS when the food is ready to pick up. At the table, guests scan the table's QR code and order from their phone; staff bring the food.",
    example: "A guest orders two pizzas at 17:30 on the way home, pays by card and collects them when the \"ready\" SMS arrives.",
  },
  catering: {
    line: "Guests ask for catering offers and sign them online.",
    about: "Guests price a catering order in a calculator on the site and send a request. The restaurant sends an offer and the guest signs it with BankID. A private guest then pays online; a company gets an invoice.",
    example: "An office asks for lunch for 40 people on 12 June. The restaurant sends an offer, the office manager signs with BankID and the invoice goes out.",
  },
  marketing: {
    line: "See site visits and send email offers to guests.",
    about: "Counts visits to the restaurant's site without cookies and shows which campaign brought them. Sends email campaigns only to guests who said yes to offers when they booked or ordered, with a one click unsubscribe in every email.",
    example: "Before Mother's Day the restaurant emails its brunch menu to every guest who said yes to offers.",
  },
  metaAds: {
    line: "Run paid ads on Facebook and Instagram.",
    about: "The restaurant connects its Meta account and creates ad campaigns in Booqy Admin, with help writing the text. Every campaign has an end date and a budget, and spend per month has a cap, so costs never run away.",
    example: "A pizzeria spends 1 500 SEK over two weeks on an Instagram ad for its new lunch deal.",
  },
  siteBuilder: {
    line: "Build and publish the restaurant's own website.",
    about: "The restaurant edits its site in Booqy Admin: pages, texts, pictures and colours, with booking and ordering built in. Changes stay a draft until they press publish, and an older version can be put back.",
    example: "The owner adds a photo of the summer terrace and new opening hours, checks the draft, then publishes.",
  },
  guestCrm: {
    line: "One profile per guest, built from bookings and orders.",
    about: "Booqy joins each guest's bookings and orders into one profile under Gäster in Booqy Admin, so the restaurant sees who comes often and who has not been back. Guests can be grouped by rules and a group used for email offers.",
    example: "The owner lists guests who have not been here in 90 days and want offers, then sends them a welcome back email.",
  },
  googleBusiness: {
    line: "Keeps Google opening hours right and asks for reviews.",
    about: "The restaurant links its Google Business Profile. Opening hours set in Booqy are sent to Google, and guests can get a message after their visit asking for a Google review. No guest data is sent to Google.",
    example: "The restaurant is closed on Midsummer Eve. The owner sets it in Booqy and Google Maps shows it as closed that day.",
  },
  giftCards: {
    line: "Sell gift cards online that guests pay with later.",
    about: "Guests buy a gift card on the restaurant's site and the code is sent by email. The value is used to pay online, and the card ends after a set number of months. Sales and use go into the accounting.",
    example: "A guest buys a 500 SEK gift card as a birthday present; the friend uses it later to pay online.",
  },
  waitlist: {
    line: "A queue for walk-in guests when every table is full.",
    about: "Staff put walk-in guests in a queue. When a table is free, the guest gets a text with a link and the table is held for them for a short time. Guests follow their place in the queue on their phone.",
    example: "On a busy Saturday a group of four waits at the bar, and Booqy texts them when a table is free.",
  },
  socialPosting: {
    line: "Post to Facebook and Instagram from Booqy.",
    about: "The restaurant writes a post, often from a dish or today's special, picks Facebook, Instagram or both, and posts now or at a set time. It uses the same Meta connection as Meta ads. These are normal posts, not paid ads.",
    example: "On Monday the owner schedules this week's lunch menu to go out at 10:00 on both channels.",
  },
  personalliggare: {
    line: "Staff check in and out when they work.",
    about: "A digital staff ledger: staff check in and out, and the restaurant can show who is working right now when Skatteverket visits. Nothing is changed afterwards; a correction is a new line. Still under legal review.",
    example: "An inspector visits at 18:00 and the manager shows the list of everyone checked in on site.",
  },
  accountingSync: {
    line: "Sends each day's sales to Fortnox or Visma.",
    about: "Booqy builds one entry per location and day from orders, catering, gift cards and Stripe fees and payouts, and posts it straight into Fortnox or Visma. No files to export by hand; the file export stays as a backup.",
    example: "The day after, yesterday's online sales and card fees are in the restaurant's Fortnox, ready for the accountant.",
  },
  dishMargin: {
    line: "See what each dish earns after ingredient costs.",
    about: "The owner enters what the ingredients for one portion cost. Booqy then shows the margin of every dish in Statistik, from what was sold. Staff never see costs or margins.",
    example: "The owner sees the burger sells the most but earns the least, and raises its price by 10 SEK.",
  },
  events: {
    line: "Sell tickets to events, like a quiz or jazz night.",
    about: "The restaurant creates an event with dates, ticket types and prices, and guests buy tickets online. Each ticket has a QR code that staff scan at the door. Guests can give a ticket away, and if the restaurant allows it, resell it at the price they paid.",
    example: "A bar sells 60 tickets at 150 SEK for a jazz evening, and staff scan each ticket at the door.",
  },
  phoneAgent: {
    line: "An AI answers the phone and books tables.",
    about: "Calls to the restaurant can go to an AI assistant that answers, tells the caller it is an AI, and books tables. When it cannot help, it saves a callback for staff. Minutes per month are set by the plan.",
    example: "During the lunch rush the phone rings and the assistant books a table for six at 19:30 while staff keep serving.",
  },
};
