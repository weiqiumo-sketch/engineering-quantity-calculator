begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '测量员',
  role text not null default 'tester' check (role in ('tester', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.measurement_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_id text not null,
  name text not null default '未命名单元',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, local_id)
);

create index if not exists measurement_records_user_updated_idx
  on public.measurement_records (user_id, updated_at desc);
create index if not exists measurement_records_updated_idx
  on public.measurement_records (updated_at desc);

create table if not exists public.app_admin_config (
  id boolean primary key default true check (id),
  access_code text not null
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.measurement_records enable row level security;
alter table public.app_admin_config enable row level security;
revoke all on table public.app_admin_config from anon, authenticated;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "records_select_self_or_admin" on public.measurement_records;
create policy "records_select_self_or_admin"
  on public.measurement_records
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "records_insert_own" on public.measurement_records;
create policy "records_insert_own"
  on public.measurement_records
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "records_update_own" on public.measurement_records;
create policy "records_update_own"
  on public.measurement_records
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "records_delete_own" on public.measurement_records;
create policy "records_delete_own"
  on public.measurement_records
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.measurement_records to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_role text;
begin
  select case
    when exists (
      select 1
      from public.app_admin_config
      where coalesce(new.raw_user_meta_data ->> 'admin_code', '') <> ''
        and access_code = new.raw_user_meta_data ->> 'admin_code'
    ) then 'admin'
    else 'tester'
  end into assigned_role;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      '测量员'
    ),
    assigned_role
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_measurement_record()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists measurement_records_touch_updated_at on public.measurement_records;
create trigger measurement_records_touch_updated_at
  before update on public.measurement_records
  for each row execute function public.touch_measurement_record();

commit;
