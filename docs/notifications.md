# Notifications

## Overview

The notification engine turns indexed governance events into user-configured alerts. It is a backend service, not a contract feature, and it uses the same Postgres database as the indexer so it can read the indexer's `event_log` directly.

```text
Soroban events
    → indexer event_log
    → notification-processor job ──→ notification rules engine ──→ templates
                                                                   │
                                                                   ├─ in_app_notifications
                                                                   ├─ email provider (HTTP)
                                                                   ├─ webhook endpoint (HMAC-SHA256)
                                                                   └─ Telegram Bot API
                                                                   
    → notification_deliveries ──→ delivery-retry job
```

Relevant implementation files:

- `backend/src/notifications/rules.ts` — trigger types, Zod schemas, event-type mapping, matcher
- `backend/src/notifications/engine.ts` — rule evaluation, delivery, HMAC signing
- `backend/src/notifications/templates.ts` — message subjects, bodies, short text, action URLs
- `backend/src/jobs/notification-processor.ts` — event cursor, batch processing, synthetic timers
- `backend/src/jobs/delivery-retry.ts` — exponential-backoff retry worker
- `backend/src/routes/notifications.ts` — authenticated REST API
- `backend/migrations/008_add_notification_engine.sql` — rules, deliveries, inbox, cursor tables

Both jobs start unconditionally in `backend/src/index.ts` after backend config validation and migrations, and register with the job health tracker. No separate notification service is required.

## Rule fields

A rule is owned by one backend user (`user_id`) and has the following fields:

| Field              | Type                        | Default | Notes                                                                  |
| ------------------ | --------------------------- | ------- | ---------------------------------------------------------------------- |
| `name`             | `string`, 1–128 chars       | —       | Required, human-readable                                               |
| `trigger_type`     | one of the trigger types    | —       | Required; see the trigger table below                                  |
| `trigger_config`   | strict object               | `{}`    | Optional filters; unset filters match anything                         |
| `channels`         | array, 1–10 entries         | —       | Required; each is `{ type: "in_app" \| "email" \| ... }`               |
| `enabled`          | `boolean`                   | `true`  | Disabled rules are skipped by the matcher query                        |
| `cooldown_seconds` | integer `0..86400`          | `300`   | Minimum time between a rule's firings                                  |
| `last_triggered_at`| timestamp or `null`         | `null`  | Updated after all channels are attempted                               |
| `trigger_count`    | integer                     | `0`     | Incremented once per firing, not once per channel                      |

`trigger_config` accepts only these keys (all optional):

```typescript
{
  proposer?: string;          // proposal_created
  from_state?: ProposalState; // accepted but unused
  to_state?: ProposalState;   // proposal_state_changed
  threshold_bps?: number;     // 1..10000; only used by proposal_vote_threshold
  ledgers_remaining?: number; // proposal_ending_soon; default 500
  proposal_id?: number;       // vote_cast / proposal_ending_soon / threshold / quorum
  voter?: string;             // vote_cast
  stream_id?: string;         // treasury_stream_spend
  min_amount?: string;        // treasury_stream_spend
  delegatee?: string;         // delegation_received / delegation_lost
}
```

Channel shapes:

```typescript
{ type: "in_app" }
{ type: "email"; address: string }      // validated as an email address
{ type: "webhook"; url: string }        // validated as an absolute URL
{ type: "telegram"; chat_id: string }
```

## Triggers and matching

The processor reads new `event_log` rows in batches of 200, ordered by id, and advances a single-row cursor (`notification_event_cursor`, `id = 1`) after evaluating the batch. The cursor advances even if an individual event's evaluation throws, so delivery failures are handled separately by the retry job rather than by replaying events.

The engine first maps an event type to trigger types:

| `event_log.event_type`                         | Trigger type(s)                |
| ---------------------------------------------- | ------------------------------ |
| `ProposalCreated`                              | `proposal_created`             |
| `VoteCast`, `VoteCastWithReason`               | `vote_cast`                    |
| `ConfigUpdated`                                | `config_updated`               |
| `GovernorUpgraded`                             | `contract_upgraded`            |
| `DelegationRegistered`                         | `delegation_received`          |
| `DelegationRevoked`                            | `delegation_lost`              |
| `stream_spend`, `stream_batch`                 | `treasury_stream_spend`        |
| `ProposalQueued`                               | `proposal_state_changed` (`to_state = Queued`)   |
| `ProposalExecuted`                             | `proposal_state_changed` (`to_state = Executed`) |
| `ProposalCancelled`                            | `proposal_state_changed` (`to_state = Cancelled`) |
| `proposal_ending_soon`                         | synthetic scan, see below      |

Filter behavior:

| Trigger type                | Filters actually applied                                     |
| --------------------------- | ------------------------------------------------------------ |
| `proposal_created`          | `proposer`                                                    |
| `vote_cast`                 | `proposal_id`, `voter`                                        |
| `delegation_received`       | `delegatee`                                                   |
| `delegation_lost`           | `delegatee`                                                   |
| `treasury_stream_spend`     | `stream_id`, `min_amount`                                     |
| `proposal_state_changed`    | `to_state`                                                    |
| `proposal_ending_soon`      | `proposal_id`, `ledgers_remaining` (default `500`)            |
| `config_updated`            | none; matches every `ConfigUpdated` event                     |
| `contract_upgraded`         | none; matches every `GovernorUpgraded` event                  |
| `guardian_veto`             | none; currently never fires                                   |
| `contract_paused`           | none; currently never fires                                   |
| `proposal_vote_threshold`   | `proposal_id`, `threshold_bps` (default `8000`); never fires  |
| `quorum_reached`            | `proposal_id`; never fires                                    |

`from_state` is accepted by the schema but is not used by the matcher. The only state-change events mapped today are `ProposalQueued`, `ProposalExecuted`, and `ProposalCancelled`; `Defeated`, `Succeeded`, and `Expired` do not produce `proposal_state_changed` notifications.

`proposal_ending_soon` is not an on-chain event. The processor periodically scans proposals where `executed = false`, `cancelled = false`, and `end_ledger > indexer_state.last_ledger`, then builds a synthetic event with `remaining_ledgers = end_ledger - currentLedger`. The scan is skipped entirely when no enabled rule uses this trigger.

### Accepted triggers that never fire

These trigger types are valid, are stored on rules, and have message templates, but no producer emits matching events:

| Trigger type               | Why it does not fire                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `guardian_veto`            | No guardian-veto event exists in the governor contract or `event_log`                      |
| `contract_paused`          | No contract-pause event is wired into the indexer                                         |
| `proposal_vote_threshold`  | Computing a percentage needs a total-supply/quorum denominator that is not indexed       |
| `quorum_reached`           | Same missing denominator; the indexer stores tallies and a raw numerator only             |

Rules using these triggers remain valid and can be tested manually, but they silently produce nothing in normal operation. Do not rely on them for alerts until the corresponding events or snapshots are added.

## Cooldowns

Cooldowns are **per rule**, not per channel or per event:

- Before delivering a matched event, the engine checks `last_triggered_at`.
- If `now - last_triggered_at < cooldown_seconds`, the entire rule is skipped.
- After all configured channels are attempted, `last_triggered_at = NOW()` and `trigger_count += 1`.
- Default cooldown is 300 seconds; the maximum accepted value is 86,400 seconds (24 hours); `0` disables the cooldown.
- Events arriving during a cooldown are not queued or replayed later.

## REST API

All routes are mounted at `/notifications` and require authentication.

| Method | Path                            | Purpose                                                            |
| ------ | ------------------------------- | ------------------------------------------------------------------ |
| `POST` | `/notifications/rules`          | Create a rule; webhook secrets are returned only in this response  |
| `GET`  | `/notifications/rules`          | List the caller's rules; webhook secrets are masked as `"***"`      |
| `PUT`  | `/notifications/rules/:id`      | Update an owned rule; webhook secrets are regenerated but masked   |
| `DELETE` | `/notifications/rules/:id`    | Delete an owned rule                                                |
| `POST` | `/notifications/rules/:id/test` | Send a sample message through every configured channel              |
| `GET`  | `/notifications/inbox`          | Paginated in-app notifications (`limit`, `offset`, `unread_only`)    |
| `PUT`  | `/notifications/inbox/:id/read` | Mark one in-app notification read                                   |
| `PUT`  | `/notifications/inbox/read-all` | Mark all in-app notifications read                                  |
| `GET`  | `/notifications/deliveries`     | Delivery history (`limit`, `offset`, `status`)                      |
| `GET`  | `/notifications/deliveries/:id/retry` | Force an immediate retry of a `failed` or `retrying` delivery |

Example rule creation:

```bash
curl -X POST https://api.example.com/notifications/rules \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <backend token>' \
  -d '{
    "name": "Large treasury spend",
    "trigger_type": "treasury_stream_spend",
    "trigger_config": { "stream_id": "7", "min_amount": "1000000" },
    "channels": [
      { "type": "in_app" },
      { "type": "webhook", "url": "https://example.com/hooks/nebgov" }
    ],
    "cooldown_seconds": 900
  }'
```

The response includes a generated `secret` on each webhook channel. Store it immediately; later reads mask it. Updating a rule's `channels` generates new webhook secrets, but the `PUT` response masks them, so prefer recreating the rule (or otherwise rotating the receiver configuration deliberately) when you need a new secret you can read.

## Channel configuration

### In-app

No external configuration. Deliveries insert a row into `in_app_notifications` with the message subject as title, body as body, and `actionUrl` as the optional link. Most templates use `/proposal/:id`; treasury streams use `/treasury/streams/:id`.

### Email

Requires:

```bash
EMAIL_PROVIDER_API_URL=https://...
EMAIL_PROVIDER_API_KEY=...
EMAIL_FROM_ADDRESS=notifications@nebgov.dev   # optional default
```

The engine posts `{ from, to, subject, text }` to `EMAIL_PROVIDER_API_URL` with `Authorization: Bearer $EMAIL_PROVIDER_API_KEY`. Without both URL and key, every email delivery fails and enters the retry loop. Requests time out after 10 seconds.

### Webhook

No global environment variable is required. Each webhook channel has its own `url` and server-generated 32-byte hex `secret`. The engine posts this exact JSON body:

```json
{
  "event": "ProposalCreated",
  "message": {
    "subject": "New proposal #42",
    "body": "A new governance proposal (#42) has been created and is now visible on the dashboard.",
    "short": "New proposal #42 created",
    "actionUrl": "/proposal/42"
  },
  "timestamp": "2026-01-01T12:00:00.000Z"
}
```

Headers:

- `Content-Type: application/json`
- `X-Notification-Signature: <hex HMAC-SHA256 of the exact raw request body>`
- `X-Notification-Event: <event_type>` — unsigned routing hint only

Requests time out after 10 seconds. Any non-2xx response or timeout is treated as a failed delivery.

### Telegram

Requires:

```bash
TELEGRAM_BOT_TOKEN=...
```

The engine posts `{ chat_id, text: message.short }` to `https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage`. Without the token, Telegram deliveries fail and retry. Requests time out after 10 seconds.

### Job intervals

```bash
NOTIFICATION_PROCESSOR_INTERVAL_MS=10000   # event_log scan, default 10s
DELIVERY_RETRY_INTERVAL_MS=15000           # retry scan, default 15s
```

Both are wired through `docker-compose.yml` and documented in `backend/.env.example`.

## Webhook signature verification

Verify the HMAC before parsing JSON, using the raw request bytes and the secret returned when the rule was created. Compare hex strings with a constant-time comparison.

```typescript
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();

function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = signatureHeader.toLowerCase();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

app.post(
  "/hooks/nebgov",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const raw = req.body as Buffer;
    const secret = process.env.NEBOGOV_WEBHOOK_SECRET!;

    if (!verifySignature(raw, req.header("x-notification-signature"), secret)) {
      return res.sendStatus(401);
    }

    const payload = JSON.parse(raw.toString("utf8"));
    console.log(payload.event, payload.message.subject);
    return res.sendStatus(200);
  },
);
```

Do not re-serialize `payload` for verification; any whitespace or key-order change invalidates the signature. The `timestamp` is inside the signed body, but the engine has no replay window or nonce, so receivers should deduplicate deliveries. `X-Notification-Event` is convenient for routing but is not signed independently.

## Retry behavior

Each attempted delivery gets a row in `notification_deliveries` with status `pending|delivered|failed|retrying`.

1. On first failure, `attempts` becomes 1, `status` becomes `retrying`, and `next_retry_at` is set to `now + 30s × 2^(attempts - 1)`.
2. The `delivery-retry` job scans up to 50 due rows per tick and reuses the same delivery row.
3. Delays are 30s, 60s, 120s, and 240s. On the fifth failed attempt (`attempts = 5`), the row becomes permanently `failed` and `next_retry_at` is cleared.
4. A successful attempt sets `status = delivered`, fills `delivered_at`, and increments `attempts`.
5. If the rule no longer has a channel of the delivery's type, the row is marked `failed` instead of retried.
6. `GET /notifications/deliveries/:id/retry` forces an immediate attempt for a `failed` or `retrying` row using the rule's current channel configuration. It returns `410` if that channel was removed and `400` for other statuses.

If multiple channels of the same type exist on a rule, retries select the first matching channel in the stored array. Keep at most one webhook, email, or Telegram channel per rule if retry routing matters.
