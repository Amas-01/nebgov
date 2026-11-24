import { Command } from "commander";
import { GovernorClient } from "@nebgov/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadKeypair, required, resolvePath, type NebGovCliConfig } from "./config.js";
import { output, type GlobalOptions } from "./output.js";
import { parseAddress, parseU64, parseVoteSupport } from "./validate.js";

type CliContext = () => Promise<{ global: GlobalOptions; cfg: NebGovCliConfig }>;

/**
 * What `vote commit` saves so `vote reveal` can disclose the vote later. The
 * weight seed and salt are secrets: whoever holds them can see the vote early.
 */
type CommitmentRecord = {
  version: 1;
  network: string;
  governorAddress: string;
  proposalId: string;
  voter: string;
  support: string;
  /** Decimal string, because it is a u128. */
  weightSeed: string;
  /** 32 bytes, hex-encoded. */
  salt: string;
  /** 32-byte commitment hash, hex-encoded. */
  commitment: string;
  createdAt: string;
};

const LOSS_WARNING =
  "Keep this file until you reveal. If it is lost or deleted, the vote can never be revealed and will not count.";

function governorClient(cfg: NebGovCliConfig): GovernorClient {
  return new GovernorClient({
    network: cfg.network,
    governorAddress: required(cfg, "governorAddress"),
    timelockAddress: required(cfg, "timelockAddress"),
    votesAddress: required(cfg, "votesAddress"),
    rpcUrl: cfg.rpcUrl,
  });
}

/** Default save location, keyed by governor, proposal and voter so runs never collide. */
function defaultRecordPath(cfg: NebGovCliConfig, proposalId: bigint, voter: string): string {
  const governor = required(cfg, "governorAddress");
  return path.join(homedir(), ".nebgov", "commit-reveal", `${governor}-${proposalId}-${voter}.json`);
}

function parseRecord(raw: unknown, filePath: string): CommitmentRecord {
  const record = raw as Partial<CommitmentRecord> | null;
  const hex64 = /^[0-9a-f]{64}$/i;
  const valid =
    record !== null &&
    typeof record === "object" &&
    record.version === 1 &&
    typeof record.proposalId === "string" &&
    typeof record.voter === "string" &&
    typeof record.support === "string" &&
    typeof record.weightSeed === "string" &&
    /^\d+$/.test(record.weightSeed) &&
    typeof record.salt === "string" &&
    hex64.test(record.salt) &&
    typeof record.commitment === "string" &&
    hex64.test(record.commitment);
  if (!valid) {
    throw new Error(`${filePath} is not a valid commit-reveal record written by "nebgov vote commit"`);
  }
  return record as CommitmentRecord;
}

async function readRecord(filePath: string): Promise<CommitmentRecord> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `No saved commitment at ${filePath}. Pass --file if the commit was saved somewhere else.`,
    );
  }
  return parseRecord(JSON.parse(raw), filePath);
}

/** Create the file exclusively with owner-only permissions: an existing record is never overwritten. */
async function writeRecord(filePath: string, record: CommitmentRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `A commitment already exists at ${filePath}. Reveal that vote first, or pass --file to save this one elsewhere.`,
      );
    }
    throw error;
  }
}

/** Add `commit`, `reveal` and `cr-status` to the existing `vote` group, in both CLI entry points. */
export function registerVoteCommitReveal(vote: Command, context: CliContext): void {
  vote.addCommand(
    new Command("commit")
      .description("Commit a hidden vote during a proposal's commit phase and save the reveal secrets locally")
      .argument("<proposalId>", "proposal id")
      .requiredOption("--support <support>", "for|against|abstain")
      .requiredOption("--keypair <file>", "voter keypair file")
      .option("--file <path>", "where to save the reveal secrets (default: ~/.nebgov/commit-reveal/)")
      .action(async (proposalId: string, options) => {
        const { global, cfg } = await context();
        const id = parseU64(proposalId, "proposalId");
        const supportName = String(options.support).trim().toLowerCase();
        const support = parseVoteSupport(supportName);
        if (global.dryRun) {
          output({ action: "vote.commit", proposalId: id, support: supportName }, global);
          return;
        }

        const signer = await loadKeypair(options.keypair);
        const voter = signer.publicKey();
        const recordPath = options.file ? resolvePath(options.file) : defaultRecordPath(cfg, id, voter);
        const governor = governorClient(cfg);
        const { commitment, salt, weightSeed } = governor.generateCommitment({ proposalId: id, support });

        // Save the secrets before submitting: if the transaction's outcome is
        // unknown, the record must still exist so the vote can be revealed.
        await writeRecord(recordPath, {
          version: 1,
          network: cfg.network,
          governorAddress: required(cfg, "governorAddress"),
          proposalId: id.toString(),
          voter,
          support: supportName,
          weightSeed: weightSeed.toString(),
          salt: salt.toString("hex"),
          commitment: commitment.toString("hex"),
          createdAt: new Date().toISOString(),
        });

        let hash: string;
        try {
          hash = await governor.commitVote(signer, id, commitment);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Commit transaction failed (${reason}). The reveal secrets were kept at ${recordPath}. ` +
              `Check with "nebgov vote cr-status ${id}" whether the commit landed before deleting that file.`,
          );
        }

        output(
          {
            ok: true,
            proposalId: id,
            support: supportName,
            voter,
            hash,
            secretsFile: recordPath,
            warning: LOSS_WARNING,
          },
          global,
        );
      }),
  );

  vote.addCommand(
    new Command("reveal")
      .description("Reveal a committed vote using the secrets saved by 'vote commit'")
      .argument("<proposalId>", "proposal id")
      .requiredOption("--keypair <file>", "voter keypair file")
      .option("--file <path>", "saved commitment file (default: the file 'vote commit' wrote)")
      .action(async (proposalId: string, options) => {
        const { global, cfg } = await context();
        const id = parseU64(proposalId, "proposalId");
        const signer = await loadKeypair(options.keypair);
        const voter = signer.publicKey();
        const recordPath = options.file ? resolvePath(options.file) : defaultRecordPath(cfg, id, voter);
        const record = await readRecord(recordPath);

        if (record.proposalId !== id.toString()) {
          throw new Error(`${recordPath} holds a commitment for proposal ${record.proposalId}, not ${id}`);
        }
        if (record.voter !== voter) {
          throw new Error(`${recordPath} was saved for voter ${record.voter}, but the keypair is ${voter}`);
        }
        if (record.governorAddress !== required(cfg, "governorAddress")) {
          throw new Error(`${recordPath} was saved for governor ${record.governorAddress}`);
        }

        if (global.dryRun) {
          output({ action: "vote.reveal", proposalId: id, support: record.support }, global);
          return;
        }

        const hash = await governorClient(cfg).revealVote(signer, {
          proposalId: id,
          support: parseVoteSupport(record.support),
          weightSeed: BigInt(record.weightSeed),
          salt: Buffer.from(record.salt, "hex"),
        });
        output({ ok: true, proposalId: id, support: record.support, voter, hash }, global);
      }),
  );

  vote.addCommand(
    new Command("cr-status")
      .description("Show a proposal's commit-reveal phase and whether a voter has committed")
      .argument("<proposalId>", "proposal id")
      .option("--voter <address>", "voter address (defaults to NEBGOV_DEFAULT_ACCOUNT or the keypair)")
      .action(async (proposalId: string, options) => {
        const { global, cfg } = await context();
        const id = parseU64(proposalId, "proposalId");
        const voter = options.voter
          ? parseAddress(options.voter, "voter")
          : cfg.defaultAccount ??
            (cfg.keypairFile ? (await loadKeypair(cfg.keypairFile)).publicKey() : undefined);

        const governor = governorClient(cfg);
        const status = await governor.getCommitRevealStatus(id);
        const hasCommitted = voter ? await governor.hasCommitted(id, voter) : null;
        output({ proposalId: id, ...status, voter: voter ?? null, hasCommitted }, global);
      }),
  );
}
