import { Command } from "commander";
import { TimelockClient, type GovernorConfig } from "@nebgov/sdk";
import { loadKeypair, required, type NebGovCliConfig } from "./config.js";
import { output, type GlobalOptions } from "./output.js";
import { parseOperationId } from "./validate.js";

type CliContext = () => Promise<{ global: GlobalOptions; cfg: NebGovCliConfig }>;

/**
 * The timelock client only reads `timelockAddress` and the network settings,
 * but the SDK's `GovernorConfig` type also requires the governor and votes
 * addresses, so they are passed through as empty when unset.
 */
function timelockClient(cfg: NebGovCliConfig, simulationAccount?: string): TimelockClient {
  const config: GovernorConfig = {
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    governorAddress: cfg.governorAddress ?? "",
    timelockAddress: required(cfg, "timelockAddress"),
    votesAddress: cfg.votesAddress ?? "",
    simulationAccount,
  };
  return new TimelockClient(config);
}

/** Register the `timelock` command group in both CLI entry points. */
export function registerTimelock(program: Command, context: CliContext): void {
  const timelock = program
    .command("timelock")
    .description("Timelock commands: inspect, execute and cancel queued governance operations");

  timelock.addCommand(
    new Command("get-op")
      .description("Show a stored timelock operation")
      .argument("<id>", "operation id (64 hex characters)")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const opId = parseOperationId(id, "id");
        const operation = await timelockClient(cfg, cfg.defaultAccount).getOperation(opId);
        output({ opId, operation }, global);
      }),
  );

  timelock.addCommand(
    new Command("ready")
      .description("Check whether an operation has passed its delay and can be executed")
      .argument("<id>", "operation id (64 hex characters)")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const opId = parseOperationId(id, "id");
        const ready = await timelockClient(cfg, cfg.defaultAccount).isReady(opId);
        output({ opId, ready }, global);
      }),
  );

  timelock.addCommand(
    new Command("execute")
      .description("Execute a ready operation (the signer must be the governor)")
      .argument("<id>", "operation id (64 hex characters)")
      .requiredOption("--keypair <file>", "signing keypair file")
      .action(async (id: string, options) => {
        const { global, cfg } = await context();
        const opId = parseOperationId(id, "id");
        if (global.dryRun) {
          output({ action: "timelock.execute", opId }, global);
          return;
        }

        const signer = await loadKeypair(options.keypair);
        await timelockClient(cfg, signer.publicKey()).execute(signer, opId);
        output({ ok: true, opId, signer: signer.publicKey() }, global);
      }),
  );

  timelock.addCommand(
    new Command("cancel")
      .description("Cancel a scheduled operation (the signer must be the admin or governor)")
      .argument("<id>", "operation id (64 hex characters)")
      .requiredOption("--keypair <file>", "signing keypair file")
      .action(async (id: string, options) => {
        const { global, cfg } = await context();
        const opId = parseOperationId(id, "id");
        if (global.dryRun) {
          output({ action: "timelock.cancel", opId }, global);
          return;
        }

        const signer = await loadKeypair(options.keypair);
        await timelockClient(cfg, signer.publicKey()).cancel(signer, opId);
        output({ ok: true, opId, signer: signer.publicKey() }, global);
      }),
  );

  timelock.addCommand(
    new Command("min-delay")
      .description("Show the minimum delay, in seconds, applied to newly scheduled operations")
      .action(async () => {
        const { global, cfg } = await context();
        const minDelaySeconds = await timelockClient(cfg, cfg.defaultAccount).minDelay();
        output({ minDelaySeconds }, global);
      }),
  );

  timelock.addCommand(
    new Command("batch")
      .description("Show a stored batch operation")
      .argument("<id>", "batch operation id (64 hex characters)")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const batchOpId = parseOperationId(id, "id");
        const batch = await timelockClient(cfg, cfg.defaultAccount).getBatchOperation(batchOpId);
        output({ batchOpId, batch }, global);
      }),
  );

  timelock.addCommand(
    new Command("batch-dag")
      .description("Show the predecessor dependency graph of a batch operation")
      .argument("<id>", "batch operation id (64 hex characters)")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const batchOpId = parseOperationId(id, "id");
        const graph = await timelockClient(cfg, cfg.defaultAccount).getBatchDependencyGraph(batchOpId);
        output({ batchOpId, graph }, global);
      }),
  );
}
