import { Command } from "commander";
import { AmendmentsClient } from "@nebgov/sdk";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadKeypair, required, resolvePath, type NebGovCliConfig } from "./config.js";
import { output, type GlobalOptions } from "./output.js";
import { parseId } from "./validate.js";

/** Adds `proposals amendments|amendment|amend` backed by the backend's amendment API. */
export function registerProposalAmendments(
  proposals: Command,
  context: () => Promise<{ global: GlobalOptions; cfg: NebGovCliConfig }>,
): void {
  const amendmentsClient = (cfg: NebGovCliConfig): AmendmentsClient =>
    new AmendmentsClient(required(cfg, "backendUrl"));

  proposals.addCommand(
    new Command("amendments")
      .description("List a proposal's amendment versions (version 0 is the original proposal)")
      .argument("<id>", "proposal id")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const proposalId = parseId(id, "id");
        output(await amendmentsClient(cfg).getAmendments(proposalId), global);
      }),
  );

  proposals.addCommand(
    new Command("amendment")
      .description(
        "Show one amendment version with a JSON-Merge-Patch diff against the version before it",
      )
      .argument("<id>", "proposal id")
      .argument("<version>", "amendment version (0 is the original proposal)")
      .action(async (id: string, version: string) => {
        const { global, cfg } = await context();
        const proposalId = parseId(id, "id");
        const versionNumber = parseId(version, "version");
        const client = amendmentsClient(cfg);
        const amendment = await client.getAmendmentVersion(proposalId, versionNumber);
        // Version 0 is the original proposal, so there is nothing earlier to diff against.
        const diffFromVersion = versionNumber > 0 ? versionNumber - 1 : null;
        const diff =
          diffFromVersion === null
            ? null
            : await client.getAmendmentDiff(proposalId, diffFromVersion, versionNumber);
        output({ amendment, diffFromVersion, diff }, global);
      }),
  );

  proposals.addCommand(
    new Command("amend")
      .description(
        "Submit an amendment draft for a proposal you proposed (publishing is a separate backend step)",
      )
      .argument("<id>", "proposal id")
      .requiredOption("--file <description.md>", "file holding the amended description")
      .requiredOption("--keypair <file>", "proposer keypair file")
      .action(async (id: string, options) => {
        const { global, cfg } = await context();
        const proposalId = parseId(id, "id");
        const description = await readFile(resolvePath(options.file), "utf8");
        if (description.trim() === "") {
          throw new Error(`${options.file} is empty; an amendment needs a description`);
        }

        if (global.dryRun) {
          output(
            {
              action: "proposals.amend",
              proposalId,
              descriptionHash: createHash("sha256").update(description).digest("hex"),
            },
            global,
          );
          return;
        }

        const signer = await loadKeypair(options.keypair);
        output(
          await amendmentsClient(cfg).submitAmendment(signer, proposalId, { description }),
          global,
        );
      }),
  );
}
