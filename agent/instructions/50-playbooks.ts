import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import playbooks from "./content/playbooks.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, {
        interactive: playbooks,
        "scheduled-report": playbooks,
        "scheduled-worker": playbooks,
      }),
  },
});
