-- Ledger push-notification support. Safe to run repeatedly: this only creates
-- new tables, policies, indexes, and one dedicated RPC. It does not alter or
-- delete Ledger's existing tables or rows.

create table if not exists public.push_subscriptions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

create table if not exists public.notification_follows (
  subscriber_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  followed_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (subscriber_id, followed_user_id),
  constraint notification_follows_not_self check (subscriber_id <> followed_user_id)
);

create index if not exists notification_follows_followed_user_id_idx
  on public.notification_follows (followed_user_id);

alter table public.push_subscriptions enable row level security;
alter table public.notification_follows enable row level security;

-- Users may only manage subscriptions belonging to their own account.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'Users manage their own push subscriptions'
  ) then
    create policy "Users manage their own push subscriptions"
      on public.push_subscriptions for all to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

-- Users may only manage their own follow/notification preferences.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_follows'
      and policyname = 'Users manage their own notification follows'
  ) then
    create policy "Users manage their own notification follows"
      on public.notification_follows for all to authenticated
      using (auth.uid() = subscriber_id)
      with check (auth.uid() = subscriber_id);
  end if;
end
$$;

grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.notification_follows to authenticated;
grant all on public.push_subscriptions, public.notification_follows to service_role;

-- Private server-side snapshot used to detect a change of #1. There is
-- intentionally no client-facing RLS policy for this table.
create table if not exists public.ledger_notification_state (
  board_key text primary key,
  top_user_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.ledger_notification_state enable row level security;
revoke all on public.ledger_notification_state from anon, authenticated;
grant all on public.ledger_notification_state to service_role;

-- Atomically return the previous leaders and save the current leaders.
-- A NULL return means this board is being initialized; the first event is
-- treated as a baseline so enabling notifications doesn't send old alerts.
create or replace function public.ledger_take_notification_snapshot(
  p_board_key text,
  p_top_user_ids uuid[]
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_board_key, 0));

  select top_user_ids into previous_ids
  from public.ledger_notification_state
  where board_key = p_board_key
  for update;

  if not found then
    insert into public.ledger_notification_state (board_key, top_user_ids)
    values (p_board_key, coalesce(p_top_user_ids, '{}'::uuid[]));
    return null;
  end if;

  update public.ledger_notification_state
  set top_user_ids = coalesce(p_top_user_ids, '{}'::uuid[]),
      updated_at = now()
  where board_key = p_board_key;

  return coalesce(previous_ids, '{}'::uuid[]);
end;
$$;

revoke all on function public.ledger_take_notification_snapshot(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.ledger_take_notification_snapshot(text, uuid[])
  to service_role;
