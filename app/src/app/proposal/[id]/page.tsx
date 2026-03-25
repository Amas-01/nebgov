"use client";

/**
 * Proposal detail page — shows votes, description, and voting UI.
 * TODO issue #43: fetch real proposal data, add vote breakdown chart (recharts).
 * TODO issue #46: wire up vote casting UI to GovernorClient.castVote().
 */

import { useState } from "react";
import { VoteSupport, ProposalState } from "@nebgov/sdk";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";

interface Props {
  params: { id: string };
}

const MOCK_PROPOSAL = {
  id: 1n,
  description: "Upgrade protocol fee to 0.3%",
  state: ProposalState.Active,
  votesFor: 150000n,
  votesAgainst: 40000n,
  votesAbstain: 5000n,
  endLedger: 123456,
  proposer: "GABC...1234",
  quorum: 100000n as bigint | undefined,
};

export default function ProposalDetailPage({ params }: Props) {
  const [voted, setVoted] = useState(false);
  const [voting, setVoting] = useState(false);
  const [selectedSupport, setSelectedSupport] = useState<VoteSupport | null>(null);

  const proposal = MOCK_PROPOSAL; // TODO: fetch by params.id

  const total =
    Number(proposal.votesFor) +
    Number(proposal.votesAgainst) +
    Number(proposal.votesAbstain);

  const pct = (n: bigint) =>
    total === 0 ? 0 : Math.round((Number(n) / total) * 100);

  const toMillions = (n: bigint) => Number(n) / 1e6;

  const chartData = [
    { name: "For", votes: toMillions(proposal.votesFor), pct: pct(proposal.votesFor) },
    { name: "Against", votes: toMillions(proposal.votesAgainst), pct: pct(proposal.votesAgainst) },
    { name: "Abstain", votes: toMillions(proposal.votesAbstain), pct: pct(proposal.votesAbstain) },
  ];

  const COLORS: Record<string, string> = {
    For: "#22c55e",
    Against: "#ef4444",
    Abstain: "#9ca3af",
  };

  const quorumThreshold = proposal.quorum
    ? Number(proposal.quorum) / 1e6
    : undefined;

  async function handleVote() {
    if (selectedSupport === null) return;
    setVoting(true);
    try {
      // TODO issue #46: call GovernorClient.castVote(signer, proposalId, support)
      console.log("Casting vote:", VoteSupport[selectedSupport]);
      await new Promise((r) => setTimeout(r, 1500));
      setVoted(true);
    } finally {
      setVoting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <p className="text-sm text-gray-400 mb-1">
        Proposal #{params.id}
      </p>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        {proposal.description}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Proposed by <span className="font-mono">{proposal.proposer}</span>
      </p>

      {/* Vote breakdown — horizontal bar chart (recharts) */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
          Current Votes
        </h2>

        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 30, left: 10, bottom: 0 }}
          >
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: "#6b7280" }}
              tickFormatter={(v: number) => `${v.toLocaleString()}M`}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 13, fontWeight: 500, fill: "#374151" }}
              width={70}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, _name: string, entry: { payload: { pct: number } }) => [
                `${value.toLocaleString()}M tokens (${entry.payload.pct}%)`,
                "Votes",
              ]}
              cursor={{ fill: "rgba(0,0,0,0.04)" }}
              contentStyle={{ borderRadius: 8, fontSize: 13 }}
            />
            <Bar
              dataKey="votes"
              radius={[0, 6, 6, 0]}
              isAnimationActive={true}
              animationDuration={800}
              barSize={28}
            >
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={COLORS[entry.name]} />
              ))}
            </Bar>
            {quorumThreshold !== undefined && (
              <ReferenceLine
                x={quorumThreshold}
                stroke="#6366f1"
                strokeDasharray="6 3"
                strokeWidth={2}
                label={{
                  value: `Quorum ${quorumThreshold.toLocaleString()}M`,
                  position: "top",
                  fill: "#6366f1",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>

        {/* Legend with counts */}
        <div className="flex justify-center gap-6 mt-4 text-sm">
          {chartData.map((entry) => (
            <div key={entry.name} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: COLORS[entry.name] }}
              />
              <span className="text-gray-700 font-medium">{entry.name}</span>
              <span className="text-gray-400">
                {entry.votes.toLocaleString()}M ({entry.pct}%)
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Voting UI */}
      {proposal.state === ProposalState.Active && !voted && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
            Cast Your Vote
          </h2>
          <div className="flex gap-3 mb-4">
            {[
              { label: "For", value: VoteSupport.For, color: "border-green-500 text-green-700" },
              { label: "Against", value: VoteSupport.Against, color: "border-red-500 text-red-700" },
              { label: "Abstain", value: VoteSupport.Abstain, color: "border-gray-400 text-gray-600" },
            ].map(({ label, value, color }) => (
              <button
                key={label}
                onClick={() => setSelectedSupport(value)}
                className={`flex-1 border-2 rounded-lg py-2 text-sm font-medium transition-colors
                  ${selectedSupport === value ? color + " bg-opacity-10" : "border-gray-200 text-gray-500"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={handleVote}
            disabled={selectedSupport === null || voting}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {voting ? "Submitting vote..." : "Submit Vote"}
          </button>
        </div>
      )}

      {voted && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-800 text-sm">
          Your vote has been submitted.
        </div>
      )}
    </div>
  );
}
