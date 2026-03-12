--
-- PostgreSQL database dump
--

\restrict duoLCCd2pT42jsd2DHGp8dYjIpMHQiBDPUKlExv6UYNnbTA8f0hyIKRd0CR1NO2

-- Dumped from database version 15.16 (Homebrew)
-- Dumped by pg_dump version 15.16 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: app_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.role', true), '');
$$;


--
-- Name: app_team_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_team_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.team_id', true), '')::uuid;
$$;


--
-- Name: app_user_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: team_event_metadata(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_event_metadata(p_lead_id uuid) RETURNS TABLE(id uuid, channel text, type text, direction text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF app_role() <> 'TEAM_LEAD' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT e.id, e.channel, e.type, e.direction, e.created_at
  FROM "ConversationEvent" e
  JOIN "Lead" l ON l.id = e.lead_id
  WHERE e.lead_id = p_lead_id
    AND l.team_id = app_team_id();
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Attachment" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_event_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    storage_key text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Attachment_size_bytes_check" CHECK ((size_bytes >= 0))
);


--
-- Name: AuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AuditLog" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    lead_id uuid NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ConversationEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ConversationEvent" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    channel text NOT NULL,
    type text NOT NULL,
    direction text NOT NULL,
    mailbox_connection_id uuid,
    phone_number_id uuid,
    provider_event_id text,
    raw_body bytea,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "ConversationEvent_channel_check" CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'note'::text, 'system'::text]))),
    CONSTRAINT "ConversationEvent_direction_check" CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'internal'::text])))
);


--
-- Name: DerivedLeadProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DerivedLeadProfile" (
    lead_id uuid NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    language text NOT NULL,
    fields_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    metrics_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Lead; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Lead" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    owner_agent_id uuid NOT NULL,
    state text NOT NULL,
    source text NOT NULL,
    primary_email public.citext,
    primary_phone text,
    last_touch_at timestamp with time zone,
    next_action_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Lead_source_check" CHECK ((source = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'manual'::text]))),
    CONSTRAINT "Lead_state_check" CHECK ((state = ANY (ARRAY['New'::text, 'Active'::text, 'At-Risk'::text, 'Stale'::text])))
);


--
-- Name: MailboxConnection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MailboxConnection" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    email_address public.citext NOT NULL,
    mailbox_type text NOT NULL,
    delegated_from public.citext,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "MailboxConnection_mailbox_type_check" CHECK ((mailbox_type = ANY (ARRAY['primary'::text, 'shared'::text, 'delegated'::text]))),
    CONSTRAINT "MailboxConnection_provider_check" CHECK ((provider = ANY (ARRAY['gmail'::text, 'outlook'::text]))),
    CONSTRAINT "MailboxConnection_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'error'::text, 'revoked'::text])))
);


--
-- Name: PhoneNumber; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PhoneNumber" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    provider text NOT NULL,
    number text NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "PhoneNumber_provider_check" CHECK ((provider = 'twilio'::text)),
    CONSTRAINT "PhoneNumber_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'error'::text])))
);


--
-- Name: Task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Task" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Task_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'snoozed'::text, 'cancelled'::text]))),
    CONSTRAINT "Task_type_check" CHECK ((type = ANY (ARRAY['contact_now'::text, 'follow_up'::text, 'rescue'::text, 'call_outcome'::text, 'manual'::text])))
);


--
-- Name: Team; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Team" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stale_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    sla_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    escalation_rules jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    role text NOT NULL,
    language text NOT NULL,
    CONSTRAINT "User_role_check" CHECK ((role = ANY (ARRAY['AGENT'::text, 'TEAM_LEAD'::text])))
);


--
-- Data for Name: Attachment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Attachment" (id, conversation_event_id, filename, mime_type, storage_key, size_bytes, created_at) FROM stdin;
\.


--
-- Data for Name: AuditLog; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."AuditLog" (id, actor_id, lead_id, action, reason, "timestamp") FROM stdin;
\.


--
-- Data for Name: ConversationEvent; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."ConversationEvent" (id, lead_id, channel, type, direction, mailbox_connection_id, phone_number_id, provider_event_id, raw_body, meta, created_at) FROM stdin;
00000000-0000-0000-0000-000000000500	00000000-0000-0000-0000-000000000100	email	inbound_message	inbound	\N	\N	\N	\N	{}	2026-02-22 19:03:47.645-05
00000000-0000-0000-0000-000000000501	00000000-0000-0000-0000-000000000101	sms	outbound_message	outbound	\N	\N	\N	\N	{}	2026-02-22 18:03:47.645-05
00000000-0000-0000-0000-000000000502	00000000-0000-0000-0000-000000000102	call	call_completed	outbound	\N	\N	\N	\N	{}	2026-02-21 23:03:47.645-05
00000000-0000-0000-0000-000000000503	00000000-0000-0000-0000-000000000103	system	stale_transition	internal	\N	\N	\N	\N	{}	2026-02-22 17:03:47.645-05
\.


--
-- Data for Name: DerivedLeadProfile; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at) FROM stdin;
00000000-0000-0000-0000-000000000100	New lead from inbound email. Needs first touch and scheduling intent.	en	{}	{"urgency": "high", "touches_last_48h": 0}	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000101	Engaged over SMS. Wants options in the west side area this week.	en	{}	{"urgency": "medium", "touches_last_48h": 2}	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000102	Follow-up lagging and close to stale threshold. Needs quick outbound touch.	en	{}	{"urgency": "high", "touches_last_48h": 1}	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000103	No recent valid touches. In stale rescue path and ready for intervention.	en	{}	{"urgency": "critical", "touches_last_48h": 0}	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000104	Recent phone interaction completed. Awaiting follow-up note and next step.	en	{}	{"urgency": "medium", "touches_last_48h": 1}	2026-02-22 21:03:47.597158-05
\.


--
-- Data for Name: Lead; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Lead" (id, team_id, owner_agent_id, state, source, primary_email, primary_phone, last_touch_at, next_action_at, created_at, updated_at) FROM stdin;
00000000-0000-0000-0000-000000000100	00000000-0000-0000-0000-000000000010	00000000-0000-0000-0000-000000000001	New	email	sample-lead@example.com	+15550000000	\N	2026-02-22 20:48:47.603-05	2026-02-19 21:22:18.595457-05	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000101	00000000-0000-0000-0000-000000000010	00000000-0000-0000-0000-000000000001	Active	sms	maria.gomez@example.com	+15550000001	2026-02-22 17:03:47.603-05	2026-02-22 21:33:47.603-05	2026-02-21 20:45:27.655196-05	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000102	00000000-0000-0000-0000-000000000010	00000000-0000-0000-0000-000000000001	At-Risk	call	andrew.choi@example.com	+15550000002	2026-02-21 07:03:47.603-05	2026-02-22 20:53:47.603-05	2026-02-21 20:45:27.655196-05	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000103	00000000-0000-0000-0000-000000000010	00000000-0000-0000-0000-000000000001	Stale	email	zoe.patel@example.com	+15550000003	2026-02-20 09:03:47.603-05	2026-02-22 16:03:47.603-05	2026-02-21 20:45:27.655196-05	2026-02-22 21:03:47.597158-05
00000000-0000-0000-0000-000000000104	00000000-0000-0000-0000-000000000010	00000000-0000-0000-0000-000000000001	Active	manual	devon.lee@example.com	+15550000004	2026-02-22 19:48:47.603-05	2026-02-22 23:03:47.603-05	2026-02-21 20:45:27.655196-05	2026-02-22 21:03:47.597158-05
\.


--
-- Data for Name: MailboxConnection; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."MailboxConnection" (id, user_id, provider, email_address, mailbox_type, delegated_from, status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: PhoneNumber; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."PhoneNumber" (id, team_id, provider, number, capabilities, status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: Task; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Task" (id, lead_id, owner_id, due_at, status, type, created_at) FROM stdin;
00000000-0000-0000-0000-000000000200	00000000-0000-0000-0000-000000000100	00000000-0000-0000-0000-000000000001	2026-02-22 20:43:47.643-05	open	contact_now	2026-02-19 21:22:18.595457-05
00000000-0000-0000-0000-000000000201	00000000-0000-0000-0000-000000000101	00000000-0000-0000-0000-000000000001	2026-02-22 21:28:47.643-05	open	follow_up	2026-02-21 20:45:27.655196-05
00000000-0000-0000-0000-000000000202	00000000-0000-0000-0000-000000000102	00000000-0000-0000-0000-000000000001	2026-02-22 20:55:47.643-05	open	follow_up	2026-02-21 20:45:27.655196-05
00000000-0000-0000-0000-000000000203	00000000-0000-0000-0000-000000000103	00000000-0000-0000-0000-000000000001	2026-02-22 21:00:47.643-05	open	rescue	2026-02-21 20:45:27.655196-05
00000000-0000-0000-0000-000000000204	00000000-0000-0000-0000-000000000104	00000000-0000-0000-0000-000000000001	2026-02-22 22:33:47.643-05	open	call_outcome	2026-02-21 20:45:27.655196-05
00000000-0000-0000-0000-000000000205	00000000-0000-0000-0000-000000000101	00000000-0000-0000-0000-000000000001	2026-02-22 09:03:47.643-05	done	manual	2026-02-21 20:45:27.655196-05
\.


--
-- Data for Name: Team; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Team" (id, stale_rules, sla_rules, escalation_rules) FROM stdin;
00000000-0000-0000-0000-000000000010	{"timezone": "UTC", "active_stale_hours": 48, "new_lead_sla_minutes": 60, "at_risk_threshold_percent": 80}	{"escalation_enabled": true, "response_target_minutes": 60}	{"templates": [{"id": "00000000-0000-0000-0000-000000000301", "body": "Hi {{first_name}}, just checking in. I am available for a quick call whenever works for you.", "name": "Friendly Follow-Up Email", "channel": "email", "language": "en", "updated_at": "2026-02-23T02:03:47.572Z"}, {"id": "00000000-0000-0000-0000-000000000302", "body": "Quick check-in from your real estate team. Want me to send over next-step options?", "name": "Rescue SMS Touch", "channel": "sms", "language": "en", "updated_at": "2026-02-23T02:03:47.572Z"}], "rescue_sequences": [{"id": "00000000-0000-0000-0000-000000000401", "name": "Default Stale Rescue", "steps": [{"id": "00000000-0000-0000-0000-000000000411", "channel": "task", "enabled": true, "offset_minutes": 0, "requires_human_send": true}, {"id": "00000000-0000-0000-0000-000000000412", "channel": "sms", "enabled": true, "template_id": "00000000-0000-0000-0000-000000000302", "offset_minutes": 15, "requires_human_send": true}, {"id": "00000000-0000-0000-0000-000000000413", "channel": "email", "enabled": true, "template_id": "00000000-0000-0000-0000-000000000301", "offset_minutes": 120, "requires_human_send": true}], "language": "en", "updated_at": "2026-02-23T02:03:47.572Z"}]}
\.


--
-- Data for Name: User; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."User" (id, team_id, role, language) FROM stdin;
00000000-0000-0000-0000-000000000001	00000000-0000-0000-0000-000000000010	AGENT	en
00000000-0000-0000-0000-000000000002	00000000-0000-0000-0000-000000000010	TEAM_LEAD	en
\.


--
-- Name: Attachment Attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Attachment"
    ADD CONSTRAINT "Attachment_pkey" PRIMARY KEY (id);


--
-- Name: AuditLog AuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);


--
-- Name: ConversationEvent ConversationEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY (id);


--
-- Name: DerivedLeadProfile DerivedLeadProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DerivedLeadProfile"
    ADD CONSTRAINT "DerivedLeadProfile_pkey" PRIMARY KEY (lead_id);


--
-- Name: Lead Lead_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_pkey" PRIMARY KEY (id);


--
-- Name: MailboxConnection MailboxConnection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailboxConnection"
    ADD CONSTRAINT "MailboxConnection_pkey" PRIMARY KEY (id);


--
-- Name: MailboxConnection MailboxConnection_user_id_provider_email_address_mailbox_ty_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailboxConnection"
    ADD CONSTRAINT "MailboxConnection_user_id_provider_email_address_mailbox_ty_key" UNIQUE (user_id, provider, email_address, mailbox_type, delegated_from);


--
-- Name: PhoneNumber PhoneNumber_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PhoneNumber"
    ADD CONSTRAINT "PhoneNumber_number_key" UNIQUE (number);


--
-- Name: PhoneNumber PhoneNumber_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PhoneNumber"
    ADD CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY (id);


--
-- Name: Task Task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_pkey" PRIMARY KEY (id);


--
-- Name: Team Team_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Team"
    ADD CONSTRAINT "Team_pkey" PRIMARY KEY (id);


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: idx_attachment_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_event ON public."Attachment" USING btree (conversation_event_id);


--
-- Name: idx_attachment_filename; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_filename ON public."Attachment" USING btree (lower(filename));


--
-- Name: idx_attachment_mime; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_mime ON public."Attachment" USING btree (mime_type);


--
-- Name: idx_audit_actor_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_actor_time ON public."AuditLog" USING btree (actor_id, "timestamp" DESC);


--
-- Name: idx_audit_lead_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_lead_time ON public."AuditLog" USING btree (lead_id, "timestamp" DESC);


--
-- Name: idx_event_channel_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_channel_created_at ON public."ConversationEvent" USING btree (channel, created_at DESC);


--
-- Name: idx_event_lead_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_lead_created_at ON public."ConversationEvent" USING btree (lead_id, created_at DESC);


--
-- Name: idx_event_mailbox_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_mailbox_created_at ON public."ConversationEvent" USING btree (mailbox_connection_id, created_at DESC);


--
-- Name: idx_event_phone_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_phone_created_at ON public."ConversationEvent" USING btree (phone_number_id, created_at DESC);


--
-- Name: idx_lead_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_email ON public."Lead" USING btree (primary_email);


--
-- Name: idx_lead_last_touch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_last_touch ON public."Lead" USING btree (last_touch_at);


--
-- Name: idx_lead_owner_state_next_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_owner_state_next_action ON public."Lead" USING btree (owner_agent_id, state, next_action_at);


--
-- Name: idx_lead_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_phone ON public."Lead" USING btree (primary_phone);


--
-- Name: idx_lead_team_state_next_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_team_state_next_action ON public."Lead" USING btree (team_id, state, next_action_at);


--
-- Name: idx_mailbox_provider_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mailbox_provider_email ON public."MailboxConnection" USING btree (provider, email_address);


--
-- Name: idx_mailbox_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mailbox_user_status ON public."MailboxConnection" USING btree (user_id, status);


--
-- Name: idx_phone_team_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_team_status ON public."PhoneNumber" USING btree (team_id, status);


--
-- Name: idx_profile_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_language ON public."DerivedLeadProfile" USING btree (language);


--
-- Name: idx_profile_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_updated_at ON public."DerivedLeadProfile" USING btree (updated_at DESC);


--
-- Name: idx_task_lead_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_lead_status_due ON public."Task" USING btree (lead_id, status, due_at);


--
-- Name: idx_task_owner_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_owner_status_due ON public."Task" USING btree (owner_id, status, due_at);


--
-- Name: idx_user_team_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_team_role ON public."User" USING btree (team_id, role);


--
-- Name: ux_event_call_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_event_call_provider_id ON public."ConversationEvent" USING btree (phone_number_id, provider_event_id) WHERE ((channel = 'call'::text) AND (provider_event_id IS NOT NULL));


--
-- Name: ux_event_email_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_event_email_provider_id ON public."ConversationEvent" USING btree (mailbox_connection_id, provider_event_id) WHERE ((channel = 'email'::text) AND (provider_event_id IS NOT NULL));


--
-- Name: ux_event_sms_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_event_sms_provider_id ON public."ConversationEvent" USING btree (phone_number_id, provider_event_id) WHERE ((channel = 'sms'::text) AND (provider_event_id IS NOT NULL));


--
-- Name: DerivedLeadProfile trg_derived_profile_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_derived_profile_updated_at BEFORE UPDATE ON public."DerivedLeadProfile" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: Lead trg_lead_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lead_updated_at BEFORE UPDATE ON public."Lead" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: MailboxConnection trg_mailbox_connection_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mailbox_connection_updated_at BEFORE UPDATE ON public."MailboxConnection" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: PhoneNumber trg_phone_number_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_phone_number_updated_at BEFORE UPDATE ON public."PhoneNumber" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: Attachment Attachment_conversation_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Attachment"
    ADD CONSTRAINT "Attachment_conversation_event_id_fkey" FOREIGN KEY (conversation_event_id) REFERENCES public."ConversationEvent"(id) ON DELETE CASCADE;


--
-- Name: AuditLog AuditLog_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES public."User"(id) ON DELETE RESTRICT;


--
-- Name: AuditLog AuditLog_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES public."Lead"(id) ON DELETE CASCADE;


--
-- Name: ConversationEvent ConversationEvent_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES public."Lead"(id) ON DELETE CASCADE;


--
-- Name: ConversationEvent ConversationEvent_mailbox_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_mailbox_connection_id_fkey" FOREIGN KEY (mailbox_connection_id) REFERENCES public."MailboxConnection"(id) ON DELETE SET NULL;


--
-- Name: ConversationEvent ConversationEvent_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_phone_number_id_fkey" FOREIGN KEY (phone_number_id) REFERENCES public."PhoneNumber"(id) ON DELETE SET NULL;


--
-- Name: DerivedLeadProfile DerivedLeadProfile_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DerivedLeadProfile"
    ADD CONSTRAINT "DerivedLeadProfile_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES public."Lead"(id) ON DELETE CASCADE;


--
-- Name: Lead Lead_owner_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_owner_agent_id_fkey" FOREIGN KEY (owner_agent_id) REFERENCES public."User"(id) ON DELETE RESTRICT;


--
-- Name: Lead Lead_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public."Team"(id) ON DELETE CASCADE;


--
-- Name: MailboxConnection MailboxConnection_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailboxConnection"
    ADD CONSTRAINT "MailboxConnection_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: PhoneNumber PhoneNumber_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PhoneNumber"
    ADD CONSTRAINT "PhoneNumber_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public."Team"(id) ON DELETE CASCADE;


--
-- Name: Task Task_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES public."Lead"(id) ON DELETE CASCADE;


--
-- Name: Task Task_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES public."User"(id) ON DELETE RESTRICT;


--
-- Name: User User_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public."Team"(id) ON DELETE RESTRICT;


--
-- Name: Attachment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Attachment" ENABLE ROW LEVEL SECURITY;

--
-- Name: AuditLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: ConversationEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ConversationEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: DerivedLeadProfile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DerivedLeadProfile" ENABLE ROW LEVEL SECURITY;

--
-- Name: Lead; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Lead" ENABLE ROW LEVEL SECURITY;

--
-- Name: MailboxConnection; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MailboxConnection" ENABLE ROW LEVEL SECURITY;

--
-- Name: PhoneNumber; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PhoneNumber" ENABLE ROW LEVEL SECURITY;

--
-- Name: Task; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Task" ENABLE ROW LEVEL SECURITY;

--
-- Name: Team; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Team" ENABLE ROW LEVEL SECURITY;

--
-- Name: User; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

--
-- Name: Attachment attachment_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attachment_insert_policy ON public."Attachment" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public."ConversationEvent" e
     JOIN public."Lead" l ON ((l.id = e.lead_id)))
  WHERE ((e.id = "Attachment".conversation_event_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text)))))));


--
-- Name: Attachment attachment_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attachment_select_policy ON public."Attachment" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public."ConversationEvent" e
     JOIN public."Lead" l ON ((l.id = e.lead_id)))
  WHERE ((e.id = "Attachment".conversation_event_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text)))))));


--
-- Name: AuditLog audit_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_insert_policy ON public."AuditLog" FOR INSERT WITH CHECK (((actor_id = public.app_user_id()) AND (EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "AuditLog".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id())))))));


--
-- Name: AuditLog audit_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_select_policy ON public."AuditLog" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "AuditLog".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: DerivedLeadProfile derived_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY derived_insert_policy ON public."DerivedLeadProfile" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "DerivedLeadProfile".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: DerivedLeadProfile derived_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY derived_select_policy ON public."DerivedLeadProfile" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "DerivedLeadProfile".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: DerivedLeadProfile derived_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY derived_update_policy ON public."DerivedLeadProfile" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "DerivedLeadProfile".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id())))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "DerivedLeadProfile".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: ConversationEvent event_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_insert_policy ON public."ConversationEvent" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "ConversationEvent".lead_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text)))))));


--
-- Name: ConversationEvent event_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_select_policy ON public."ConversationEvent" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "ConversationEvent".lead_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text)))))));


--
-- Name: ConversationEvent event_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_update_policy ON public."ConversationEvent" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "ConversationEvent".lead_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "ConversationEvent".lead_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id())) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (l.state = 'Stale'::text)))))));


--
-- Name: Lead lead_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_delete_policy ON public."Lead" FOR DELETE USING (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- Name: Lead lead_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_insert_policy ON public."Lead" FOR INSERT WITH CHECK (((team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (owner_agent_id = public.app_user_id()))));


--
-- Name: Lead lead_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_select_policy ON public."Lead" FOR SELECT USING (((team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (owner_agent_id = public.app_user_id()))));


--
-- Name: Lead lead_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_update_policy ON public."Lead" FOR UPDATE USING (((team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (owner_agent_id = public.app_user_id())))) WITH CHECK (((team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (owner_agent_id = public.app_user_id()))));


--
-- Name: MailboxConnection mailbox_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mailbox_insert_policy ON public."MailboxConnection" FOR INSERT WITH CHECK (((user_id = public.app_user_id()) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (EXISTS ( SELECT 1
   FROM public."User" u
  WHERE ((u.id = "MailboxConnection".user_id) AND (u.team_id = public.app_team_id())))))));


--
-- Name: MailboxConnection mailbox_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mailbox_select_policy ON public."MailboxConnection" FOR SELECT USING (((user_id = public.app_user_id()) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (EXISTS ( SELECT 1
   FROM public."User" u
  WHERE ((u.id = "MailboxConnection".user_id) AND (u.team_id = public.app_team_id())))))));


--
-- Name: MailboxConnection mailbox_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mailbox_update_policy ON public."MailboxConnection" FOR UPDATE USING (((user_id = public.app_user_id()) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (EXISTS ( SELECT 1
   FROM public."User" u
  WHERE ((u.id = "MailboxConnection".user_id) AND (u.team_id = public.app_team_id()))))))) WITH CHECK (((user_id = public.app_user_id()) OR ((public.app_role() = 'TEAM_LEAD'::text) AND (EXISTS ( SELECT 1
   FROM public."User" u
  WHERE ((u.id = "MailboxConnection".user_id) AND (u.team_id = public.app_team_id())))))));


--
-- Name: PhoneNumber phone_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY phone_insert_policy ON public."PhoneNumber" FOR INSERT WITH CHECK (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- Name: PhoneNumber phone_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY phone_select_policy ON public."PhoneNumber" FOR SELECT USING ((team_id = public.app_team_id()));


--
-- Name: PhoneNumber phone_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY phone_update_policy ON public."PhoneNumber" FOR UPDATE USING (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text))) WITH CHECK (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- Name: Task task_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY task_insert_policy ON public."Task" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "Task".lead_id) AND (l.team_id = public.app_team_id()) AND (((public.app_role() = 'AGENT'::text) AND (l.owner_agent_id = public.app_user_id()) AND ("Task".owner_id = public.app_user_id())) OR (public.app_role() = 'TEAM_LEAD'::text))))));


--
-- Name: Task task_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY task_select_policy ON public."Task" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "Task".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: Task task_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY task_update_policy ON public."Task" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "Task".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id())))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Lead" l
  WHERE ((l.id = "Task".lead_id) AND (l.team_id = public.app_team_id()) AND ((public.app_role() = 'TEAM_LEAD'::text) OR (l.owner_agent_id = public.app_user_id()))))));


--
-- Name: Team team_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_select_policy ON public."Team" FOR SELECT USING ((id = public.app_team_id()));


--
-- Name: Team team_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_update_policy ON public."Team" FOR UPDATE USING (((id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text))) WITH CHECK (((id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- Name: User user_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_policy ON public."User" FOR INSERT WITH CHECK (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- Name: User user_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_select_policy ON public."User" FOR SELECT USING ((team_id = public.app_team_id()));


--
-- Name: User user_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_policy ON public."User" FOR UPDATE USING (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text))) WITH CHECK (((team_id = public.app_team_id()) AND (public.app_role() = 'TEAM_LEAD'::text)));


--
-- PostgreSQL database dump complete
--

\unrestrict duoLCCd2pT42jsd2DHGp8dYjIpMHQiBDPUKlExv6UYNnbTA8f0hyIKRd0CR1NO2

