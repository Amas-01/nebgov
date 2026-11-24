# Parameter Guide

This guide describes the governance parameters that operators and proposers need to understand to reason about proposal thresholds, voting power, and historical state retention. It covers proposer reputation and the token-votes time-weighting and checkpoint-pruning settings.

## Proposer reputation

The governor scales the flat `proposal_threshold` for each proposer by a reputation-based multiplier. A proposer with a strong track record can propose at a discount, and a proposer with repeated failed proposals pays a penalty. The architecture is described in [architecture.md](./architecture.md#proposer-reputation).

### Default scoring constants

Every governor uses the same constants from `default_config()`. These values are fixed in the contract and cannot be changed through governance, so there is no safe range for an operator to choose. The table below describes their effect.

| Constant | Default | When it applies |
| --- | --- | --- |
| `score_for_succeed` | +100 | A proposal passes voting and is queued |
| `score_for_executed` | +50 | A queued proposal is executed |
| `score_for_defeated` | −30 | Voting closes without quorum or a majority |
| `score_for_cancelled` | −20 | A proposal is cancelled |
| `score_for_expired` | −60 | A passed proposal is not executed within the grace period |
| `score_for_high_participation` | +30 | Added on top of `score_for_succeed` when a passed proposal's participation is at least 5,000 bps (50%) of quorum-eligible supply |
| `min_proposals_for_discount` | 3 | Below this many proposals, the multiplier cannot drop below 1x |
| `max_score` / `min_score` | 1000 / −1000 | Bounds on the reputation score |
| `max_threshold_multiplier_bps` | 20,000 (2x) | Multiplier at the minimum score (largest penalty) |
| `min_threshold_multiplier_bps` | 5,000 (0.5x) | Multiplier at the maximum score (largest discount) |
| `decay_rate_per_1000_ledgers` | 10 | Score moves toward zero per 1,000 ledgers since the last update |

### How the score maps to a threshold

The score is clamped to `[min_score, max_score]` and mapped linearly onto the multiplier range. A higher score always gives a lower or equal multiplier. The effective threshold is:

```
effective_threshold = proposal_threshold × threshold_multiplier_bps / 10,000
```

With a flat `proposal_threshold` of 1,000 units and the default constants:

| Score | Multiplier | Effective threshold |
| --- | --- | --- |
| −1000 | 2.0x | 2,000 |
| 0 | 1.25x | 1,250 |
| about +333 | about 1.0x | about 1,000 |
| +1000 | 0.5x | 500 |

A score of `0` is not neutral. Once a proposer has at least three proposals, a score of `0` gives a 1.25x threshold. The 1x point is near a score of +333. A proposer with no recorded outcomes yet stays at 1x.

### Decay

`apply_reputation_decay(proposer)` is permissionless. It moves a nonzero score back toward zero, by `decay_rate_per_1000_ledgers` for every 1,000 ledgers since the record was last updated. For example, a score of −60 with the default rate returns to `0` after about 6,000 ledgers without a new outcome. Calling the function again immediately has no effect.

### What operators can tune

Only the flat `proposal_threshold` in the governor settings is tunable through governance. The reputation multiplier then applies to whatever value is set. The `enabled` flag exists in the reputation config, but it is a compile-time constant set to `true` and has no runtime toggle.

## Token-votes time weighting

`contracts/token-votes` can add a time-based bonus to delegated voting power. The feature is disabled by default and is controlled by the contract admin with `set_time_weight_enabled(bool)` and `set_time_weight_scale(u32)`.

| Setting               | Default   | Validation                | Recommended baseline                                      |
| --------------------- | --------- | ------------------------- | --------------------------------------------------------- |
| `time_weight_enabled` | `false`   | admin only                | Keep disabled until the DAO deliberately wants longevity weighting |
| `time_weight_scale`   | `4,204,800` ledgers | must be a nonzero `u32` | Keep the default for a 1x bonus (2x total power) after about one year (~7.5 s/ledger). Increase it for a slower ramp; use `set_time_weight_enabled(false)` rather than a zero scale |

### Bonus formula

Each voting-power checkpoint stores `votes` (base voting power) and `weighted_sum`, the sum of `balance × start_ledger` across the delegations behind that voting power. The bonus is computed with integer division:

```text
bonus = (ledger × votes − weighted_sum) / time_weight_scale
weighted_votes = votes + bonus
```

When an account increases a delegation, its stored `start_ledger` becomes the balance-weighted average start ledger, so top-ups earn only the boost their own age justifies.

### Worked example

A voter delegates 1,000 tokens at ledger 100. At that moment:

```text
votes        = 1,000
weighted_sum = 1,000 × 100 = 100,000
```

With the default scale of 4,204,800:

| Query ledger       | Elapsed ledgers | Bonus                                                       | Voting power |
| ------------------ | --------------- | ----------------------------------------------------------- | ------------ |
| 100                | 0               | `(100 × 1,000 − 100,000) / 4,204,800 = 0`                    | 1,000        |
| 2,102,500          | 2,102,400       | `(2,102,500 × 1,000 − 100,000) / 4,204,800 = 500`            | 1,500        |
| 4,204,900          | 4,204,800       | `(4,204,900 × 1,000 − 100,000) / 4,204,800 = 1,000`          | 2,000        |

The bonus is unbounded: it grows linearly with elapsed ledgers divided by the scale, so two scales of continuous delegation give a 2x bonus and 3x total voting power. Any fraction is truncated toward zero. The same formula is used for `get_votes`, `get_past_votes`, and `get_past_total_supply`; the last two look up the time-weight settings that were active at the queried ledger.

### Changing time-weight settings

Every `set_time_weight_enabled` or `set_time_weight_scale` call records a `TimeWeightCheckpoint` at the current ledger. Historical lookups use the last checkpoint at or before the ledger being queried, so a change made **after** a proposal's snapshot ledger does not retroactively change that proposal's tally.

Operational risks remain:

- `get_votes()` uses the current settings immediately, while a proposal's tally uses settings at its snapshot ledger. Dashboards and tallies can therefore disagree during a transition.
- A settings change recorded at the same ledger as a proposal snapshot applies to that snapshot, because the lookup is inclusive (`<=`).
- Later proposals use the new settings, so a scale increase dilutes long-standing holders' relative boost even though their underlying checkpoints are unchanged.
- Announce changes before the next proposal is created and avoid changing settings while a close proposal is being voted on.

## Checkpoint retention and pruning

`prune_checkpoints(min_active_proposal_ledger)` is admin-only and removes stale entries from the global and per-account checkpoint logs. It returns the number of entries removed.

| Setting                      | Default         | Recommended baseline                                                         |
| ---------------------------- | --------------- | ---------------------------------------------------------------------------- |
| `checkpoint_retention_period`| `100,800` ledgers (~2 weeks at ~7.5 s/ledger) | Keep the default unless storage costs require shortening it. Set it longer than the oldest ledger any active proposal may need, plus a safety margin. |

### How pruning preserves snapshots

The cutoff is `current_ledger − retention_period`. Operators should pass the oldest snapshot ledger of any active proposal as `min_active_proposal_ledger`; the effective cutoff becomes the smaller of that value and the retention cutoff. This prevents pruning a checkpoint that a proposal's `get_past_votes` / `get_past_total_supply` query still needs.

Per-account logs keep the last checkpoint at or before the effective cutoff as an anchor. The total-supply log keeps the first checkpoint after the cutoff, except that it retains the newest checkpoint if every checkpoint is newer than the cutoff. Binary search then returns that retained checkpoint for earlier ledgers, so:

- queries at or after a retained checkpoint remain correct;
- queries earlier than a retained account anchor may return the anchor's state rather than the exact state at that older ledger;
- if all total-supply checkpoints are newer than the cutoff, there is no pre-cutoff supply anchor at all;
- omitting `min_active_proposal_ledger` relies solely on the retention period and can break tallies for long-running proposals.

`prune_checkpoints` does not prune the time-weight settings log or the underlying delegator records. Run it as an explicit admin maintenance operation, not on a fixed schedule that ignores active proposals. The SDK equivalents are `getVotesSettings()`, `getCheckpointRetentionPeriod()`, `setCheckpointRetentionPeriod(signer, ledgers)`, and `pruneCheckpoints(signer, minActiveProposalLedger?)`.
