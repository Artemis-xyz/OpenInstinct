import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  PATHS,
  artemisConfig,
  artemisGet,
  notWired,
} from "@agent/lib/artemis-data";

/**
 * The user's synced portfolio holdings, over data-svc REST.
 *
 * Onboarding's PRIMARY intake (playbooks.md §1): the user connects a brokerage
 * once via Plaid on the Artemis web portfolio, holdings sync server-side, and
 * this reads them for the book updates and coverage derivation. The agent adds
 * no Plaid integration of its own — it reads rows the web app already synced.
 *
 * Takes no ticker: the user is ambient. The failure path matters as much as
 * the success path — an unreadable book must degrade to watchlist mode on
 * typed tickers, never to invented holdings.
 */
export const portfolioHoldings = defineTool({
  description:
    "Read the user's synced portfolio holdings (positions, market values, cost bases, asset classes) from the Artemis portfolio — the holdings the user connected via Plaid on the web portfolio page, plus manual entries. Use for onboarding confirmation, the three daily book updates, and any 'how's my book' question. Takes no arguments; the caller's identity selects the portfolio.",
  inputSchema: z.object({}),
  async execute() {
    const fallback =
      `Tell the user you cannot read their connected portfolio yet; fall back to typed tickers or a screenshot ` +
      `and run coverage and book updates in watchlist mode. Never invent holdings or pretend the book was read.`;

    const config = artemisConfig();
    if (!config) return notWired(fallback);

    const result = await artemisGet<unknown>(PATHS.HOLDINGS, config);
    if (result.status === "unavailable") {
      return {
        status: "unavailable" as const,
        notice: `${result.notice} ${fallback}`,
      };
    }

    return {
      status: "ok" as const,
      // Position sizes drive tone, so the digest must say when they were read.
      retrievedAt: new Date().toISOString(),
      holdings: result.data,
    };
  },
});
