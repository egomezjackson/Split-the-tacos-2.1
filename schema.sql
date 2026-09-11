-- ============================================================
--  Split the bill — database
--  Supabase > SQL Editor > New query > paste > Run
--
--  Safe to run again at any time. Nothing here deletes a table or a
--  row: every step checks whether it's already been done and skips it
--  if so. Upgrading from version 1 is just pasting this whole file and
--  pressing Run.
-- ============================================================

-- The id is the short code in the URL: yoursite.com/?c=a7f3k2
-- It's what the QR code points at, and it's the only thing guarding
-- the bill, so it must be random. Never sequential.
create table if not exists bills (
  id          text primary key,
  merchant    text,
  payer_name  text,
  created_at  timestamptz not null default now(),

  -- always integer cents. never floats — they lose pennies silently.
  total_cents integer not null default 0,   -- what hit the card. ground truth.
  tax_cents   integer not null default 0,   -- shown for transparency only
  tip_cents   integer not null default 0,
  fee_cents   integer not null default 0
);

-- One row per receipt line. Two of the same drink becomes two rows so
-- two people can each claim one.
create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  bill_id     text not null references bills(id) on delete cascade,
  name        text not null default '',
  price_cents integer not null default 0,
  position    integer not null default 0
);
create index if not exists items_bill_id_idx on items (bill_id);

-- A person at the table. No account. device_id is a random string their
-- browser remembers, so it knows which claims are theirs.
create table if not exists diners (
  id        uuid primary key default gen_random_uuid(),
  bill_id   text not null references bills(id) on delete cascade,
  device_id text,
  name      text not null,
  color     text not null default '#1F5F5B',
  done      boolean not null default false,   -- "I've picked everything I had"
  joined_at timestamptz not null default now()
);
create index if not exists diners_bill_id_idx on diners (bill_id);

-- Who tapped what. The row existing IS the claim.
create table if not exists claims (
  item_id  uuid not null references items(id)  on delete cascade,
  diner_id uuid not null references diners(id) on delete cascade,
  primary key (item_id, diner_id)
);

-- ------------------------------------------------------------
--  Version 2: paying the payer back
--  Only adds columns. No new tables. Old bills get empty values
--  and carry on working exactly as they did.
-- ------------------------------------------------------------

-- Whose phone made the bill. That phone gets the "received" boxes.
-- A role marker, not a security boundary — same trust as claiming items.
alter table bills add column if not exists collector_device text;

-- Up to three ways to pay, typed by the payer: "Venmo" + a link,
-- "Zelle" + a phone number. Stored as typed, no validation.
alter table bills add column if not exists pay1_label text not null default '';
alter table bills add column if not exists pay1_value text not null default '';
alter table bills add column if not exists pay2_label text not null default '';
alter table bills add column if not exists pay2_value text not null default '';
alter table bills add column if not exists pay3_label text not null default '';
alter table bills add column if not exists pay3_value text not null default '';

-- A shared ledger, not evidence. Either side can tick sent; only the
-- collector's phone shows received, and received is what finishes it.
alter table diners add column if not exists sent     boolean not null default false;
alter table diners add column if not exists received boolean not null default false;

-- ------------------------------------------------------------
--  Realtime: every phone at the table updates the instant someone taps.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bills', 'items', 'diners', 'claims'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
--  Who can do what.
--  Anyone with the link can read the bill and claim items. That's the
--  point — you're handing the link out by QR at a table. Creating a bill
--  goes through the server, so there's no insert policy on `bills`.
--  rename_self also covers ticking sent and received.
-- ------------------------------------------------------------
alter table bills  enable row level security;
alter table items  enable row level security;
alter table diners enable row level security;
alter table claims enable row level security;

do $$
declare p text[];
begin
  foreach p slice 1 in array array[
    -- name,          table,    rule
    ['read_bills',    'bills',  'for select using (true)'],
    ['read_items',    'items',  'for select using (true)'],
    ['read_diners',   'diners', 'for select using (true)'],
    ['read_claims',   'claims', 'for select using (true)'],
    ['join_table',    'diners', 'for insert with check (true)'],
    ['rename_self',   'diners', 'for update using (true)'],
    ['make_claim',    'claims', 'for insert with check (true)'],
    ['drop_claim',    'claims', 'for delete using (true)']
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = p[2] and policyname = p[1]
    ) then
      execute format('create policy %I on public.%I %s', p[1], p[2], p[3]);
    end if;
  end loop;
end $$;
