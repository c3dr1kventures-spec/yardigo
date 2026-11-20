-- YardiGo – oliebollenkramen (seizoenslaag op de kaart, nov 2026)
--
-- Eigen tabel, los van listings: een kraam staat weken op dezelfde plek en
-- hoort niet tussen de verkopen van het weekend. Wordt gevuld door de edge
-- function import-oliebollen (Gemeenteblad: standplaatsvergunningen), door
-- aanmeldingen van kraamhouders en handmatig via /admin.
--
-- Publiek alleen via get_oliebollen_publiek(): actieve kramen met een plek,
-- vanaf 75 dagen voor de eerste dag (rest van het seizoen) tot en met de
-- laatste dag. De kaart toont 'vanaf 27 dec' als hij nog niet staat.

create table if not exists public.oliebollen_kramen (
  id            bigint generated always as identity primary key,
  naam          text,                      -- naam kraam/bakker, als bekend
  locatie       text,                      -- "bij winkelcentrum Noordhove, Lijnbaan"
  adres         text,                      -- straat + nr, of plein
  plaats        text not null,             -- woonplaats/kern
  gemeente      text,
  provincie     text,
  land          text not null default 'NL',
  latitude      double precision,
  longitude     double precision,
  plek_geschat  boolean not null default false,   -- alleen plaatsniveau bekend
  datum_van     date,
  datum_tot     date,
  dagen         text,                      -- "alleen zaterdagen", "30 en 31 december"
  tijden        text,                      -- openingstijden, vrije tekst
  soort         text not null default 'kraam' check (soort in ('kraam', 'actie')),  -- actie = vereniging/scouting, kort
  vergunning    text check (vergunning in ('aanvraag', 'verleend', 'melding', 'onbekend')),
  status        text not null default 'actief' check (status in ('actief', 'controleren', 'verborgen', 'ingetrokken')),
  bron          text not null default 'gemeenteblad' check (bron in ('gemeenteblad', 'aanmelding', 'admin')),
  bron_url      text,
  website       text,
  contact_email text,                      -- alleen bij aanmelding, nooit publiek
  opmerking     text,                      -- intern (AI-reden, controle)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists oliebollen_kramen_actief on public.oliebollen_kramen (datum_tot) where status = 'actief';

-- Welke Gemeenteblad-publicaties al bekeken zijn (ook de afgewezen), zodat
-- elke run alleen nieuwe leest.
create table if not exists public.oliebollen_bronnen (
  gmb_id     text primary key,             -- bv. gmb-2026-517326
  titel      text,
  gemeente   text,
  datum      date,
  uitkomst   text not null,                -- nieuw | samengevoegd | ingetrokken | niet_relevant | geen_plek | fout
  reden      text,
  kraam_id   bigint references public.oliebollen_kramen(id) on delete set null,
  gezien_at  timestamptz not null default now()
);

alter table public.oliebollen_kramen enable row level security;
alter table public.oliebollen_bronnen enable row level security;
-- Geen policies: alleen service role (edge functions) en de RPC's hieronder.

create or replace function public.oliebollen_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists oliebollen_touch on public.oliebollen_kramen;
create trigger oliebollen_touch before update on public.oliebollen_kramen
  for each row execute function public.oliebollen_touch();

-- Publiek: kaart, plaatspagina's (prerender), app.
create or replace function public.get_oliebollen_publiek()
returns table (
  id bigint, naam text, locatie text, adres text, plaats text, gemeente text, provincie text, land text,
  latitude double precision, longitude double precision, plek_geschat boolean,
  datum_van date, datum_tot date, dagen text, tijden text, soort text, bron text, bron_url text, website text
)
language sql stable security definer set search_path = public as $$
  select k.id, k.naam, k.locatie, k.adres, k.plaats, k.gemeente, k.provincie, k.land,
         k.latitude, k.longitude, k.plek_geschat,
         k.datum_van, k.datum_tot, k.dagen, k.tijden, k.soort, k.bron, k.bron_url, k.website
  from public.oliebollen_kramen k
  where k.status = 'actief'
    and k.latitude is not null and k.longitude is not null
    and coalesce(k.datum_tot, k.datum_van) >= (now() at time zone 'Europe/Amsterdam')::date
    and coalesce(k.datum_van, (now() at time zone 'Europe/Amsterdam')::date) <= (now() at time zone 'Europe/Amsterdam')::date + 75
  order by k.plaats, k.id;
$$;
revoke all on function public.get_oliebollen_publiek() from public;
grant execute on function public.get_oliebollen_publiek() to anon, authenticated;

-- Admin: alles, ook verborgen/ingetrokken.
create or replace function public.admin_oliebollen()
returns setof public.oliebollen_kramen
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then
    raise exception 'admin required';
  end if;
  return query select * from public.oliebollen_kramen order by created_at desc;
end $$;
revoke all on function public.admin_oliebollen() from public;
grant execute on function public.admin_oliebollen() to authenticated;

-- Aanmelding of aanvulling door een kraamhouder (/oliebollen/aanmelden).
-- Komt altijd binnen als 'controleren'; de beheerder keurt (Telegram-melding
-- via import-oliebollen). Bij p_kraam_id: aanvulling op een bestaande kraam.
create or replace function public.oliebollen_aanmelden(
  p_naam text, p_plaats text, p_locatie text, p_adres text,
  p_datum_van date, p_datum_tot date, p_dagen text, p_tijden text,
  p_website text, p_email text, p_opmerking text, p_kraam_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if coalesce(trim(p_plaats), '') = '' or coalesce(trim(p_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'fout', 'plaats en e-mail zijn verplicht');
  end if;
  if (select count(*) from oliebollen_kramen where bron = 'aanmelding' and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'fout', 'even te druk, probeer het later opnieuw');
  end if;
  if p_kraam_id is not null and not exists (select 1 from oliebollen_kramen where id = p_kraam_id) then p_kraam_id := null; end if;
  insert into oliebollen_kramen (naam, plaats, locatie, adres, datum_van, datum_tot, dagen, tijden, website, contact_email,
                                 status, bron, vergunning, opmerking)
  values (left(nullif(trim(p_naam), ''), 80), left(trim(p_plaats), 60), left(nullif(trim(p_locatie), ''), 120), left(nullif(trim(p_adres), ''), 120),
          p_datum_van, p_datum_tot, left(nullif(trim(p_dagen), ''), 120), left(nullif(trim(p_tijden), ''), 160),
          case when p_website ~* '^https?://' then left(trim(p_website), 200) end, left(trim(p_email), 120),
          'controleren', 'aanmelding', 'onbekend',
          left(concat_ws(' · ', case when p_kraam_id is not null then 'aanvulling op #' || p_kraam_id end, nullif(trim(p_opmerking), '')), 500))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.oliebollen_aanmelden(text, text, text, text, date, date, text, text, text, text, text, bigint) from public;
grant execute on function public.oliebollen_aanmelden(text, text, text, text, date, date, text, text, text, text, text, bigint) to anon, authenticated;

alter table public.oliebollen_kramen add column if not exists gemeld_at timestamptz;   -- Telegram-melding van een aanmelding

-- Rechten aanscherpen (Supabase geeft anon/authenticated standaard rechten op nieuwe objecten).
revoke execute on function public.admin_oliebollen() from anon;
revoke all on public.oliebollen_kramen, public.oliebollen_bronnen from anon, authenticated;

-- Cron (zie ook cron.job): 2× per dag in okt–jan.
--   select cron.schedule('yardigo-import-oliebollen', '20 7,15 * 10-12,1 *', $$ select net.http_post(
--     url := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/import-oliebollen',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.app_config where key = 'cron_secret')),
--     body := '{"max": 40}'::jsonb, timeout_milliseconds := 150000); $$);
