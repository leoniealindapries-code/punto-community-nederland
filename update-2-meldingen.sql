-- =====================================================================
--  Update 2: pushmeldingen
--  Plak dit in Supabase → SQL Editor → New query → Run.
--  Je kunt het veilig nog een keer draaien.
-- =====================================================================

-- pg_net laat de database de Edge Function aanroepen
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then raise notice 'pg_net niet beschikbaar: %', sqlerrm;
end $$;

-- ---------- Tabellen (geen directe toegang voor gebruikers) ----------
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text,
  vapid_private jsonb,
  function_url text,
  site_url text
);
insert into public.push_config (id) values (1) on conflict do nothing;

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_ids uuid[] not null,
  title text not null,
  body text not null default '',
  url text not null default '',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.push_subscriptions enable row level security;
alter table public.push_config enable row level security;
alter table public.notifications enable row level security;
revoke all on public.push_subscriptions, public.push_config, public.notifications from anon, authenticated;
do $$ begin
  execute 'grant all on public.push_subscriptions, public.push_config, public.notifications to service_role';
exception when undefined_object then null;
end $$;

-- ---------- Melding in de wachtrij zetten + verzendfunctie aanroepen ----------
create or replace function public.queue_notification(p_users uuid[], p_title text, p_body text, p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_url text;
begin
  if p_users is null or coalesce(array_length(p_users, 1), 0) = 0 then return; end if;
  insert into public.notifications (user_ids, title, body, url) values (p_users, p_title, p_body, p_url)
  returning id into v_id;
  select function_url into v_url from public.push_config where id = 1;
  if v_url is null then return; end if;
  begin
    perform net.http_post(url := v_url, body := jsonb_build_object('id', v_id),
                          headers := '{"Content-Type": "application/json"}'::jsonb);
  exception when others then
    raise notice 'melding niet doorgestuurd: %', sqlerrm;   -- nooit de eigenlijke actie laten mislukken
  end;
end $$;

create or replace function public.admin_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(user_id), '{}') from public.admins;
$$;

create or replace function public.fmt_when(p text) returns text
language plpgsql immutable as $$
begin
  return to_char(p::timestamp, 'DD-MM-YYYY "om" HH24:MI');
exception when others then return p;
end $$;

-- ---------- Triggers ----------
-- Nieuwe meet → alle leden (behalve de organisator)
create or replace function public.notify_new_meet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.queue_notification(
    array(select user_id from public.members where status = 'approved' and user_id <> new.created_by),
    '🏁 Nieuwe meet gepland!',
    new.title || ' – ' || public.fmt_when(new.when_at) || '. Tik om je aan te melden.',
    '#meet-' || new.id);
  return new;
end $$;
drop trigger if exists meets_notify on public.meets;
create trigger meets_notify after insert on public.meets for each row execute function public.notify_new_meet();

-- Nieuwe aanvraag → beheerders;  goedgekeurd → het nieuwe lid zelf
create or replace function public.notify_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.queue_notification(public.admin_ids(), '👋 Nieuwe aanvraag',
      new.name || ' wil lid worden van de app.', '#beheer');
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'approved' then
    perform public.queue_notification(array[new.user_id], '✅ Je bent toegelaten!',
      'Welkom bij Punto Community Nederland. Stel je profielfoto en wijk in.', '#instellingen');
  end if;
  return new;
end $$;
drop trigger if exists members_notify on public.members;
create trigger members_notify after insert or update of status on public.members
for each row execute function public.notify_member();

-- Voorgestelde meetplek → beheerders
create or replace function public.notify_spot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform public.queue_notification(public.admin_ids(), '📍 Nieuwe meetplek voorgesteld',
      new.name || coalesce(' (door ' || new.suggested_by_name || ')', ''), '#beheer');
  end if;
  return new;
end $$;
drop trigger if exists spots_notify on public.spots;
create trigger spots_notify after insert on public.spots for each row execute function public.notify_spot();

-- ---------- Functies voor de app ----------
-- Publieke sleutel voor het aanmelden van een telefoon
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public as $$
  select vapid_public from public.push_config where id = 1 and (public.is_member() or public.is_admin());
$$;

create or replace function public.push_status() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() and vapid_public is not null and function_url is not null from public.push_config where id = 1;
$$;

-- Beheerder activeert meldingen (sleutels worden in de browser van de beheerder gemaakt)
create or replace function public.setup_push(p_public text, p_private jsonb, p_function_url text, p_site_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Alleen voor beheerders'; end if;
  if p_function_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/notify$' then
    raise exception 'Ongeldig functie-adres';
  end if;
  -- Nieuwe sleutels? Dan werken oude aanmeldingen niet meer.
  delete from public.push_subscriptions
  where exists (select 1 from public.push_config where id = 1 and vapid_public is distinct from p_public);
  update public.push_config set vapid_public = p_public, vapid_private = p_private,
    function_url = p_function_url, site_url = p_site_url where id = 1;
end $$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_member() or public.is_admin()) then raise exception 'Alleen voor leden'; end if;
  if p_endpoint !~ '^https://' then raise exception 'Ongeldig adres'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

create or replace function public.send_test_push() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_member() or public.is_admin()) then raise exception 'Alleen voor leden'; end if;
  perform public.queue_notification(array[auth.uid()], '🔔 Testmelding',
    'Als je dit ziet, werken de meldingen van Punto Community Nederland!', '#instellingen');
end $$;

-- ---------- Rechten ----------
revoke all on function public.queue_notification(uuid[], text, text, text), public.admin_ids(), public.fmt_when(text),
  public.notify_new_meet(), public.notify_member(), public.notify_spot(),
  public.push_public_key(), public.push_status(), public.setup_push(text, jsonb, text, text),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text), public.send_test_push()
  from public, anon, authenticated;
grant execute on function public.push_public_key(), public.push_status(), public.setup_push(text, jsonb, text, text),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text), public.send_test_push()
  to authenticated;
