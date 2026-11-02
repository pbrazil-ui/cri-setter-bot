-- CRI Setter Bot schema. Paste into Supabase > SQL Editor > Run.
-- The server uses the service-role key, which bypasses RLS. RLS is enabled with
-- no policies so the anon/public key can read nothing.

create table if not exists listings (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  hubspot_deal_id text unique,        -- Sellers-pipeline deal this listing syncs from
  listing_code text,                  -- HubSpot listing_code, e.g. WALNUT-2026
  name text not null,                 -- e.g. "Hidden Harbor Marina & RV Park"
  aliases text[] not null default '{}', -- other names Crexi might use
  city text,
  status text not null default 'active', -- active | in_escrow | closed
  asking_price text,
  spaces text,
  summary text,                        -- 2-4 sentences the bot can share
  facts jsonb not null default '{}'::jsonb, -- anything else safe to share
  om_link text,
  ca_link text,                        -- where buyers sign the CA
  crexi_url text,
  hub_url text,                        -- listing hub page
  do_not_share text,                   -- notes the bot must NOT reveal
  dropbox_path text                    -- e.g. /Brokerage/01 - Brokerage/Deals/01 - Listed/Lighthouse Resort - Isleton, CA
);

create table if not exists leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null,                -- listing_email | csv | inbound_sms | webhook | manual
  platform text,                       -- crexi | loopnet | rvparkstore | mhvillage | website | ...
  first_name text,
  last_name text,
  email text,
  phone text unique,                   -- E.164, e.g. +19495551234
  company text,
  role text,
  property_name text,
  listing_id bigint references listings(id),
  listing_code text,
  hubspot_deals jsonb not null default '{}'::jsonb, -- { listing_code: buyer deal id }
  inquiry text,
  status text not null default 'new',
  -- in_dd (CA signed, reviewing docs) | new | awaiting_approval | contacted | engaged | qualified | booked | escalated
  -- | human | disqualified | no_response | opted_out | no_phone
  auto_send boolean not null default false,
  qualification jsonb not null default '{}'::jsonb,
  summary text,
  followup_count int not null default 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  next_action_at timestamptz,
  hubspot_contact_id text,
  preferred_channel text not null default 'sms', -- sms | email
  email_thread_subject text,
  email_last_message_id text,          -- Graph id of their last email, so replies thread
  ca_verified boolean not null default false, -- Pierce confirmed CA signed: confidential docs unlocked
  reply_due_at timestamptz,            -- human pacing: when the queued reply goes out
  reply_pending_since timestamptz,
  raw jsonb
);
create index if not exists leads_status_next on leads (status, next_action_at);
-- Nov 1 2026: email-then-text first contact. Safe to re-run this whole file.
alter table leads add column if not exists first_email_at timestamptz; -- first-contact email sent/drafted/queued; the text follows
-- Nov 2 2026: call tasks for Pierce and the deal's next step
alter table leads add column if not exists hubspot_tasks jsonb not null default '{}'::jsonb; -- key -> HubSpot task id (dedupe)
alter table leads add column if not exists next_step text;                                     -- mirrors the deal's Next step
alter table listings add column if not exists owner_id text;                                   -- HubSpot owner: Pierce 2145826500 / Dylan 683980338
create index if not exists leads_email on leads (lower(email));

create table if not exists messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id bigint not null references leads(id) on delete cascade,
  direction text not null,             -- in | out
  channel text not null default 'sms',  -- sms | email
  body text not null,
  status text not null,                -- received | sent | failed | scheduled | cancelled
  kind text,                           -- first_touch | reply | followup | owner_edit
  send_at timestamptz,
  rc_message_id text,
  meta jsonb
);
create index if not exists messages_lead on messages (lead_id, created_at);
create index if not exists messages_scheduled on messages (status, send_at);

create table if not exists approvals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  lead_id bigint not null references leads(id) on delete cascade,
  kind text not null,
  draft text not null,
  status text not null default 'pending', -- pending | approved | edited | rejected | superseded
  reason text,
  policy text,
  expires_at timestamptz,
  on_send jsonb not null default '{}'::jsonb -- lead fields to set once sent
);
create index if not exists approvals_pending on approvals (status, created_at);

create table if not exists opt_outs (
  phone text primary key,
  created_at timestamptz not null default now(),
  reason text
);

create table if not exists processed_events (
  id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb
);

-- ---------- Documents & knowledge ----------
create table if not exists documents (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  listing_id bigint references listings(id) on delete cascade, -- null = company SOP / global
  filename text not null,
  doc_type text not null,              -- rent_roll | t12 | om | qa | rules | utilities | compliance | sop | other
  tier text not null default 'sensitive',
  -- public: shareable to anyone | ca: only after CA verified | sensitive: bot may read, answers need Pierce's OK
  -- internal: guides the bot (SOPs), never quoted or sent
  dropbox_id text unique,
  dropbox_path text,
  content_hash text,
  status text not null default 'processed', -- processed | skipped | failed
  summary text,
  extracted jsonb                      -- t12 line items, extraction notes
);

create table if not exists doc_chunks (
  id bigint generated always as identity primary key,
  document_id bigint not null references documents(id) on delete cascade,
  listing_id bigint references listings(id) on delete cascade,
  tier text not null,
  content text not null
);
create index if not exists doc_chunks_listing on doc_chunks (listing_id);

-- tenant names are never stored
create table if not exists rent_roll_units (
  id bigint generated always as identity primary key,
  document_id bigint not null references documents(id) on delete cascade,
  listing_id bigint not null references listings(id) on delete cascade,
  space text,
  unit_type text,                      -- MH | RV | Park Model | Other
  ownership text,                      -- POH | TOH | null
  occupied boolean,
  rent numeric
);
create index if not exists rent_roll_listing on rent_roll_units (listing_id);

-- Pierce's approved answers. listing_id null = applies to every listing.
create table if not exists qa_bank (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  listing_id bigint references listings(id) on delete cascade,
  question text not null,
  answer text not null
);

-- questions the bot couldn't answer, waiting on Pierce
create table if not exists owner_questions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id bigint not null references leads(id) on delete cascade,
  listing_id bigint references listings(id),
  question text not null,
  status text not null default 'open', -- open | answered
  answer text,
  answered_at timestamptz
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event text not null,                 -- sent | drafted | approval_created | approved | rejected | edited | escalated | asked_pierce | answered | stage_moved | opted_out | policy_block | ...
  lead_id bigint,
  actor text not null default 'bot',   -- bot | pierce | system
  detail jsonb not null default '{}'::jsonb
);
create index if not exists audit_created on audit_log (created_at);

alter table audit_log enable row level security;
alter table documents enable row level security;
alter table doc_chunks enable row level security;
alter table rent_roll_units enable row level security;
alter table qa_bank enable row level security;
alter table owner_questions enable row level security;
alter table listings enable row level security;
alter table leads enable row level security;
alter table messages enable row level security;
alter table approvals enable row level security;
alter table opt_outs enable row level security;
alter table processed_events enable row level security;
alter table settings enable row level security;

-- Nov 2 2026: Render starts the new instance before stopping the old one on every deploy. Only the instance holding
-- this lease runs the send/follow-up loops, so two instances never text the same buyer. service_role only.
create or replace function claim_job_lease(p_holder text, p_ttl_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into settings (key, value) values ('job_lease', jsonb_build_object('holder', p_holder, 'until', now() + make_interval(secs => p_ttl_seconds)))
  on conflict (key) do update set value = excluded.value
    where settings.value->>'holder' = p_holder or coalesce((settings.value->>'until')::timestamptz, now()) <= now();
  return exists (select 1 from settings where key = 'job_lease' and value->>'holder' = p_holder);
end $$;
create or replace function release_job_lease(p_holder text)
returns void language sql security definer set search_path = public as $$
  update settings set value = jsonb_set(value, '{until}', to_jsonb(now() - interval '1 second'))
  where key = 'job_lease' and value->>'holder' = p_holder;
$$;
revoke all on function claim_job_lease(text, int) from public, anon, authenticated;
revoke all on function release_job_lease(text) from public, anon, authenticated;
grant execute on function claim_job_lease(text, int) to service_role;
grant execute on function release_job_lease(text) to service_role;
