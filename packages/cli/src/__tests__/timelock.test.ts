jest.mock("@nebgov/sdk", () => jest.requireActual("./sdkMock").mockSdk());

import { TimelockClient } from "@nebgov/sdk";
import { stubClient } from "./sdkMock";
import { SIGNER, runCli, useCleanEnvironment, writeKeypairFile } from "./helpers";

useCleanEnvironment();

const OP_ID = "ab".repeat(32);
const BATCH_ID = "cd".repeat(32);

describe("timelock", () => {
  it("get-op: reads the stored operation for a normalized id", async () => {
    const client = stubClient(TimelockClient, {
      getOperation: jest.fn().mockResolvedValue({
        target: "CTARGET",
        data: "0102",
        fnName: "execute",
        readyAt: 100,
        expiresAt: 200,
        executed: false,
        cancelled: false,
        predecessor: "",
      }),
    });

    const result = await runCli(["timelock", "get-op", OP_ID.toUpperCase()]);

    expect(client.getOperation).toHaveBeenCalledWith(OP_ID);
    expect(result.json()).toEqual({
      opId: OP_ID,
      operation: expect.objectContaining({ fnName: "execute", readyAt: 100 }),
    });
  });

  it("get-op: reports a missing operation as null", async () => {
    stubClient(TimelockClient, { getOperation: jest.fn().mockResolvedValue(null) });

    const result = await runCli(["timelock", "get-op", OP_ID]);

    expect(result.json()).toEqual({ opId: OP_ID, operation: null });
  });

  it("ready: reports whether the operation can execute yet", async () => {
    const client = stubClient(TimelockClient, { isReady: jest.fn().mockResolvedValue(true) });

    const result = await runCli(["timelock", "ready", OP_ID]);

    expect(client.isReady).toHaveBeenCalledWith(OP_ID);
    expect(result.json()).toEqual({ opId: OP_ID, ready: true });
  });

  it("min-delay: prints the minimum delay as a string-safe bigint", async () => {
    stubClient(TimelockClient, { minDelay: jest.fn().mockResolvedValue(86400n) });

    const result = await runCli(["timelock", "min-delay"]);

    expect(result.json()).toEqual({ minDelaySeconds: "86400" });
  });

  it("batch: reads the stored batch operation", async () => {
    const client = stubClient(TimelockClient, {
      getBatchOperation: jest.fn().mockResolvedValue({
        targets: ["CTARGET"],
        datas: ["00"],
        fnNames: ["set"],
        readyAt: 5,
        expiresAt: 9,
        executed: false,
        cancelled: false,
        predecessor: "",
      }),
    });

    const result = await runCli(["timelock", "batch", BATCH_ID]);

    expect(client.getBatchOperation).toHaveBeenCalledWith(BATCH_ID);
    expect(result.json()).toEqual({
      batchOpId: BATCH_ID,
      batch: expect.objectContaining({ fnNames: ["set"] }),
    });
  });

  it("batch-dag: reads the dependency graph, or null when there is none", async () => {
    const client = stubClient(TimelockClient, {
      getBatchDependencyGraph: jest.fn().mockResolvedValue(null),
    });

    const result = await runCli(["timelock", "batch-dag", BATCH_ID]);

    expect(client.getBatchDependencyGraph).toHaveBeenCalledWith(BATCH_ID);
    expect(result.json()).toEqual({ batchOpId: BATCH_ID, graph: null });
  });

  it("execute: signs with the keypair and reports the signer", async () => {
    const client = stubClient(TimelockClient, { execute: jest.fn().mockResolvedValue(undefined) });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["timelock", "execute", OP_ID, "--keypair", keypair]);

    expect(client.execute).toHaveBeenCalledTimes(1);
    const [signer, opId] = (client.execute as jest.Mock).mock.calls[0];
    expect(signer.publicKey()).toBe(SIGNER.publicKey());
    expect(opId).toBe(OP_ID);
    expect(result.json()).toEqual({ ok: true, opId: OP_ID, signer: SIGNER.publicKey() });
  });

  it("execute: dry-run never loads the signer or submits", async () => {
    const client = stubClient(TimelockClient, { execute: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["--dry-run", "timelock", "execute", OP_ID, "--keypair", keypair]);

    expect(client.execute).not.toHaveBeenCalled();
    expect(result.json()).toEqual({ action: "timelock.execute", opId: OP_ID });
  });

  it("cancel: signs with the keypair and reports the signer", async () => {
    const client = stubClient(TimelockClient, { cancel: jest.fn().mockResolvedValue(undefined) });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["timelock", "cancel", OP_ID, "--keypair", keypair]);

    expect(client.cancel).toHaveBeenCalledWith(expect.anything(), OP_ID);
    expect(result.json()).toEqual({ ok: true, opId: OP_ID, signer: SIGNER.publicKey() });
  });

  it("cancel: dry-run never submits", async () => {
    const client = stubClient(TimelockClient, { cancel: jest.fn() });
    const keypair = writeKeypairFile(SIGNER);

    const result = await runCli(["--dry-run", "timelock", "cancel", OP_ID, "--keypair", keypair]);

    expect(client.cancel).not.toHaveBeenCalled();
    expect(result.json()).toEqual({ action: "timelock.cancel", opId: OP_ID });
  });

  it("execute and cancel require a keypair", async () => {
    await expect(runCli(["timelock", "execute", OP_ID])).rejects.toThrow(/keypair/);
    await expect(runCli(["timelock", "cancel", OP_ID])).rejects.toThrow(/keypair/);
  });

  it("rejects a malformed operation id before calling the chain", async () => {
    const client = stubClient(TimelockClient, { isReady: jest.fn() });

    await expect(runCli(["timelock", "ready", "not-an-id"])).rejects.toThrow("32-byte hex operation id");
    expect(client.isReady).not.toHaveBeenCalled();
  });

  it("requires timelockAddress from config or the environment", async () => {
    await expect(runCli(["timelock", "min-delay"], { network: "testnet" })).rejects.toThrow(
      /timelockAddress/,
    );
  });
});
