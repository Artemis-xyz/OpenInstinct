import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  type ArtemisConfig,
  PATHS,
  artemisConfig,
  artemisGet,
  notWired,
} from "@agent/lib/artemis-data";

/**
 * Artemis warehouse data, over data-svc REST.
 *
 * The investor instructions assume a "warehouse first" backbone: every number
 * the analyst texts is pulled here and date-anchored, never scraped or
 * recalled. The trust contract makes the failure path as important as the
 * success path — an unwired or failing deployment returns an explicit notice
 * so the model says "let me pull it" instead of bluffing a number.
 *
 * Two request shapes need more than the obvious field, and the README calls
 * both out as silent-wrongness traps:
 *
 *   - `next_earnings_date` must carry the market session (BMO/AMC). The
 *     summary schedule fires a couple of hours after the call ends, which
 *     cannot be computed from the date alone.
 *   - `multiples_history` must span at least five years, because the
 *     one-pager quotes a 5yr range and median. A shorter window yields a
 *     wrong range, not a partial one, so a short series is reported as
 *     insufficient rather than quietly summarized.
 *
 * Secrets come only from the environment (see agent/lib/artemis-data.ts).
 */

/** Trading days of price history the earnings-preview setup needs (~3 months). */
const PREVIEW_LOOKBACK_DAYS = 90;
/** Years of multiples the one-pager's range and median require. */
const MULTIPLES_MIN_YEARS = 5;

const REQUESTS = [
  "next_earnings_date",
  "consensus_estimates",
  "financial_summary",
  "multiples_current",
  "multiples_history",
  "last_quarter_results",
  "price_history",
] as const;

type Request = (typeof REQUESTS)[number];

export function query(request: Request, ticker: string): string {
  const t = encodeURIComponent(ticker);
  switch (request) {
    case "next_earnings_date":
      // Carries the reporting session alongside the date.
      return `${PATHS.EARNINGS_PREVIEW}?ticker=${t}`;
    case "consensus_estimates":
      return `${PATHS.ESTIMATES}?ticker=${t}`;
    case "financial_summary":
      return `${PATHS.FINANCIALS}${t}/income_statement/?period=quarterly`;
    case "last_quarter_results":
      // Same series as financial_summary, but the caller wants only the most
      // recent print; `limit=1` keeps the LAST PRINT section cheap and makes
      // the distinct intent legible at the call site.
      return `${PATHS.FINANCIALS}${t}/income_statement/?period=quarterly&limit=1`;
    case "multiples_current":
      return `${PATHS.VALUATION}?ticker=${t}`;
    case "multiples_history":
      return `${PATHS.VALUATION}?ticker=${t}&history=true&years=${MULTIPLES_MIN_YEARS}`;
    case "price_history":
      // Depth enough for both the digest's prior-close move and the preview's
      // performance-since-last-print setup.
      return `${PATHS.ASSET}${t}/price/?days=${PREVIEW_LOOKBACK_DAYS}`;
  }
}

/** Rows in a payload, whatever envelope data-svc used. */
export function countRows(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    for (const key of ["data", "results", "rows", "history"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.length;
    }
  }
  return 0;
}

/**
 * Guard the two requests whose short answers are wrong rather than partial.
 * Returns a notice when the payload cannot support what the template quotes.
 */
export function insufficient(
  request: Request,
  payload: unknown
): string | null {
  if (request === "multiples_history") {
    // Monthly or coarser points over five years; far fewer means the range
    // and median the one-pager quotes would be computed off a short window.
    if (countRows(payload) < MULTIPLES_MIN_YEARS * 4) {
      return (
        `The multiples history came back shorter than ${MULTIPLES_MIN_YEARS} years. ` +
        `Do not quote a 5yr range or median from it — say the history is too short to anchor the range.`
      );
    }
  }
  if (request === "next_earnings_date") {
    const row = Array.isArray(payload) ? payload[0] : payload;
    const session = (row as Record<string, unknown> | undefined)?.["session"];
    const hasSession =
      typeof session === "string" && /bmo|amc|before|after/i.test(session);
    if (!hasSession) {
      return (
        `The earnings record came back without a market session (BMO/AMC). ` +
        `You may state the date, but do not schedule the summary from it — the fire time needs the session.`
      );
    }
  }
  return null;
}

export const artemisData = defineTool({
  description:
    "Query the Artemis warehouse for a covered equity: consensus estimates, historical financials, valuation multiples and their 5-year history (the one-pager quotes a 5yr range and median; a shorter window produces a wrong range, not an incomplete one), next future earnings date (strictly after today, including the reporting session — BMO or AMC — so the summary schedule can be timed correctly), recent quarterly results, and price history (yesterday's move for the digest; enough depth to compute performance since the last print for the preview setup). Always prefer this over web search for any financial number.",
  inputSchema: z.object({
    ticker: z.string().trim().min(1).max(12),
    request: z.enum(REQUESTS),
  }),
  async execute(input) {
    const ticker = input.ticker.toUpperCase();
    const config: ArtemisConfig | null = artemisConfig();
    if (!config) {
      return notWired(
        `Do not answer "${input.request}" for ${ticker} from memory or the open web; ` +
          `tell the user you could not pull current data.`
      );
    }

    const result = await artemisGet<unknown>(
      query(input.request, ticker),
      config
    );
    if (result.status === "unavailable") {
      return {
        status: "unavailable" as const,
        notice:
          `${result.notice} Do not answer "${input.request}" for ${ticker} from memory or the open web; ` +
          `tell the user you could not pull current data.`,
      };
    }

    const shortfall = insufficient(input.request, result.data);
    if (shortfall) {
      return {
        status: "insufficient" as const,
        ticker,
        request: input.request,
        notice: shortfall,
        data: result.data,
      };
    }

    return {
      status: "ok" as const,
      ticker,
      request: input.request,
      // The analyst must date-anchor every number it texts.
      retrievedAt: new Date().toISOString(),
      data: result.data,
    };
  },
});
