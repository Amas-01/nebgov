import { Command } from "commander";
import { TreasuryStreamsClient } from "@nebgov/sdk";
import { loadKeypair, required, type NebGovCliConfig } from "./config.js";
import { output, type GlobalOptions } from "./output.js";
import { parseAddress, parseContractAddress, parseId, parsePositiveInt } from "./validate.js";

type CliContext = () => Promise<{ global: GlobalOptions; cfg: NebGovCliConfig }>;

function streamsClient(cfg: NebGovCliConfig, simulationAccount?: string): TreasuryStreamsClient {
  return new TreasuryStreamsClient({
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    treasuryStreamsAddress: parseContractAddress(
      required(cfg, "treasuryStreamsAddress"),
      "treasuryStreamsAddress",
    ),
    simulationAccount,
  });
}

/**
 * Register the `recurring-streams` group for the standalone treasury-streams
 * contract, in both CLI entry points.
 */
export function registerRecurringStreams(program: Command, context: CliContext): void {
  const streams = program
    .command("recurring-streams")
    .description("Recurring treasury streams: inspect, execute, pause, resume and cancel");

  streams.addCommand(
    new Command("list")
      .description("List streams that have not been cancelled, in creation order")
      .option("--offset <number>", "number of streams to skip", "0")
      .option("--limit <number>", "max streams per page", "50")
      .action(async (options) => {
        const { global, cfg } = await context();
        const offset = parseId(options.offset, "offset");
        const limit = parsePositiveInt(options.limit, "limit");
        const client = streamsClient(cfg, cfg.defaultAccount);
        output(await client.getActiveStreams(offset, limit), global);
      }),
  );

  streams.addCommand(
    new Command("get")
      .description("Show one stream")
      .argument("<id>", "stream id")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const streamId = parseId(id, "id");
        output(await streamsClient(cfg, cfg.defaultAccount).getStream(streamId), global);
      }),
  );

  streams.addCommand(
    new Command("claimable")
      .description("Show the amount executing a stream would pay right now (0 if nothing is due)")
      .argument("<id>", "stream id")
      .action(async (id: string) => {
        const { global, cfg } = await context();
        const streamId = parseId(id, "id");
        const claimable = await streamsClient(cfg, cfg.defaultAccount).getClaimableAmount(streamId);
        output({ streamId, claimable }, global);
      }),
  );

  streams.addCommand(
    new Command("by-recipient")
      .description("List every stream created for a recipient, including cancelled ones")
      .argument("<address>", "recipient address")
      .option("--offset <number>", "number of streams to skip", "0")
      .option("--limit <number>", "max streams per page", "50")
      .action(async (address: string, options) => {
        const { global, cfg } = await context();
        const recipient = parseAddress(address, "address");
        const offset = parseId(options.offset, "offset");
        const limit = parsePositiveInt(options.limit, "limit");
        const client = streamsClient(cfg, cfg.defaultAccount);
        output(await client.getStreamsForRecipient(recipient, offset, limit), global);
      }),
  );

  streams.addCommand(
    new Command("execute")
      .description("Pay every whole interval that has come due (permissionless)")
      .argument("<id>", "stream id")
      .requiredOption("--keypair <file>", "executor keypair file")
      .action(async (id: string, options) => {
        const { global, cfg } = await context();
        const streamId = parseId(id, "id");
        if (global.dryRun) {
          output({ action: "recurring-streams.execute", streamId }, global);
          return;
        }

        const signer = await loadKeypair(options.keypair);
        const hash = await streamsClient(cfg, signer.publicKey()).executeStream(signer, streamId);
        output({ ok: true, streamId, executor: signer.publicKey(), hash }, global);
      }),
  );

  for (const [name, method, description] of [
    ["pause", "pauseStream", "Pause a stream (callable by the treasury or the stream's creator)"],
    ["resume", "resumeStream", "Resume a paused stream (callable by the treasury or the stream's creator)"],
    [
      "cancel",
      "cancelStream",
      "Cancel a stream permanently. Execute any due intervals first, since they are forfeited",
    ],
  ] as const) {
    streams.addCommand(
      new Command(name)
        .description(description)
        .argument("<id>", "stream id")
        .requiredOption("--keypair <file>", "requester keypair file")
        .action(async (id: string, options) => {
          const { global, cfg } = await context();
          const streamId = parseId(id, "id");
          if (global.dryRun) {
            output({ action: `recurring-streams.${name}`, streamId }, global);
            return;
          }

          const signer = await loadKeypair(options.keypair);
          const client = streamsClient(cfg, signer.publicKey());
          const hash = await client[method](signer, streamId);
          output({ ok: true, streamId, requester: signer.publicKey(), hash }, global);
        }),
    );
  }
}
