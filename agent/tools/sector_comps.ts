import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  PATHS,
  artemisConfig,
  artemisGet,
  notWired,
} from "@agent/lib/artemis-data";

/**
 * Calendarized sector comps, over data-svc REST.
 *
 * Deliberately separate from `artemisData` because it takes a peer group, not
 * a ticker. The comps-on-demand playbook (§7) delivers this as an artifact
 * link and never as texted table bubbles, so the tool returns the calculated
 * surface plus a link for the model to send — it does not format a table.
 *
 * The forbidden fallbacks are what the failure notice guards: reconstructing
 * comps from memory, the open web, or a per-ticker loop. Note the conditional
 * offer — walking names individually is only on the table when the warehouse
 * tool is itself answering, so an all-down deployment does not promise a walk
 * it cannot make.
 */
export const sectorComps = defineTool({
  description:
    "Build the calendarized comps table for a sector or peer group (CY periods, revenue growth, margins, EV/Revenue and P/E or EV/EBITDA as fits the group, with provenance), delivered to the user as an artifact link. Takes a peer group, not a single ticker. Always prefer this over web search or per-ticker reconstruction for any comps request.",
  inputSchema: z.object({
    group: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(
        'The sector or peer group, e.g. "semiconductors", "SaaS", or an explicit ticker list.'
      ),
    anchorTicker: z
      .string()
      .trim()
      .max(12)
      .optional()
      .describe("Optional ticker to anchor the takeaway on."),
  }),
  async execute(input) {
    const forbid = `Do not reconstruct comps for "${input.group}" from memory, the open web, or per-ticker loops.`;

    const config = artemisConfig();
    if (!config) {
      return notWired(
        `${forbid} Tell the user you cannot pull the calendarized comps right now. Follow the playbook rule: ` +
          `offer to walk individual names from warehouse financials only if the warehouse data tool is ` +
          `actually answering — if it is also unavailable, do not offer the walk.`
      );
    }

    const params = new URLSearchParams({ group: input.group });
    if (input.anchorTicker) {
      params.set("anchor", input.anchorTicker.toUpperCase());
    }

    const result = await artemisGet<unknown>(
      `${PATHS.COMPS_SUMMARY}?${params.toString()}`,
      config
    );
    if (result.status === "unavailable") {
      return {
        status: "unavailable" as const,
        notice:
          `${result.notice} ${forbid} If the warehouse data tool is answering, offer to walk the most ` +
          `relevant names individually from warehouse financials.`,
      };
    }

    return {
      status: "ok" as const,
      group: input.group,
      anchorTicker: input.anchorTicker?.toUpperCase(),
      retrievedAt: new Date().toISOString(),
      comps: result.data,
      // The playbook forbids texting the table; send this as a rich link with
      // the one-line takeaway in the message body.
      artifactUrl: `https://app.artemis.xyz/equities/comps?group=${encodeURIComponent(input.group)}`,
      delivery:
        "Send this as a rich link with a one-line takeaway. Never paste the table as message bubbles.",
    };
  },
});
