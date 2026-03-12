### Email-to-Lead Rebuild Migration Plan (Shadow → Cutover)

### Summary
Rebuild email ingestion so **lead creation happens only after qualification**.  
Chosen decisions:
- Rollout: **shadow first, then cutover**
- Uncertain emails: **agent review queue**
- Rejected/non-lead retention: **full encrypted intake record**
- Qualification strategy: **hard rules + score blend (rules + classifier features)**
- Agent queue surface: **separate intake-review API/UI (no provisional lead)**

### Step-by-Step Implementation
1. **Add intake persistence layer (DB migration)**
- Create `EmailIntake` table for all inbound email candidates before lead creation.
- Required columns: mailbox/team/provider IDs, sender, subject, encrypted body, metadata, provider event ID, ingest source (`webhook|poll|backfill`), classifier JSON, score, decision, review assignment/status, optional linked `lead_id` and `conversation_event_id`.
- Add unique dedupe key: `(mailbox_connection_id, provider_event_id)` for email intake.
- Add indexes for `team_id + review_status + review_assignee_user_id`, `decision`, `created_at`.
- Add `EmailIntakeAudit` table (decision/review action log with actor and payload).
- Add RLS policies aligned with existing model:
- AGENT sees own assigned review items.
- TEAM_LEAD sees all team intake items.

2. **Add feature flags and policy config**
- Add env flags:
- `EMAIL_INTAKE_ENABLED`
- `EMAIL_INTAKE_SHADOW_MODE` (default `true`)
- `EMAIL_INTAKE_CUTOVER_ENABLED` (default `false`)
- `EMAIL_INTAKE_CREATE_THRESHOLD` (default `70`)
- `EMAIL_INTAKE_REVIEW_THRESHOLD` (default `40`)
- `EMAIL_INTAKE_REVIEW_SLA_MINUTES` (default `60`)
- `EMAIL_INTAKE_BLOCKED_LOCALPARTS`, `EMAIL_INTAKE_BLOCKED_DOMAINS`, `EMAIL_INTAKE_DISPOSABLE_DOMAINS`
- Update env contract + `.env.example`.

3. **Implement intake normalization + qualification service**
- New service responsibilities:
- Normalize sender/domain/body fingerprint.
- Run hard filters first (no-reply/system/disposable/obvious spam/autoreply/opt-out).
- Reuse current email classifier output (`kind`, `confidence`, `needs_human_reply`, etc.).
- Compute `lead_score` (0–100) from deterministic features + classifier features.
- Decision mapping:
- Hard reject conditions -> `reject`
- Score `>= 70` -> `create_lead`
- Score `40–69` -> `needs_review`
- Score `< 40` -> `reject`
- Persist decision reasons as structured JSON.

4. **Rewire email ingest flow to intake-first**
- Update `WebhooksService.ingestEmailDetailed` to:
- Resolve mailbox/team as now.
- Upsert/dedupe into `EmailIntake`.
- Run qualification and persist decision.
- Branch by mode:
- **Shadow mode**: keep current lead creation path unchanged, but store shadow decision/score.
- **Cutover mode**:
- `create_lead`: run existing lead/event/task/classification persistence path.
- `needs_review`: do not create lead/event; assign review to mailbox owner agent.
- `reject`: do not create lead/event; finalize rejected intake.
- Keep external webhook response backward-compatible (`accepted`, `deduped`, optional `lead_id`).
- Extend internal result with optional `intake_id` and `intake_decision`.

5. **Apply same intake gate to polling and backfill**
- Poll + backfill (Gmail/Outlook) continue calling unified ingest path.
- Update pull/backfill summaries to include:
- `lead_created_count`
- `needs_review_count`
- `rejected_count`
- Keep existing counters for compatibility where needed.

6. **Add agent intake-review workflow (separate queue)**
- New API endpoints (auth required):
- `GET /v1/intake/emails/review-queue`
- `POST /v1/intake/emails/:id/approve`
- `POST /v1/intake/emails/:id/reject`
- Approve transaction:
- Lock intake row in `review_pending`.
- Create/find lead from sender email.
- Insert `ConversationEvent` from stored intake payload.
- Ensure inbound task + classification persistence.
- Mark intake `lead_created` and link IDs.
- Reject transaction:
- Mark intake rejected with reviewer note/reason.
- Append `EmailIntakeAudit` row for all review actions.

7. **Observability and calibration**
- Add structured counters/logs:
- ingest volume by source/provider
- decision distribution (`create_lead|needs_review|reject`)
- shadow-vs-legacy disagreement rate
- review queue age and backlog
- Add internal reporting query/endpoint for daily calibration.

8. **Rollout sequence**
- Release A: schema + services + shadow mode on, cutover off.
- Run shadow for at least 7 days (or minimum inbound volume threshold).
- Review disagreement samples and tune thresholds/rules.
- Release B: enable cutover flag.
- Release C: remove legacy direct-create path after stability window.

### Public API / Interface Changes
- New intake review endpoints under `/v1/intake/emails/*`.
- `ingestEmailDetailed` result extended with optional intake metadata (`intake_id`, `intake_decision`) while keeping existing fields.
- Poll/backfill summary responses gain explicit decision bucket counts.
- New DB entities: `EmailIntake`, `EmailIntakeAudit`.

### Test Plan
- **Unit**
- Hard filters (auto-reply, opt-out, no-reply, disposable domains).
- Score calculation and threshold boundaries (39/40/69/70).
- Decision reason payload correctness.
- **Integration**
- Idempotent intake upsert on duplicate provider event IDs.
- Shadow mode preserves current lead creation behavior.
- Cutover mode branches correctly for create/review/reject.
- Approve/reject review endpoint transactions and authorization.
- **Regression**
- Gmail + Outlook poll/backfill still ingest and dedupe correctly.
- Existing webhook response contract remains compatible.
- RLS tests for agent/team-lead intake access.
- **Migration**
- SQL migration applies cleanly; indexes/constraints enforce dedupe and queue queries.

### Assumptions and Defaults
- Existing leads/events remain unchanged; no retroactive lead deletion.
- SMS/call workflows are out of scope for this migration.
- Review assignee defaults to mailbox owner agent.
- Rejected emails are retained in full (encrypted body + metadata + decision reasons).
- Initial thresholds: create `>=70`, review `40–69`, reject `<40`.
