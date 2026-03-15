# PRD v1.2 (Technical)

**Status:** Draft
**Date:** 2026-02-18
**Owner:** TBD

---

# 1. System Overview

Mobile-first email/SMS/voice workspace for real estate teams with a Task Deck execution UI, unified lead timeline, and privacy-by-default oversight.

* **Privacy model**: owner agents can access raw content for their leads; Team Leads see derived-only for Active/At-Risk; raw unlocks for Stale; all privileged access is audited.
* **Localization**: UI, templates, AI summaries, and drafts support French/English; lead preferred language controls defaults.

## 1.1 Definitions (MVP)

* **Lead**: a person or household the team is attempting to contact/serve.
* **Owner Agent**: the primary agent responsible for a lead’s follow-up execution.
* **Raw Content**: message bodies, full email content, attachments, and freeform notes.
* **Derived Profile**: AI summary, extracted structured fields, and computed metrics (no direct quotes by default).
* **Last Touch**: timestamp of the most recent outbound message or call attempt (including voicemail / no-answer) logged by the system.
* **SLA**: time threshold(s) for expected follow-up (configured per team; defaults TBD).
* **At-Risk**: a lead nearing an SLA breach (derived/summary visibility for Team Lead, no raw access).
* **Stale**: a lead that has breached the configured inactivity threshold and requires rescue workflow (raw unlock for Team Lead, audited).
* **Opt-out / Do Not Contact (DNC)**: a lead’s request (or team policy) to stop contact on a channel (SMS/email/voice). System must enforce and log it.

## 1.2 System Constraints (MVP)

* **Market**: Canada, with initial focus on Quebec + Ontario (French + English).
* **Channels**: Email + SMS + voice calling in MVP.
* **AI**: human-in-the-loop only (editable suggestions; never auto-sent).
* **Client language**: lead preferred language controls default templates/drafts.

---

# 2. Scope (MVP)

## 2.1 Channels

### Email

* OAuth connection (Gmail / Outlook)
* Inbound ingestion
* Reply from app
* Logged in timeline
* Up to 2 mailbox connections per agent (personal + corporate)
* Shared inboxes (e.g., info@ / leads@): ingestion allowed; replies must be sent from an agent mailbox (v0)

### Calling

* Tap-to-call via native dialer using provider-based routing/proxy (number masking + logging)
* Call event logging (direction, time, duration) via provider events
* Post-call outcome capture

### SMS (MVP)

* Provisioned business number (provider-managed)
* Two-way texting
* All SMS must be captured in-app (no native Messages app sending)

### 2.1.1 Numbering + Routing (MVP)

* **One business number per Team** for SMS + voice caller ID continuity across agents and reassignment.
* **SMS is sent only in-app** (no native Messages app sending) to ensure complete capture and policy enforcement.
* **Calls are always initiated from the app** and routed through a provider using a **call-through bridge** (agent dials an access number; provider bridges agent <-> lead; logs via webhooks). The “Call” button opens the phone’s native dialer to the access number / call-through flow.
* **Inbound SMS/calls** route to the current Owner Agent by default; Team Lead intervention follows the lead-state privacy model.

---

## 2.2 Core UX: Task Deck

The home screen is a swipeable queue of action cards due Today.

**Card Sources**

* New leads
* Scheduled follow-ups
* At-Risk leads nearing SLA breach
* Stale leads (Rescue)

**Primary Actions**

* Send (email/SMS)
* Call
* Schedule follow-up
* Snooze
* Mark Done

**Gestures**

* Swipe right → Done/Sent
* Swipe left → Snooze (Later Today / Tomorrow / Next Week)

---

## 2.3 Unified Lead Thread

Each lead has a single timeline view:

* Emails
* Call events
* Notes
* Tasks
* Outcomes

At the top: **Client Memory Panel**

* AI-generated summary
* Extracted structured fields
* Last touch timestamp
* Next action

Language adapts to user preference or detected conversation language.

---

## 2.4 Stale Rescue

When inactivity thresholds trigger a Stale state:

* Lead enters Rescue Queue.
* Raw thread access unlocks for Team Lead.
* All privileged access is logged in AuditLog (who/what/when/why).
* Team Lead may:

  * Message
  * Call
  * Reassign

If the lead responds:

* Ownership can revert to original agent.
* Auto-generated recap provided.

---

# 3. Functional Requirements

| ID    | Requirement                       | Acceptance Criteria                                                               |
| ----- | --------------------------------- | --------------------------------------------------------------------------------- |
| FR-1  | Email OAuth connect               | Mailbox connects; inbound emails ingest within 1 minute (p95).                    |
| FR-2  | Lead match or create              | Unknown sender creates new lead; known sender attaches to existing lead.          |
| FR-3  | Reply from app                    | Thread headers preserved; outbound logs to timeline.                              |
| FR-4  | Call from app (provider-routed)   | Call is initiated via app + provider; event logs direction, duration, timestamp.  |
| FR-5  | Post-call outcome                 | 15-second outcome form creates follow-up task and updates last-touch.             |
| FR-6  | Task Deck                         | Tasks generate correctly; swipe actions persist.                                  |
| FR-7  | Template library (multi-language) | User can select/edit template; templates persist by language preference.          |
| FR-8  | AI draft + summary                | Editable only; never auto-send; summary updates after new events; language-aware. |
| FR-9  | Lead states + stale detection     | State transitions follow inactivity rules; Stale triggers Rescue Queue.           |
| FR-10 | Privacy enforcement               | API-level access control; agents cannot access other agents’ raw threads.         |
| FR-11 | Summary-first oversight           | Team Lead sees derived profile for Active/At-Risk leads only.                     |
| FR-12 | Unlock raw on Stale + audit       | Raw thread opens only when Stale; all access logged with required reason.         |
| FR-13 | Team-configurable SLA + stale     | Team can configure SLA and stale thresholds; defaults are set at team creation.   |
| FR-14 | Derived profile redaction         | Derived summaries avoid direct quotes by default; PII-safe output enforced.       |
| FR-15 | Multiple mailbox connections      | Agent can connect personal + corporate mailbox; ingestion + reply works per box.  |
| FR-16 | Team business number provisioning | Team gets a business number for SMS/voice; inbound routes to owner agent.         |
| FR-17 | Basic opt-out guardrails (HITL)   | If a lead is marked DNC for a channel, the UI/API blocks sending on that channel and shows a clear reason. |
| FR-18 | STOP handling for SMS             | Inbound “STOP” (and common variants) marks SMS as DNC; confirmation message sent; all logged. |
| FR-19 | Preferred language per lead       | Lead has preferred language (e.g., French/English); templates/AI drafts default accordingly. |
| FR-20 | Shared inbox ingestion (no reply) | Shared inboxes ingest and create leads/tasks; outbound replies are disallowed from shared mailbox identity. |
| FR-21 | Identity dedup (email + phone)    | Lead matching uses normalized email OR normalized phone; conflicts are flagged for manual merge. |
| FR-22 | Attachment policy (v0)            | Do not ingest/store attachments; store metadata only (name/type/size/provider message id). |
| FR-23 | Consent tracking (v0)             | Store per-channel consent state with source and timestamp; no evidence artifact required in v0. |

---

# 4. Access Control (RBAC) Matrix

**Raw Content** = message bodies, full email content, attachments, notes
**Derived Profile** = AI summary, extracted fields, metrics

| Role          | Active: Raw     | Active: Derived | Stale: Raw      | Actions on Stale       |
| ------------- | --------------- | --------------- | --------------- | ---------------------- |
| Agent (Owner) | Yes (own leads) | Yes             | Yes             | Send / Call / Schedule |
| Team Lead     | No              | Yes (team-wide) | Yes (team-wide) | Send / Call / Reassign |

---

# 5. Lead State Machine + Timers

## 5.1 Lead States (MVP)

| State   | Meaning                         | Entry Criteria (examples)                              | Exit Criteria (examples)                    |
| ------- | -------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| New     | Not yet contacted                | New inbound message or created lead                    | First outbound message or completed call    |
| Active  | In progress, within SLA          | Any successful contact attempt logged                  | Approaching SLA threshold → At-Risk         |
| At-Risk | Nearing SLA breach               | \(now - last\_touch\) within configured “at-risk” band | Touch logged → Active; breach → Stale       |
| Stale   | Breached inactivity threshold    | \(now - last\_touch\) exceeds stale threshold          | Touch logged; reassignment; manual closeout |

## 5.2 Default Rules (placeholders to confirm)

* **SLA target**: respond within 2 hours for new inbound; 24 hours for active follow-ups (wall-clock).
* **At-Risk band**: last-touch age >= 75% of stale threshold.
* **Stale threshold**: last-touch age >= 48 hours (wall-clock).

## 5.3 Governance Behavior by State

* **Active / At-Risk**: Team Lead can view Derived Profile and metrics, but cannot open Raw Content.
* **Stale**: Team Lead raw unlock is permitted but must require a reason and must be audited.

---

# 6. End-to-End Flows

## Flow A – Inbound Email to First Contact

1. Email ingested.
2. Lead matched or created (State: New).
3. Task card appears: “Contact Now”.
4. Agent selects template or AI draft, edits, sends.
5. Lead becomes Active.
6. Follow-up task scheduled.

---

## Flow B – Call to Follow-Up

1. Agent taps Call.
2. Call event logged.
3. Post-call outcome captured.
4. Follow-up task created.
5. Last-touch updated.

---

## Flow C – Stale Rescue

1. Inactivity threshold reached.
2. State changes to Stale.
3. Lead enters Rescue Queue.
4. Team Lead gains raw access (logged).
5. Rescue message or call executed.
6. If response occurs → hand back with recap.

---

# 7. Minimal Data Model

```
User(id, team_id, role, language)

Team(id, stale_rules, sla_rules, default_language, timezone)

MailboxConnection(id, user_id, provider, email_address, status, created_at)

Lead(
  id,
  team_id,
  owner_agent_id,
  state,
  source,
  preferred_language,
  consent_json,
  dnc_json,
  created_at,
  updated_at
)

ConversationEvent(
  id,
  lead_id,
  type,
  direction,
  raw_body,
  meta,
  created_at
) [restricted]

DerivedLeadProfile(
  lead_id,
  summary,
  language,
  fields_json,
  metrics_json,
  updated_at
) [shareable]

Task(
  id,
  lead_id,
  owner_id,
  due_at,
  status,
  type,
  created_at
)

AuditLog(
  id,
  actor_id,
  lead_id,
  action,
  reason,
  timestamp
)
```

---

# 8. Non-Functional Requirements

## 8.1 Security

* Strict API-level authorization.
* Encryption at rest for raw content.
* Logged privileged access.
* Derived summaries must avoid direct quotes by default.
* Default-deny access model with explicit allow rules per role + lead state.

## 8.2 Performance

* Task Deck load < 2 seconds.
* AI draft target < 3 seconds (fallback to templates).
* Email ingestion → task creation < 1 minute (p95).
* Idempotent ingestion (no duplicate leads).

---

## 8.3 Observability (MVP)

* Time to first contact
* Inbound → outbound response time
* Tasks due vs completed per day
* Average time-to-clear Task Deck
* Stale rate (pre/post intervention)
* Rescue conversion rate
* Daily / weekly active agents

---

# 9. Compliance Guardrails + Data Retention (Canada-focused)

* MVP is human-in-the-loop only (no automated outreach sequences).
* Outbound messaging and calling must support **opt-out / DNC enforcement** by channel (SMS/email/voice).
* SMS must support **STOP** keyword handling and block further SMS after opt-out.
* Store data **indefinitely by default** (MVP), with the ability to honor deletion requests (lead-level delete) and account/team offboarding policies.
* QC/ON language requirements: support French-first templates and UI language selection; lead preferred language drives default drafts/templates.
* Consent tracking (v0): store per-channel consent state with source + timestamp (lightweight, structured).

---

# 10. Open Questions (to resolve for v0 build)

* **Consent/compliance**: finalize the minimum consent states per channel (e.g., unknown/implied/explicit) and which lead sources default to which state.
* **Phone normalization**: exact rules/library for E.164 normalization and handling multiple phone numbers per lead.
* **Manual merge**: define the merge UI/workflow for dedup conflicts and how to preserve audit history.
