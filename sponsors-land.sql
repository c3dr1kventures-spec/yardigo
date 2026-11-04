-- Sponsors per domein (4 nov 2026): yardigo.nl toont Nederlandse sponsors,
-- yardigo.be Belgische en yardigo.de Duitse. Elk domein heeft zijn eigen
-- zes plekken. Bestaande sponsors worden 'nl'.

alter table public.sponsors
  add column if not exists land text not null default 'nl' check (land in ('nl', 'be', 'de'));

drop index if exists public.sponsors_plek_actief;
create unique index if not exists sponsors_land_plek_actief on public.sponsors (land, plek) where actief;

grant select (land) on public.sponsors to anon, authenticated;
