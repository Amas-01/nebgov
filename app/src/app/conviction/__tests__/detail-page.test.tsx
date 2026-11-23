/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ConvictionProposalPage from "../[id]/page";

const mockWallet = {
  isConnected: false,
  publicKey: null as string | null,
  signTransaction: jest.fn(),
};

const mockGovernorConfig = { convictionVotingAddress: "CTESTCONVICTION" };

const mockStakeWithSign = jest.fn();
const mockWithdrawStakeWithSign = jest.fn();
const mockCheckpointConvictionWithSign = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "7" }),
}));

jest.mock("../../../lib/wallet-context", () => ({
  useWallet: () => mockWallet,
}));

jest.mock("../../../lib/nebgov-env", () => ({
  readGovernorConfig: () => mockGovernorConfig,
}));

jest.mock("@nebgov/sdk", () => ({
  ConvictionVotingClient: jest.fn().mockImplementation(() => ({
    stakeWithSign: (...args: unknown[]) => mockStakeWithSign(...args),
    withdrawStakeWithSign: (...args: unknown[]) => mockWithdrawStakeWithSign(...args),
    checkpointConvictionWithSign: (...args: unknown[]) => mockCheckpointConvictionWithSign(...args),
  })),
}));

const PROPOSAL_ROW = { target: "GTARGET", requested_amount: "5000", conviction: "300" };
const HISTORY_ROWS = {
  data: [
    { ledger: 100, conviction: "100" },
    { ledger: 110, conviction: "200" },
    { ledger: 120, conviction: "300" },
  ],
};

function mockIndexerFetch() {
  global.fetch = jest.fn(async (url: string) => ({
    json: async () => (String(url).includes("conviction-history") ? HISTORY_ROWS : PROPOSAL_ROW),
  })) as unknown as typeof fetch;
}

describe("ConvictionProposalPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_INDEXER_URL = "http://indexer.test";
    mockWallet.isConnected = false;
    mockWallet.publicKey = null;
    mockIndexerFetch();
  });

  it("renders proposal details loaded from the indexer", async () => {
    render(<ConvictionProposalPage />);

    expect(await screen.findByRole("heading", { name: "Conviction proposal #7" })).toBeInTheDocument();
    expect(screen.getByText("GTARGET")).toBeInTheDocument();
    expect(screen.getByText("5000")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("http://indexer.test/conviction/proposals/7");
  });

  it("hides the stake form and checkpoint action when no wallet is connected", async () => {
    render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    expect(screen.queryByRole("button", { name: "Checkpoint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stake" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Stake" })).toBeNull();
  });

  it("shows checkpoint and stake controls for a connected wallet, with Stake disabled until an amount is entered", async () => {
    mockWallet.isConnected = true;
    mockWallet.publicKey = "GWALLET";
    render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    expect(screen.getByRole("button", { name: "Checkpoint" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stake" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Amount to stake"), {
      target: { value: "150" },
    });
    expect(screen.getByRole("button", { name: "Stake" })).toBeEnabled();
  });

  it("stakes the entered amount with the connected wallet and clears the input", async () => {
    mockWallet.isConnected = true;
    mockWallet.publicKey = "GWALLET";
    mockStakeWithSign.mockResolvedValue(undefined);
    render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    const input = screen.getByPlaceholderText("Amount to stake") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Stake" }));

    await waitFor(() =>
      expect(mockStakeWithSign).toHaveBeenCalledWith("GWALLET", 7, 150n, mockWallet.signTransaction),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("withdraws the stake with the connected wallet", async () => {
    mockWallet.isConnected = true;
    mockWallet.publicKey = "GWALLET";
    mockWithdrawStakeWithSign.mockResolvedValue(undefined);
    render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Stake" }));

    await waitFor(() =>
      expect(mockWithdrawStakeWithSign).toHaveBeenCalledWith("GWALLET", mockWallet.signTransaction),
    );
  });

  it("checkpoints the conviction for this proposal with the connected wallet", async () => {
    mockWallet.isConnected = true;
    mockWallet.publicKey = "GWALLET";
    mockCheckpointConvictionWithSign.mockResolvedValue(undefined);
    render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    fireEvent.click(screen.getByRole("button", { name: "Checkpoint" }));

    await waitFor(() =>
      expect(mockCheckpointConvictionWithSign).toHaveBeenCalledWith(
        "GWALLET",
        7,
        mockWallet.signTransaction,
      ),
    );
  });

  it("plots one growth point per conviction checkpoint, scaled to the maximum", async () => {
    const { container } = render(<ConvictionProposalPage />);

    await screen.findByRole("heading", { name: "Conviction proposal #7" });
    await waitFor(() =>
      expect(container.querySelector("polyline")?.getAttribute("points")).toBe(
        "0,67 50,34 100,0",
      ),
    );
  });

  it("logs an indexer failure and keeps the loading state instead of crashing", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    global.fetch = jest.fn(() => Promise.reject(new Error("indexer unreachable"))) as unknown as typeof fetch;

    render(<ConvictionProposalPage />);

    expect(screen.getByText("Loading proposal…")).toBeInTheDocument();
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Conviction proposal #7" })).toBeNull();

    consoleError.mockRestore();
  });
});
