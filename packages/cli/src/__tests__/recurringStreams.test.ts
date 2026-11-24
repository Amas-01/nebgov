jest.mock("@nebgov/sdk", () => jest.requireActual("./sdkMock").mockSdk());

import { TreasuryStreamsClient } from "@nebgov/sdk";
import { stubClient } from "./sdkMock";
import {
  ACCOUNT,
  BASE_CONFIG,
  SIGNER,
  contractAddress,
  runCli,
  useCleanEnvironment,
  writeKeypairFile,
} from "./helpers";

useCleanEnvironment();

const STREAMS = contractAddress(50);
const config = { ...BASE_CONFIG, treasuryStreamsAddress: STREAMS };

describe("recurring-streams", () => {
  it("list: defaults to the first page of 50", async () => {
    const client = stubClient(TreasuryStreamsClient, {
      getActiveStreams: jest.fn().mockResolvedValue([{ id: 1 }]),
    });

    const result = await runCli(["recurring-streams", "list"], config);

    expect(TreasuryStreamsClient).toHaveBeenCalledWith(
      expect.objectContaining({ treasuryStreamsAddress: STREAMS, network: "testnet" }),
    );
    expect(client.getActiveStreams).toHaveBeenCalledWith(0, 50);
    expect(result.json()).toEqual([{ id: 1 }]);
  });

  it("list: passes --offset and --limit through", async () => {
    const client = stubClient(TreasuryStreamsClient, { getActiveStreams: jest.fn().mockResolvedValue([]) });

    await runCli(["recurring-streams", "list", "--offset", "10", "--limit", "5"], config);

    expect(client.getActiveStreams).toHaveBeenCalledWith(10, 5);
  });

  it("get: reads one stream by id", async () => {
    const client = stubClient(TreasuryStreamsClient, { getStream: jest.fn().mockResolvedValue({ id: 3 }) });

    const result = await runCli(["recurring-streams", "get", "3"], config);

    expect(client.getStream).toHaveBeenCalledWith(3);
    expect(result.json()).toEqual({ id: 3 });
  });

  it("claimable: reports the amount due right now", async () => {
    const client = stubClient(TreasuryStreamsClient, {
      getClaimableAmount: jest.fn().mockResolvedValue(42n),
    });

    const result = await runCli(["recurring-streams", "claimable", "3"], config);

    expect(client.getClaimableAmount).toHaveBeenCalledWith(3);
    expect(result.json()).toEqual({ streamId: 3, claimable: "42" });
  });

  it("by-recipient: lists every stream for the recipient, validating the address", async () => {
    const client = stubClient(TreasuryStreamsClient, {
      getStreamsForRecipient: jest.fn().mockResolvedValue([]),
    });

    await runCli(["recurring-streams", "by-recipient", ACCOUNT, "--limit", "7"], config);

    expect(client.getStreamsForRecipient).toHaveBeenCalledWith(ACCOUNT, 0, 7);
    await expect(runCli(["recurring-streams", "by-recipient", "nope"], config)).rejects.toThrow(/address/);
  });

  it("execute: pays due intervals with the executor keypair", async () => {
    const client = stubClient(TreasuryStreamsClient, {
      executeStream: jest.fn().mockResolvedValue("hash-1"),
    });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["recurring-streams", "execute", "3", "--keypair", keypair], config);

    expect(client.executeStream).toHaveBeenCalledWith(expect.anything(), 3);
    expect((client.executeStream as jest.Mock).mock.calls[0][0].publicKey()).toBe(SIGNER.publicKey());
    expect(result.json()).toEqual({ ok: true, streamId: 3, executor: SIGNER.publicKey(), hash: "hash-1" });
  });

  it.each([
    ["pause", "pauseStream"],
    ["resume", "resumeStream"],
    ["cancel", "cancelStream"],
  ])("%s: calls %s as the requester", async (command, method) => {
    const client = stubClient(TreasuryStreamsClient, { [method]: jest.fn().mockResolvedValue("hash-2") });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["recurring-streams", command, "4", "--keypair", keypair], config);

    expect(client[method]).toHaveBeenCalledWith(expect.anything(), 4);
    expect(result.json()).toEqual({ ok: true, streamId: 4, requester: SIGNER.publicKey(), hash: "hash-2" });
  });

  it("mutating commands in dry-run never load the signer or submit", async () => {
    const client = stubClient(TreasuryStreamsClient, { cancelStream: jest.fn(), executeStream: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    const cancel = await runCli(["--dry-run", "recurring-streams", "cancel", "4", "--keypair", keypair], config);
    const execute = await runCli(["--dry-run", "recurring-streams", "execute", "4", "--keypair", keypair], config);

    expect(client.cancelStream).not.toHaveBeenCalled();
    expect(client.executeStream).not.toHaveBeenCalled();
    expect(cancel.json()).toEqual({ action: "recurring-streams.cancel", streamId: 4 });
    expect(execute.json()).toEqual({ action: "recurring-streams.execute", streamId: 4 });
  });

  it("mutating commands require a keypair", async () => {
    await expect(runCli(["recurring-streams", "pause", "4"], config)).rejects.toThrow(/keypair/);
  });

  it("reads the address from NEBGOV_TREASURY_STREAMS_ADDRESS when the file omits it", async () => {
    process.env.NEBGOV_TREASURY_STREAMS_ADDRESS = STREAMS;
    stubClient(TreasuryStreamsClient, { getStream: jest.fn().mockResolvedValue({ id: 1 }) });

    await runCli(["recurring-streams", "get", "1"], { network: "testnet" });

    expect(TreasuryStreamsClient).toHaveBeenCalledWith(expect.objectContaining({ treasuryStreamsAddress: STREAMS }));
  });

  it("requires treasuryStreamsAddress", async () => {
    await expect(runCli(["recurring-streams", "get", "1"], { network: "testnet" })).rejects.toThrow(
      /treasuryStreamsAddress/,
    );
  });
});
