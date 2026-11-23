/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OptimisticProposalPage from "../[id]/page";

const mockWallet = {
  publicKey: "GVOTER" as string | null,
  signTransaction: jest.fn(),
};

let mockCurrentLedger = 1000;

const mockHook: {
  proposal: Record<string, unknown> | null;
  objections: { objector: string; weight: bigint; runningTotal: bigint; ledger: number }[];
  loading: boolean;
  error: string | null;
  refresh: jest.Mock;
} = {
  proposal: null,
  objections: [],
  loading: false,
  error: null,
  refresh: jest.fn(),
};

const mockGetPastVotes = jest.fn();
const mockObjectWithSign = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "5" }),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("../../../lib/wallet-context", () => ({
  useWallet: () => mockWallet,
}));

jest.mock("../../../lib/nebgov-env", () => ({
  readGovernorConfig: () => ({ optimisticGovernorAddress: "CTESTOPTIMISTIC" }),
  subscriptionOptsFromConfig: () => ({}),
  readIndexerUrl: () => "http://indexer.test",
}));

jest.mock("../../../lib/hooks/useLedgerClock", () => ({
  useLedgerClock: () => ({ currentLedger: mockCurrentLedger, isLoading: false, error: null }),
}));

jest.mock("../../../hooks/useOptimisticProposals", () => ({
  useOptimisticProposal: () => mockHook,
}));

jest.mock("../../../components/ChallengeCountdown", () => ({
  ChallengeCountdown: () => <div data-testid="countdown" />,
}));

jest.mock("@nebgov/sdk", () => ({
  VotesClient: jest.fn().mockImplementation(() => ({
    getPastVotes: (...args: unknown[]) => mockGetPastVotes(...args),
  })),
  OptimisticGovernorClient: jest.fn().mockImplementation(() => ({
    objectWithSign: (...args: unknown[]) => mockObjectWithSign(...args),
    finalizeWithSign: jest.fn(),
    executeWithSign: jest.fn(),
  })),
  subscribeToOptimisticObjectionCast: jest.fn(() => undefined),
}));

function makeProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: "5",
    proposer: "GPROPOSER",
    createdLedger: 900,
    challengeEndLedger: 2000,
    objectionVotes: 0n,
    state: "challenge_window",
    ...overrides,
  };
}

describe("OptimisticProposalPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWallet.publicKey = "GVOTER";
    mockCurrentLedger = 1000;
    mockHook.proposal = makeProposal();
    mockHook.objections = [];
    mockHook.loading = false;
    mockHook.error = null;
    mockGetPastVotes.mockResolvedValue(500n);
  });

  it("enables Object for an eligible wallet while the challenge window is open", async () => {
    render(<OptimisticProposalPage />);

    const objectButton = screen.getByRole("button", { name: "Object" });
    await waitFor(() => expect(objectButton).toBeEnabled());

    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
    expect(screen.getByText(/Challenge window is still open/i)).toBeInTheDocument();
    expect(mockGetPastVotes).toHaveBeenCalledWith("GVOTER", 900);
  });

  it("keeps Object disabled for a wallet with no voting power at the created ledger", async () => {
    mockGetPastVotes.mockResolvedValue(0n);
    render(<OptimisticProposalPage />);

    await waitFor(() =>
      expect(screen.getByText(/No voting power at this proposal/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Object" })).toBeDisabled();
  });

  it("disables Object and explains the state when the wallet has already objected", async () => {
    mockHook.objections = [
      { objector: "GVOTER", weight: 500n, runningTotal: 500n, ledger: 950 },
    ];
    render(<OptimisticProposalPage />);

    expect(screen.getByText(/already objected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Object" })).toBeDisabled();
  });

  it("shows no challenge actions once the proposal is objected", () => {
    mockHook.proposal = makeProposal({ state: "objected", objectionVotes: 500n });
    render(<OptimisticProposalPage />);

    expect(screen.getByText("Objected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Object" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });

  it("enables Execute for a connected wallet once the proposal has passed", () => {
    mockHook.proposal = makeProposal({ state: "passed" });
    render(<OptimisticProposalPage />);

    expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Object" })).toBeNull();
  });

  it("disables Execute and asks for a wallet when disconnected on a passed proposal", () => {
    mockWallet.publicKey = null;
    mockHook.proposal = makeProposal({ state: "passed" });
    render(<OptimisticProposalPage />);

    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
    expect(screen.getByText("Connect your wallet to execute.")).toBeInTheDocument();
  });

  it("enables Finalize and disables Object once the challenge window has elapsed", async () => {
    mockCurrentLedger = 2500;
    render(<OptimisticProposalPage />);

    expect(screen.getByRole("button", { name: "Finalize" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Object" })).toBeDisabled();
    expect(screen.queryByText(/Challenge window is still open/i)).toBeNull();
  });

  it("asks for a wallet and disables both actions when disconnected", () => {
    mockWallet.publicKey = null;
    render(<OptimisticProposalPage />);

    expect(screen.getByRole("button", { name: "Object" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
    expect(screen.getByText("Connect your wallet to object or finalize.")).toBeInTheDocument();
  });

  it("submits an objection with the connected wallet and refreshes the proposal", async () => {
    mockObjectWithSign.mockResolvedValue(undefined);
    render(<OptimisticProposalPage />);

    const objectButton = screen.getByRole("button", { name: "Object" });
    await waitFor(() => expect(objectButton).toBeEnabled());
    fireEvent.click(objectButton);

    await waitFor(() =>
      expect(mockObjectWithSign).toHaveBeenCalledWith("GVOTER", 5, mockWallet.signTransaction),
    );
    await waitFor(() => expect(mockHook.refresh).toHaveBeenCalled());
  });

  it("renders no action buttons when the indexer returned no proposal", () => {
    mockHook.proposal = null;
    mockHook.error = "Indexer returned 500";
    render(<OptimisticProposalPage />);

    expect(screen.getByText("Proposal not found.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
