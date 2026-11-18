-- =====================================================================
--  Update 1: leden kunnen meetplekken voorstellen, beheerder keurt goed.
--  Plak dit in Supabase → SQL Editor → New query → Run. Eén keer is genoeg.
-- =====================================================================
alter table public.spots add column if not exists status text not null default 'approved'
  check (status in ('approved', 'pending'));
alter table public.spots add column if not exists suggested_by_name text;

drop policy if exists "leden zien plekken" on public.spots;
drop policy if exists "leden stellen plek voor" on public.spots;
drop policy if exists "eigen voorstel intrekken" on public.spots;

-- Leden zien goedgekeurde plekken en hun eigen voorstellen; de beheerder ziet alles
create policy "leden zien plekken" on public.spots for select to authenticated
  using (public.is_admin() or (public.is_member() and (status = 'approved' or added_by = auth.uid())));
-- Leden mogen alleen voorstellen (status 'pending'), nooit direct goedkeuren
create policy "leden stellen plek voor" on public.spots for insert to authenticated
  with check (public.is_member() and status = 'pending' and added_by = auth.uid());
-- Eigen voorstel intrekken zolang het nog niet is goedgekeurd
create policy "eigen voorstel intrekken" on public.spots for delete to authenticated
  using (added_by = auth.uid() and status = 'pending');
