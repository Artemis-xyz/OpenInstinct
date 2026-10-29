import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import investorFramework from "./content/investor-framework.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, {
        interactive: investorFramework,
        "scheduled-report": investorFramework,
        "scheduled-worker": investorFramework,
      }),
  },
});
