-- Anti-scraping (19 okt 2026): de volledige SEO-dataset (alle listings met
-- organisatorlinks) was met de publieke anon-key in één call op te halen via
-- get_listings_seo(). Alleen de nachtelijke build heeft die nodig.
--
-- Nu: get_listings_seo_build(p_sleutel) met een geheime sleutel die alleen in
-- Vercel staat (env SEO_BUILD_KEY, production + preview). In de database staat
-- alleen de sha256 ervan (app_config 'seo_build_key_sha256'), nooit de sleutel.
-- Sleutel roteren: nieuwe waarde in Vercel zetten en de hash hier bijwerken.
--
-- Stap 2 (na een geslaagde build met de nieuwe functie):
--   revoke execute on function public.get_listings_seo() from public, anon, authenticated;
-- admin_dekking() blijft werken: die draait als eigenaar (security definer).

insert into public.app_config (key, value)
values ('seo_build_key_sha256', 'c8e07e8831564c197e29735763b201df31618bc00c284731e3055c79acf22aeb')
on conflict (key) do update set value = excluded.value;

create function public.get_listings_seo_build(p_sleutel text)
returns table(
  id uuid, title text, category text, event_subtype text,
  date_start date, date_end date, time_start time, time_end time,
  address text, city text, latitude double precision, longitude double precision,
  address_reveal_mode text, description text, images text[],
  confirmation_status text, user_id uuid, status text,
  updated_at timestamptz, land text, plaats_ok boolean,
  organizer_name text, organizer_url text, provincie text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_sleutel is null or encode(sha256(convert_to(p_sleutel, 'UTF8')), 'hex') is distinct from
     (select value from app_config where key = 'seo_build_key_sha256') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select * from get_listings_seo();
end $$;

revoke all on function public.get_listings_seo_build(text) from public;
grant execute on function public.get_listings_seo_build(text) to anon, authenticated;
