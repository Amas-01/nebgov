jest.mock("@nebgov/sdk", () => jest.requireActual("./sdkMock").mockSdk());

import { GovernorClient, VoteSupport } from "@nebgov/sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stubClient } from "./sdkMock";
import {
  ACCOUNT,
  BASE_CONFIG,
  GOVERNOR,
  OTHER_ACCOUNT,
  SIGNER,
  runCli,
  useCleanEnvironment,
  writeKeypairFile,
  writeTemp,
} from "./helpers";

useCleanEnvironment();

const COMMITMENT = Buffer.alloc(32, 9);
const SALT = Buffer.alloc(32, 3);

/** A path that does not exist yet, inside the test's temp directory. */
function freshPath(name: string): string {
  return path.join(path.dirname(writeTemp(`${name}.anchor`, "")), name);
}

function recordFile(overrides: Record<string, unknown> = {}): string {
  return writeTemp(
    `record-${Math.random().toString(36).slice(2)}.json`,
    JSON.stringify({
      version: 1,
      network: "testnet",
      governorAddress: GOVERNOR,
      proposalId: "42",
      voter: SIGNER.publicKey(),
      support: "against",
      weightSeed: "123",
      salt: SALT.toString("hex"),
      commitment: COMMITMENT.toString("hex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }),
  );
}

describe("vote commit", () => {
  it("commits the hash and saves the reveal secrets to a 0600 file", async () => {
    const client = stubClient(GovernorClient, {
      generateCommitment: jest.fn().mockReturnValue({ commitment: COMMITMENT, salt: SALT, weightSeed: 123n }),
      commitVote: jest.fn().mockResolvedValue("hash-commit"),
    });
    const keypair = writeKeypairFile(SIGNER);
    const file = freshPath("commit.json");

    const result = await runCli(
      ["vote", "commit", "42", "--support", "FOR", "--keypair", keypair, "--file", file],
      BASE_CONFIG,
    );

    expect(client.generateCommitment).toHaveBeenCalledWith({ proposalId: 42n, support: VoteSupport.For });
    expect(client.commitVote).toHaveBeenCalledWith(expect.anything(), 42n, COMMITMENT);
    expect(result.json()).toEqual({
      ok: true,
      proposalId: "42",
      support: "for",
      voter: SIGNER.publicKey(),
      hash: "hash-commit",
      secretsFile: file,
      warning: expect.stringContaining("will not count"),
    });

    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({
      version: 1,
      network: "testnet",
      governorAddress: GOVERNOR,
      proposalId: "42",
      voter: SIGNER.publicKey(),
      support: "for",
      weightSeed: "123",
      salt: SALT.toString("hex"),
      commitment: COMMITMENT.toString("hex"),
    });
    expect(saved.createdAt).toEqual(expect.any(String));
    if (process.platform !== "win32") {
      expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("never overwrites an existing record, so earlier secrets cannot be lost", async () => {
    stubClient(GovernorClient, {
      generateCommitment: jest.fn().mockReturnValue({ commitment: COMMITMENT, salt: SALT, weightSeed: 1n }),
      commitVote: jest.fn().mockResolvedValue("hash"),
    });
    const keypair = writeKeypairFile(SIGNER);
    const file = freshPath("once.json");
    const args = ["vote", "commit", "42", "--support", "for", "--keypair", keypair, "--file", file];

    await runCli(args, BASE_CONFIG);
    const before = readFileSync(file, "utf8");

    await expect(runCli(args, BASE_CONFIG)).rejects.toThrow(/already exists/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps the secrets when the transaction fails, and says where they are", async () => {
    stubClient(GovernorClient, {
      generateCommitment: jest.fn().mockReturnValue({ commitment: COMMITMENT, salt: SALT, weightSeed: 5n }),
      commitVote: jest.fn().mockRejectedValue(new Error("network timeout")),
    });
    const keypair = writeKeypairFile(SIGNER);
    const file = freshPath("failed.json");

    await expect(
      runCli(["vote", "commit", "42", "--support", "for", "--keypair", keypair, "--file", file], BASE_CONFIG),
    ).rejects.toThrow(`kept at ${file}`);
    expect(existsSync(file)).toBe(true);
  });

  it("dry-run neither generates secrets nor writes a file", async () => {
    const client = stubClient(GovernorClient, { generateCommitment: jest.fn(), commitVote: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);
    const file = freshPath("dry.json");

    const result = await runCli(
      ["--dry-run", "vote", "commit", "42", "--support", "abstain", "--keypair", keypair, "--file", file],
      BASE_CONFIG,
    );

    expect(client.generateCommitment).not.toHaveBeenCalled();
    expect(client.commitVote).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    expect(result.json()).toEqual({ action: "vote.commit", proposalId: "42", support: "abstain" });
  });

  it("rejects an unknown support value before doing anything", async () => {
    const client = stubClient(GovernorClient, { generateCommitment: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    await expect(
      runCli(["vote", "commit", "42", "--support", "maybe", "--keypair", keypair], BASE_CONFIG),
    ).rejects.toThrow("support must be one of: for, against, abstain");
    expect(client.generateCommitment).not.toHaveBeenCalled();
  });

  it("requires governorAddress", async () => {
    stubClient(GovernorClient, { generateCommitment: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    await expect(
      runCli(
        ["vote", "commit", "42", "--support", "for", "--keypair", keypair, "--file", freshPath("x.json")],
        { network: "testnet" },
      ),
    ).rejects.toThrow(/governorAddress/);
  });
});

describe("vote reveal", () => {
  it("reveals with the saved support, seed and salt", async () => {
    const client = stubClient(GovernorClient, { revealVote: jest.fn().mockResolvedValue("hash-reveal") });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(
      ["vote", "reveal", "42", "--keypair", keypair, "--file", recordFile()],
      BASE_CONFIG,
    );

    expect(client.revealVote).toHaveBeenCalledWith(expect.anything(), {
      proposalId: 42n,
      support: VoteSupport.Against,
      weightSeed: 123n,
      salt: SALT,
    });
    expect(result.json()).toEqual({
      ok: true,
      proposalId: "42",
      support: "against",
      voter: SIGNER.publicKey(),
      hash: "hash-reveal",
    });
  });

  it("refuses a record that belongs to a different voter", async () => {
    const client = stubClient(GovernorClient, { revealVote: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    await expect(
      runCli(
        ["vote", "reveal", "42", "--keypair", keypair, "--file", recordFile({ voter: OTHER_ACCOUNT })],
        BASE_CONFIG,
      ),
    ).rejects.toThrow(/was saved for voter/);
    expect(client.revealVote).not.toHaveBeenCalled();
  });

  it("refuses a record for a different proposal", async () => {
    stubClient(GovernorClient, { revealVote: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    await expect(
      runCli(["vote", "reveal", "43", "--keypair", keypair, "--file", recordFile()], BASE_CONFIG),
    ).rejects.toThrow("holds a commitment for proposal 42, not 43");
  });

  it("reports a missing record and rejects a malformed one", async () => {
    stubClient(GovernorClient, { revealVote: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    await expect(
      runCli(["vote", "reveal", "42", "--keypair", keypair, "--file", freshPath("nope.json")], BASE_CONFIG),
    ).rejects.toThrow(/No saved commitment/);

    const malformed = writeTemp("malformed.json", JSON.stringify({ version: 2 }));
    await expect(
      runCli(["vote", "reveal", "42", "--keypair", keypair, "--file", malformed], BASE_CONFIG),
    ).rejects.toThrow(/not a valid commit-reveal record/);
  });

  it("dry-run validates the record but does not submit", async () => {
    const client = stubClient(GovernorClient, { revealVote: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(
      ["--dry-run", "vote", "reveal", "42", "--keypair", keypair, "--file", recordFile()],
      BASE_CONFIG,
    );

    expect(client.revealVote).not.toHaveBeenCalled();
    expect(result.json()).toEqual({ action: "vote.reveal", proposalId: "42", support: "against" });
  });
});

describe("vote cr-status", () => {
  it("shows the phase and whether the voter has committed", async () => {
    const client = stubClient(GovernorClient, {
      getCommitRevealStatus: jest.fn().mockResolvedValue({
        phase: "commit",
        commitDeadline: 100,
        revealDeadline: 200,
        commitCount: 3,
        revealCount: 0,
      }),
      hasCommitted: jest.fn().mockResolvedValue(true),
    });

    const result = await runCli(["vote", "cr-status", "42", "--voter", ACCOUNT], BASE_CONFIG);

    expect(client.getCommitRevealStatus).toHaveBeenCalledWith(42n);
    expect(client.hasCommitted).toHaveBeenCalledWith(42n, ACCOUNT);
    expect(result.json()).toEqual({
      proposalId: "42",
      phase: "commit",
      commitDeadline: 100,
      revealDeadline: 200,
      commitCount: 3,
      revealCount: 0,
      voter: ACCOUNT,
      hasCommitted: true,
    });
  });

  it("reports hasCommitted as null when no voter is known", async () => {
    const client = stubClient(GovernorClient, {
      getCommitRevealStatus: jest.fn().mockResolvedValue({ phase: "ended" }),
      hasCommitted: jest.fn(),
    });

    const result = await runCli(["vote", "cr-status", "42"], BASE_CONFIG);

    expect(client.hasCommitted).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({ voter: null, hasCommitted: null });
  });

  it("rejects an invalid --voter address", async () => {
    stubClient(GovernorClient, { getCommitRevealStatus: jest.fn() });

    await expect(runCli(["vote", "cr-status", "42", "--voter", "bogus"], BASE_CONFIG)).rejects.toThrow(/voter/);
  });
});
