-- ProjectK - credit card statement import (Phase 1: schema only)
--
-- Scope:
--   * credit_card_providers      (extensible provider registry, read-only reference data)
--   * credit_card_statements     (one imported statement per provider/card/period)
--   * credit_card_transactions   (normalized transaction lines)
--   * merchant_category_rules    (merchant -> ProjectK budget category mappings)
--
-- Deliberately NOT stored: card numbers in any form (not even the last four
-- digits), bank account numbers, KID numbers, customer names/addresses, or raw
-- PDF bytes/text. Where several cards must be told apart, use provider_code plus
-- the user-supplied card_alias.
--
-- This migration does not touch budget_entries, budget_categories,
-- budget_parent_categories or budget_income, and does not change their RLS.


-- ---------------------------------------------------------------------------
-- 1. Shared helper
-- ---------------------------------------------------------------------------

create or replace function public.set_credit_card_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Provider registry
--
-- New providers / statement formats are added as ROWS, never as schema or
-- enum changes, so parsers and analytics stay untouched when a card is added.
-- ---------------------------------------------------------------------------

create table if not exists public.credit_card_providers (
  code          text primary key
                check (code ~ '^[a-z0-9_]{2,40}$'),
  display_name  text not null,
  country_code  text not null default 'NO'
                check (country_code ~ '^[A-Z]{2}$'),
  default_currency text not null default 'NOK'
                check (default_currency ~ '^[A-Z]{3}$'),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.credit_card_providers is
  'Reference list of supported credit card issuers. Adding a provider is a data change, not a schema change.';

insert into public.credit_card_providers (code, display_name)
values
  ('trumf',          'Trumf Kredittkort'),
  ('bank_norwegian', 'Bank Norwegian')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- 3. Statements
-- ---------------------------------------------------------------------------

create table if not exists public.credit_card_statements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null
                  references auth.users (id) on delete cascade,

  -- provider / card identity
  provider_code   text not null
                  references public.credit_card_providers (code),
  card_alias      text,

  -- statement identity & period
  statement_number text,
  period_start    date not null,
  period_end      date not null,
  invoice_date    date,
  due_date        date,

  -- totals
  total_amount    numeric(14,2),
  currency        text not null default 'NOK'
                  check (currency ~ '^[A-Z]{3}$'),

  -- import provenance (format-agnostic, no raw document content)
  source_format   text,
  source_file_name text,
  source_file_hash text
                  check (source_file_hash ~ '^[a-f0-9]{64}$'),
  parser_version  text,
  imported_at     timestamptz not null default now(),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint credit_card_statements_period_valid
    check (period_end >= period_start),

  -- lets child rows prove ownership through a composite foreign key
  constraint credit_card_statements_user_id_id_key unique (user_id, id)
);

comment on column public.credit_card_statements.card_alias is
  'User-chosen label such as "Trumf privat". The only card distinguisher stored; no part of the card number is persisted.';
comment on column public.credit_card_statements.source_file_hash is
  'SHA-256 of the uploaded PDF, computed client side. Used for duplicate import detection; the file itself is not stored.';

-- One statement per card and period.
create unique index if not exists credit_card_statements_period_uidx
  on public.credit_card_statements (
    user_id, provider_code, coalesce(card_alias, ''), period_start, period_end
  );

-- Same file uploaded twice.
create unique index if not exists credit_card_statements_file_hash_uidx
  on public.credit_card_statements (user_id, source_file_hash)
  where source_file_hash is not null;

-- Provider's own statement/invoice number, when the PDF exposes one.
create unique index if not exists credit_card_statements_number_uidx
  on public.credit_card_statements (user_id, provider_code, statement_number)
  where statement_number is not null;

create index if not exists credit_card_statements_user_period_idx
  on public.credit_card_statements (user_id, period_start desc);

drop trigger if exists set_credit_card_statements_updated_at
  on public.credit_card_statements;
create trigger set_credit_card_statements_updated_at
  before update on public.credit_card_statements
  for each row execute function public.set_credit_card_updated_at();


-- ---------------------------------------------------------------------------
-- 4. Transactions
--
-- Amount sign convention: spending is positive, money back (refunds, payments)
-- is negative, in both original_amount and amount_nok.
--
-- duplicate_sequence contract: the parser MUST assign it deterministically from
-- the transaction's ordinal position among otherwise-identical lines within the
-- statement, counting in the order the lines appear in the PDF (1, 2, 3, ...).
-- It must never come from a counter, a timestamp, insertion order or a database
-- lookup. Parsing the same PDF again must therefore yield the same
-- duplicate_sequence values, hence the same dedupe_key, hence no new rows.
-- ---------------------------------------------------------------------------

create table if not exists public.credit_card_transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null
                     references auth.users (id) on delete cascade,

  statement_id       uuid not null,
  provider_code      text not null
                     references public.credit_card_providers (code),
  card_alias         text,

  -- dates
  transaction_date   date not null,
  posting_date       date,

  -- merchant
  raw_description    text not null,
  normalized_merchant text,
  merchant_location  text,
  merchant_country   text
                     check (merchant_country ~ '^[A-Z]{2}$'),

  -- amounts
  original_amount    numeric(14,2) not null,
  original_currency  text not null default 'NOK'
                     check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate      numeric(18,8)
                     check (exchange_rate > 0),
  amount_nok         numeric(14,2) not null,

  transaction_type   text not null default 'purchase'
                     check (transaction_type in (
                       'purchase', 'refund', 'payment', 'fee',
                       'interest', 'cash_withdrawal', 'other'
                     )),

  -- categorisation (budget_category_id is added in section 6)
  category_source    text not null default 'uncategorized'
                     check (category_source in (
                       'uncategorized', 'rule', 'manual', 'imported'
                     )),

  -- duplicate detection
  external_ref       text,
  duplicate_sequence smallint not null default 1
                     check (duplicate_sequence > 0),
  dedupe_key         text generated always as (
                       md5(
                         user_id::text
                         || '|' || provider_code
                         || '|' || coalesce(card_alias, '')
                         || '|' || (transaction_date - date '1970-01-01')::text
                         || '|' || lower(btrim(raw_description))
                         || '|' || original_amount::text
                         || '|' || original_currency
                         || '|' || amount_nok::text
                         || '|' || transaction_type
                         || '|' || duplicate_sequence::text
                       )
                     ) stored,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- a transaction can only point at a statement owned by the same user
  constraint credit_card_transactions_statement_fkey
    foreign key (user_id, statement_id)
    references public.credit_card_statements (user_id, id)
    on delete cascade
);

comment on column public.credit_card_transactions.duplicate_sequence is
  'Ordinal of this line among identical lines in the same statement, assigned by the parser from PDF order (1, 2, 3...). Must be reproducible across re-imports: never derive it from insertion order, clocks or existing rows.';
comment on column public.credit_card_transactions.dedupe_key is
  'Deterministic hash of the natural key. Target for ON CONFLICT during idempotent re-imports.';

create unique index if not exists credit_card_transactions_dedupe_uidx
  on public.credit_card_transactions (user_id, dedupe_key);

-- Provider-issued reference id, when present, is authoritative on its own.
create unique index if not exists credit_card_transactions_external_ref_uidx
  on public.credit_card_transactions (user_id, provider_code, external_ref)
  where external_ref is not null;

create index if not exists credit_card_transactions_statement_idx
  on public.credit_card_transactions (statement_id);

create index if not exists credit_card_transactions_user_date_idx
  on public.credit_card_transactions (user_id, transaction_date desc);

create index if not exists credit_card_transactions_merchant_idx
  on public.credit_card_transactions (user_id, normalized_merchant);

drop trigger if exists set_credit_card_transactions_updated_at
  on public.credit_card_transactions;
create trigger set_credit_card_transactions_updated_at
  before update on public.credit_card_transactions
  for each row execute function public.set_credit_card_updated_at();


-- ---------------------------------------------------------------------------
-- 5. Merchant -> category mapping rules
-- ---------------------------------------------------------------------------

create table if not exists public.merchant_category_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null
                references auth.users (id) on delete cascade,

  match_type    text not null default 'contains'
                check (match_type in ('exact', 'prefix', 'contains', 'regex')),
  match_value   text not null
                check (btrim(match_value) <> ''),

  normalized_merchant text,
  priority      smallint not null default 100,
  is_active     boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists merchant_category_rules_uidx
  on public.merchant_category_rules (user_id, match_type, lower(match_value));

create index if not exists merchant_category_rules_lookup_idx
  on public.merchant_category_rules (user_id, is_active, priority);

drop trigger if exists set_merchant_category_rules_updated_at
  on public.merchant_category_rules;
create trigger set_merchant_category_rules_updated_at
  before update on public.merchant_category_rules
  for each row execute function public.set_credit_card_updated_at();


-- ---------------------------------------------------------------------------
-- 6. Link to the existing ProjectK budget categories
--
-- public.budget_categories is not managed by this repository's migrations and
-- its id type is not known ahead of time, so the column is created with the
-- same type as the live column and the FK is added only if the table exists.
-- If it is missing (e.g. a shadow database built from migrations only), the
-- migration logs a notice instead of failing, and the link can be added later.
-- ---------------------------------------------------------------------------

do $$
declare
  v_type text;
  v_tbl  text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into v_type
  from pg_attribute a
  join pg_class c     on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'budget_categories'
    and a.attname = 'id'
    and a.attnum > 0
    and not a.attisdropped;

  if v_type is null then
    raise notice
      'public.budget_categories not found - budget_category_id column skipped. Re-run section 6 once the budget schema is present.';
    return;
  end if;

  foreach v_tbl in array array[
    'credit_card_transactions',
    'merchant_category_rules'
  ]
  loop
    execute format(
      'alter table public.%I add column if not exists budget_category_id %s',
      v_tbl, v_type
    );

    if not exists (
      select 1
      from pg_constraint
      where conname = v_tbl || '_budget_category_fkey'
        and connamespace = 'public'::regnamespace
    ) then
      execute format(
        'alter table public.%I
           add constraint %I
           foreign key (budget_category_id)
           references public.budget_categories (id)
           on delete set null',
        v_tbl, v_tbl || '_budget_category_fkey'
      );
    end if;

    execute format(
      'create index if not exists %I on public.%I (user_id, budget_category_id)',
      v_tbl || '_budget_category_idx', v_tbl
    );
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- 7. Row level security
-- ---------------------------------------------------------------------------

alter table public.credit_card_providers    enable row level security;
alter table public.credit_card_statements   enable row level security;
alter table public.credit_card_transactions enable row level security;
alter table public.merchant_category_rules  enable row level security;

-- Providers: shared reference data, readable by any signed-in user, writable
-- only through the service role (which bypasses RLS).
drop policy if exists "Providers are readable by authenticated users"
  on public.credit_card_providers;
create policy "Providers are readable by authenticated users"
  on public.credit_card_providers
  for select
  to authenticated
  using (true);

-- Statements
drop policy if exists "Users read own statements" on public.credit_card_statements;
create policy "Users read own statements"
  on public.credit_card_statements
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own statements" on public.credit_card_statements;
create policy "Users insert own statements"
  on public.credit_card_statements
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own statements" on public.credit_card_statements;
create policy "Users update own statements"
  on public.credit_card_statements
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own statements" on public.credit_card_statements;
create policy "Users delete own statements"
  on public.credit_card_statements
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Transactions
drop policy if exists "Users read own transactions" on public.credit_card_transactions;
create policy "Users read own transactions"
  on public.credit_card_transactions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own transactions" on public.credit_card_transactions;
create policy "Users insert own transactions"
  on public.credit_card_transactions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own transactions" on public.credit_card_transactions;
create policy "Users update own transactions"
  on public.credit_card_transactions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own transactions" on public.credit_card_transactions;
create policy "Users delete own transactions"
  on public.credit_card_transactions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Merchant rules
drop policy if exists "Users read own merchant rules" on public.merchant_category_rules;
create policy "Users read own merchant rules"
  on public.merchant_category_rules
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own merchant rules" on public.merchant_category_rules;
create policy "Users insert own merchant rules"
  on public.merchant_category_rules
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own merchant rules" on public.merchant_category_rules;
create policy "Users update own merchant rules"
  on public.merchant_category_rules
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own merchant rules" on public.merchant_category_rules;
create policy "Users delete own merchant rules"
  on public.merchant_category_rules
  for delete to authenticated
  using ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- 8. Grants (RLS still applies on top of these)
-- ---------------------------------------------------------------------------

grant select on public.credit_card_providers to authenticated;

grant select, insert, update, delete
  on public.credit_card_statements,
     public.credit_card_transactions,
     public.merchant_category_rules
  to authenticated;
