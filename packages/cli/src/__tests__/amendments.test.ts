jest.mock("@nebgov/sdk", () => jest.requireActual("./sdkMock").mockSdk());
import { AmendmentsClient } from "@nebgov/sdk";
import { stubClient } from "./sdkMock";
import {
  BASE_CONFIG,
  SIGNER,
  runCli,
  useCleanEnvironment,
  writeKeypairFile,
  writeTemp,
} from "./helpers";
useCleanEnvironment();

const config = { ...BASE_CONFIG, backendUrl: "http://backend.test" };

it("lists every amendment version of a proposal", async () => {
  const listing = {
    proposal_id: 7,
    current_amendment_version: 1,
    amendments: [{ version: 0 }, { version: 1 }],
  };
  const client = stubClient(AmendmentsClient, {
    getAmendments: jest.fn().mockResolvedValue(listing),
  });

  const result = await runCli(["proposals", "amendments", "7"], config);

  expect(AmendmentsClient).toHaveBeenCalledWith("http://backend.test");
  expect(client.getAmendments).toHaveBeenCalledWith(7);
  expect(result.json()).toEqual(listing);
});

it("shows a version together with its diff against the previous version", async () => {
  const amendment = { version: 2, description: "revised" };
  const diff = [{ op: "replace", path: "/description", value: "revised" }];
  const client = stubClient(AmendmentsClient, {
    getAmendmentVersion: jest.fn().mockResolvedValue(amendment),
    getAmendmentDiff: jest.fn().mockResolvedValue(diff),
  });

  const result = await runCli(["proposals", "amendment", "7", "2"], config);

  expect(client.getAmendmentVersion).toHaveBeenCalledWith(7, 2);
  expect(client.getAmendmentDiff).toHaveBeenCalledWith(7, 1, 2);
  expect(result.json()).toEqual({ amendment, diffFromVersion: 1, diff });
});

it("version 0 has no earlier version, so it is shown without a diff", async () => {
  const original = { version: 0, description: "original" };
  const client = stubClient(AmendmentsClient, {
    getAmendmentVersion: jest.fn().mockResolvedValue(original),
    getAmendmentDiff: jest.fn(),
  });

  const result = await runCli(["proposals", "amendment", "7", "0"], config);

  expect(client.getAmendmentDiff).not.toHaveBeenCalled();
  expect(result.json()).toEqual({ amendment: original, diffFromVersion: null, diff: null });
});

it("submits the file contents as the amended description, signed by the proposer", async () => {
  const file = writeTemp("amend-revised.md", "# Revised\n\nNew text");
  const client = stubClient(AmendmentsClient, {
    submitAmendment: jest.fn().mockResolvedValue({ version: 1 }),
  });

  const result = await runCli(
    ["proposals", "amend", "7", "--file", file, "--keypair", writeKeypairFile()],
    config,
  );

  expect(client.submitAmendment).toHaveBeenCalledWith(SIGNER, 7, {
    description: "# Revised\n\nNew text",
  });
  expect(result.json()).toEqual({ version: 1 });
});

it("--dry-run previews the amendment without signing or submitting", async () => {
  const file = writeTemp("amend-dry-run.md", "draft text");
  const client = stubClient(AmendmentsClient, { submitAmendment: jest.fn() });

  const result = await runCli(
    ["--dry-run", "proposals", "amend", "7", "--file", file, "--keypair", "/does/not/exist"],
    config,
  );

  expect(client.submitAmendment).not.toHaveBeenCalled();
  expect(result.json()).toMatchObject({ action: "proposals.amend", proposalId: 7 });
});

it("refuses to submit an empty amendment file", async () => {
  const file = writeTemp("amend-empty.md", "  \n");
  stubClient(AmendmentsClient, { submitAmendment: jest.fn() });

  await expect(
    runCli(["proposals", "amend", "7", "--file", file, "--keypair", writeKeypairFile()], config),
  ).rejects.toThrow("is empty");
});

it("requires backendUrl for the amendment commands", async () => {
  await expect(runCli(["proposals", "amendments", "7"], BASE_CONFIG)).rejects.toThrow(
    "Missing required config: backendUrl",
  );
});
