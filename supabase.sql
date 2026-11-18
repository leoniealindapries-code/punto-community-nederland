-- =====================================================================
--  Punto Community Nederland: database voor Supabase
--  Plak dit hele bestand in Supabase → SQL Editor → New query → Run.
--  Je kunt het veilig nog een keer draaien.
-- =====================================================================

-- ---------- Tabellen ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  invite_code text
);
insert into public.app_config (id) values (1) on conflict do nothing;

create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9_-]{3,20}$'),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  photo text not null default '' check (length(photo) < 100000),
  created_at timestamptz not null default now()
);
create unique index if not exists members_name_unique on public.members (lower(name));

-- Eigen wijk: alleen voor jezelf leesbaar
create table if not exists public.private_areas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  area_id text,
  area_name text not null,
  lat double precision not null check (lat between 50.5 and 53.8),
  lng double precision not null check (lng between 3.0 and 7.5),
  visible boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Zichtbare leden op de kaart (wordt automatisch bijgehouden)
create table if not exists public.locations (
  user_id uuid primary key references public.members(user_id) on delete cascade,
  area_name text not null,
  lat double precision not null,
  lng double precision not null
);

create table if not exists public.meets (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 60),
  when_at text not null,
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_by_name text,
  spot jsonb,
  created_at timestamptz not null default now()
);

-- Aanmeldingen: bewust ZONDER locatie
create table if not exists public.attendees (
  meet_id uuid references public.meets(id) on delete cascade,
  user_id uuid references public.members(user_id) on delete cascade,
  going boolean not null,
  updated_at timestamptz not null default now(),
  primary key (meet_id, user_id)
);

create table if not exists public.spots (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  type text not null check (type in ('mcd', 'parking', 'industrie')),
  lat double precision not null,
  lng double precision not null,
  approx boolean not null default false,
  added_by uuid default auth.uid()
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  channel text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text,
  text text not null check (length(text) between 1 and 500),
  ts timestamptz not null default now()
);
create index if not exists messages_channel_ts on public.messages (channel, ts desc);

-- ---------- Hulpfuncties ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'approved');
$$;

-- Lid worden met de groepscode (beheerder hoeft geen code)
create or replace function public.join_group(p_name text, p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd'; end if;
  if p_name !~ '^[A-Za-z0-9_-]{3,20}$' then raise exception 'Ongeldige gebruikersnaam'; end if;
  if public.is_admin() then
    insert into public.members (user_id, name, status) values (auth.uid(), p_name, 'approved')
    on conflict (user_id) do update set name = excluded.name, status = 'approved';
    return;
  end if;
  select invite_code into v_code from public.app_config where id = 1;
  if v_code is null or v_code = '' or p_code is distinct from v_code then
    raise exception 'Onjuiste groepscode';
  end if;
  insert into public.members (user_id, name, status) values (auth.uid(), p_name, 'pending')
  on conflict (user_id) do nothing;
end $$;

create or replace function public.approve_member(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Alleen voor beheerders'; end if;
  update public.members set status = 'approved' where user_id = p_user;
end $$;

-- Houdt de kaart bij: zichtbaar → op de kaart, onzichtbaar → eraf
create or replace function public.sync_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.locations where user_id = old.user_id;
    return old;
  end if;
  if new.visible and exists (select 1 from public.members where user_id = new.user_id) then
    insert into public.locations (user_id, area_name, lat, lng)
    values (new.user_id, new.area_name, new.lat, new.lng)
    on conflict (user_id) do update set area_name = excluded.area_name, lat = excluded.lat, lng = excluded.lng;
  else
    delete from public.locations where user_id = new.user_id;
  end if;
  return new;
end $$;

drop trigger if exists private_areas_sync on public.private_areas;
create trigger private_areas_sync after insert or update or delete on public.private_areas
for each row execute function public.sync_location();

-- Het midden van een meet, berekend IN de database.
-- Onzichtbare leden tellen mee, maar hun wijk verlaat de server nooit.
-- Het midden wordt afgerond op ±5 km, zodat niemand een wijk kan terugrekenen.
create or replace function public.meet_overview(p_meet uuid)
returns table (center_lat double precision, center_lng double precision,
               n_points int, n_hidden int, n_no_area int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Alleen voor leden'; end if;
  return query
  select round(round(avg(pa.lat)::numeric / 0.05, 0) * 0.05, 3)::double precision,
         round(round(avg(pa.lng)::numeric / 0.075, 0) * 0.075, 3)::double precision,
         count(pa.user_id)::int,
         count(*) filter (where pa.user_id is not null and not pa.visible)::int,
         count(*) filter (where pa.user_id is null)::int
  from public.attendees a
  left join public.private_areas pa on pa.user_id = a.user_id
  where a.meet_id = p_meet and a.going;
end $$;

-- ---------- Beveiliging (Row Level Security) ----------
alter table public.admins enable row level security;
alter table public.app_config enable row level security;
alter table public.members enable row level security;
alter table public.private_areas enable row level security;
alter table public.locations enable row level security;
alter table public.meets enable row level security;
alter table public.attendees enable row level security;
alter table public.spots enable row level security;
alter table public.messages enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "eigen admin-status" on public.admins for select to authenticated using (user_id = auth.uid());

create policy "beheerder leest code" on public.app_config for select to authenticated using (public.is_admin());
create policy "beheerder wijzigt code" on public.app_config for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "leden lezen" on public.members for select to authenticated
  using (user_id = auth.uid() or public.is_member() or public.is_admin());
create policy "eigen profiel wijzigen" on public.members for update to authenticated
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
create policy "beheerder of jezelf verwijdert" on public.members for delete to authenticated
  using (public.is_admin() or user_id = auth.uid());

create policy "eigen wijk" on public.private_areas for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "leden zien kaart" on public.locations for select to authenticated using (public.is_member());

create policy "leden zien meets" on public.meets for select to authenticated using (public.is_member());
create policy "leden maken meets" on public.meets for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
create policy "organisator wijzigt meet" on public.meets for update to authenticated
  using (created_by = auth.uid() or public.is_admin()) with check (created_by = auth.uid() or public.is_admin());
create policy "organisator verwijdert meet" on public.meets for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

create policy "leden zien aanmeldingen" on public.attendees for select to authenticated using (public.is_member());
create policy "eigen aanmelding" on public.attendees for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy "eigen aanmelding wijzigen" on public.attendees for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "aanmelding verwijderen" on public.attendees for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "leden zien plekken" on public.spots for select to authenticated using (public.is_member());
create policy "beheerder beheert plekken" on public.spots for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "leden lezen chat" on public.messages for select to authenticated using (public.is_member());
create policy "leden schrijven chat" on public.messages for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy "eigen bericht of beheerder verwijdert" on public.messages for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------- Rechten ----------
-- Eerst alle standaardrechten weghalen, daarna alleen geven wat nodig is
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, public;
grant usage on schema public to authenticated;
grant select on public.admins, public.app_config, public.members, public.locations,
  public.meets, public.attendees, public.spots, public.messages, public.private_areas to authenticated;
grant update (invite_code) on public.app_config to authenticated;
grant update (name, photo) on public.members to authenticated;          -- status alleen via approve_member
grant delete on public.members to authenticated;
grant insert, update, delete on public.private_areas to authenticated;
grant insert, update (title, when_at, note, spot), delete on public.meets to authenticated;
grant insert, update, delete on public.attendees to authenticated;
grant insert, update, delete on public.spots to authenticated;
grant insert (channel, name, text), delete on public.messages to authenticated;
grant execute on function public.is_admin(), public.is_member(), public.join_group(text, text),
  public.approve_member(uuid), public.meet_overview(uuid) to authenticated;

-- ---------- Live updates ----------
do $$ declare t text; begin
  foreach t in array array['members','locations','meets','attendees','spots','messages'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
