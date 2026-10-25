import type { WebsiteOverview } from "../website";

/** A realistic month of booqy.se statistics, for the page test (and a mock API). */
export function websiteFixture(over: Partial<WebsiteOverview> = {}): WebsiteOverview {
  const series = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(2026, 8, 26 + i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const visits = 40 + ((i * 37) % 55);
    return { day, visitors: Math.round(visits * 0.82), visits, pageviews: visits * 2, conversions: i % 6 === 0 ? 1 : 0 };
  });
  return {
    enabled: true,
    period: { from: series[0].day, to: series[29].day, days: 30 },
    previous: { from: "2026-08-27", to: "2026-09-25" },
    asOf: "2026-10-25T09:15:00+00:00",
    live: { minutes: 30, visitors: 3 },
    kpis: { visitors: 1612, visits: 1966, pageviews: 3932, conversions: 5, convertedVisits: 5, conversionRate: 0.25,
      bounceRate: 48.2, avgEngagedSeconds: 74, pagesPerVisit: 2 },
    previousKpis: { visitors: 1420, visits: 1730, pageviews: 3600, conversions: 3, convertedVisits: 3, conversionRate: 0.17,
      bounceRate: 52.4, avgEngagedSeconds: 61, pagesPerVisit: 2.08 },
    series,
    hours: [2, 1, 0, 0, 1, 3, 12, 40, 98, 160, 182, 170, 150, 166, 175, 160, 140, 120, 110, 98, 80, 52, 30, 16],
    scroll: { "0": 220, "25": 410, "50": 380, "75": 300, "100": 520 },
    events: { cta: [{ key: "/demo", count: 140 }, { key: "restaurang.booqy.se", count: 22 }], tab: [{ key: "mat", count: 88 }, { key: "catering", count: 61 }] },
    breakdowns: {
      sources: [{ key: "search", visits: 980, conversions: 3, bounces: 420 }, { key: "direct", visits: 510, conversions: 1, bounces: 260 },
        { key: "campaign", visits: 300, conversions: 1, bounces: 170 }, { key: "social", visits: 120, conversions: 0, bounces: 70 },
        { key: "referral", visits: 56, conversions: 0, bounces: 28 }],
      referrers: [{ key: "google.se", visits: 900, conversions: 3, bounces: 380 }, { key: "l.facebook.com", visits: 80, conversions: 0, bounces: 50 }],
      campaigns: [{ key: "facebook|paid|host-2026", visits: 220, conversions: 1, bounces: 120 }, { key: "nyhetsbrev|email|oktober", visits: 80, conversions: 0, bounces: 50 }],
      contents: [{ key: "video", visits: 140, conversions: 1, bounces: 70 }],
      terms: [],
      landing: [{ key: "/", visits: 1200, conversions: 3, bounces: 560 }, { key: "/bordsbokning", visits: 400, conversions: 1, bounces: 200 },
        { key: "/catering", visits: 366, conversions: 1, bounces: 188 }],
      pages: [{ key: "/", pageviews: 1800, avgSeconds: 52 }, { key: "/demo", pageviews: 420, avgSeconds: 95 }, { key: "/bordsbokning", pageviews: 700, avgSeconds: 61 }],
      countries: [{ key: "SE", visits: 1800, conversions: 5, bounces: 860 }, { key: "NO", visits: 90, conversions: 0, bounces: 50 }, { key: "FI", visits: 76, conversions: 0, bounces: 38 }],
      regions: [{ key: "SE|Stockholms län", visits: 900, conversions: 3, bounces: 400 }, { key: "SE|Västra Götalands län", visits: 400, conversions: 1, bounces: 200 }],
      cities: [{ key: "SE|Stockholm", visits: 700, conversions: 2, bounces: 300 }, { key: "SE|Göteborg", visits: 300, conversions: 1, bounces: 150 }],
      devices: [{ key: "mobile", visits: 1200, conversions: 2, bounces: 640 }, { key: "desktop", visits: 650, conversions: 3, bounces: 250 }, { key: "tablet", visits: 116, conversions: 0, bounces: 58 }],
      browsers: [{ key: "Safari", visits: 900, conversions: 2, bounces: 420 }, { key: "Chrome", visits: 800, conversions: 3, bounces: 380 }],
      os: [{ key: "iOS", visits: 880, conversions: 2, bounces: 410 }, { key: "Windows", visits: 500, conversions: 2, bounces: 200 }],
      languages: [{ key: "sv", visits: 1800, conversions: 5, bounces: 850 }, { key: "en", visits: 166, conversions: 0, bounces: 98 }],
    },
    previousSources: { search: { key: "search", visits: 800, conversions: 2, bounces: 380 }, direct: { key: "direct", visits: 560, conversions: 1, bounces: 280 } },
    ...over,
  };
}
