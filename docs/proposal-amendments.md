# Proposal Amendments

## Overview

The amendment system adds off-chain versioning and diffing to a governance proposal. It does **not** rewrite an on-chain proposal: the original calldata remains what the governor executes. Amendments are backend records that let the original proposer iterate on the text and calldata of a **Pending** proposal before it becomes active, and let voters inspect what changed between versions.

The feature spans:

- `backend/src/routes/proposal-amendments.ts` — REST API
- `packages/indexer/migrations/024_add_proposal_amendments.sql` — shared-database schema
- `sdk/src/amendments.ts` — `AmendmentsClient`
- `app/src/app/proposals/[id]/amendments/page.tsx` and the `AmendmentTimeline` / `AmendmentDiffViewer` components — dashboard UI

## Eligibility and authority

The intended rules are:

- Only the **original proposer** may create or publish an amendment.
- Only proposals in the **Pending** state (before `start_ledger`) may be amended or have an amendment published.
- Version `0` is the original proposal and can never be published as an amendment.
- Creating an amendment produces a draft; it becomes canonical only after an explicit publish call sets `proposals.current_amendment_version`.

### Current implementation caveats

- The draft route contains a comment noting that Pending-state validation is not implemented yet, so it currently accepts drafts at any time.
- The publish route documents Pending-only behavior but does not read the proposal state or ledger before updating `current_amendment_version`.
- Both write routes read `(req as any).proposerAddress`. They do not parse or verify the SDK's `X-Proposer-Address` header themselves, so a deployment must populate `req.proposerAddress` from trusted authentication middleware before exposing these routes.
- The dashboard gates the edit/publish controls with `isProposer` and `isPending` props that default to `false` and `true` respectively; the route page does not currently derive them from auth or proposal state.

Treat the Pending-only rule as the intended contract, and enforce it in the host application or middleware until the backend check is added.

## Version and diff storage

Migration 024 adds `current_amendment_version` to `proposals` (default `0`) and creates `proposal_amendments`:

| Column           | Type        | Notes                                                       |
| ---------------- | ----------- | ----------------------------------------------------------- |
| `id`             | `serial`    | Primary key                                                 |
| `proposal_id`    | `bigint`    | Foreign key to `proposals(id)`                              |
| `version`        | `integer`   | Monotonic per proposal; unique with `proposal_id`           |
| `amended_by`     | `text`      | Proposer address                                            |
| `amended_at`     | `timestamptz` | Defaults to `NOW()`                                       |
| `description`    | `text`      | Optional replacement                                       |
| `target_address` | `text`      | Optional replacement                                       |
| `function_name`  | `text`      | Optional replacement                                       |
| `calldata_hex`   | `text`      | Optional replacement                                       |
| `reason`         | `text`      | Optional human-readable explanation                         |
| `created_at`     | `timestamptz` | Defaults to `NOW()`                                       |

The next version is computed as `MAX(version) + 1` for the proposal. Omitted fields are stored as `null`, which means "not changed" in the proposal view; they are not inherited from the previous version. The API adds a synthetic version `0` on reads, filled from the original proposal row with reason `"Original proposal"`.

The diff endpoint compares only `description`, `target_address`, `function_name`, and `calldata_hex`. It returns an array of RFC 6902-style operations:

- `replace` with `value` when a field differs in the target version (also used for fields newly present);
- `remove` when a field exists in the source version but not in the target.

Paths are top-level (`/description`, `/calldata_hex`, and so on). This is a simple field comparison, not a full JSON Patch engine: no nested paths, no `add`/`test`/`move`/`copy` operations, and no diff of `reason`, `amended_by`, or timestamps.

## API endpoints

All routes are mounted under `/proposals` by `backend/src/index.ts`.

| Method | Path                                                | Auth            | Purpose                                                        |
| ------ | --------------------------------------------------- | --------------- | -------------------------------------------------------------- |
| `GET`  | `/proposals/:proposalId/amendments`                 | public          | List version 0 plus stored amendments, with the current version |
| `GET`  | `/proposals/:proposalId/amendments/:version`        | public          | Fetch one version (`0` returns the original proposal)            |
| `POST` | `/proposals/:proposalId/amend`                      | original proposer | Create a draft amendment                                      |
| `POST` | `/proposals/:proposalId/publish-amendment/:version` | original proposer | Set the proposal's canonical version                           |
| `GET`  | `/proposals/:proposalId/amendment-diff/:from/:to`   | public          | Compute the operation array between two versions               |

Create-body fields (`description`, `target_address`, `function_name`, `calldata_hex`, `reason`) are all optional and validated with a strict Zod schema; `target_address` must match `^[GC][A-Z2-7]{55}$` when supplied. `proposalId`, `version`, `from`, and `to` are coerced to non-negative integers.

Common error responses: `400` for validation or publishing version `0`, `401` when no proposer address is available, `403` when the address is not the original proposer, `404` for a missing proposal or version, and `500` for server errors.

## SDK usage

`AmendmentsClient` is exported from `@nebgov/sdk` (and from `@nebgov/sdk/amendments`) and defaults to `http://localhost:3001`.

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { AmendmentsClient } from "@nebgov/sdk";

const amendments = new AmendmentsClient("https://api.example.com");
const proposalId = 123;
const proposer = Keypair.fromSecret(process.env.PROPOSER_SECRET!);

// Read the full history. Version 0 is the original proposal.
const history = await amendments.getAmendments(proposalId);
console.log(history.current_amendment_version, history.amendments);

// Create a draft. Only provided fields change.
const draft = await amendments.submitAmendment(proposer, proposalId, {
  description: "Clarify the milestone definition",
  calldata_hex: "0x1234abcd",
  reason: "Incorporates feedback from the first review",
});

// Compare the original with the draft. Version 0 is always the original.
const diff = await amendments.getAmendmentDiff(proposalId, 0, draft.version);

// Publish after review. This sets current_amendment_version.
await amendments.publishAmendment(proposer, proposalId, draft.version);

const published = await amendments.getAmendmentVersion(proposalId, draft.version);
```

Method signatures:

```typescript
getAmendments(proposalId: number): Promise<{
  proposal_id: number;
  current_amendment_version: number;
  amendments: ProposalAmendment[];
}>

getAmendmentVersion(proposalId: number, version: number): Promise<ProposalAmendment>

submitAmendment(
  proposerKeypair: Keypair,
  proposalId: number,
  amendment: AmendmentInput,
): Promise<ProposalAmendment>

publishAmendment(
  proposerKeypair: Keypair,
  proposalId: number,
  version: number,
): Promise<void>

getAmendmentDiff(
  proposalId: number,
  fromVersion: number,
  toVersion: number,
): Promise<JsonMergePatch[]>
```

The SDK sends `X-Proposer-Address` from the keypair's public key on both write calls. As noted above, the backend expects trusted middleware to turn that into `req.proposerAddress`; the header alone is not proof of ownership.

## Dashboard flow

`/proposals/[id]/amendments` renders `AmendmentsPage`, which uses `useAmendments(proposalId)` to load the history, submit drafts, publish versions, and fetch diffs. `AmendmentTimeline` lists versions, highlights the current one, exposes compare/publish controls, and renders `AmendmentDiffViewer` for the selected operation array.
