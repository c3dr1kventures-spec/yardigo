-- YardiGo Database Schema
-- Voer dit uit in de Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)

-- Enable PostGIS voor locatie-queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================
-- USERS tabel (uitbreiding op Supabase auth.users)
-- ============================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  phone TEXT,
  city TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS (Row Level Security) voor profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Iedereen kan profielen bekijken"
  ON public.profiles FOR SELECT
  USING (true);

CREATE POLICY "Gebruikers kunnen eigen profiel bewerken"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Gebruikers kunnen eigen profiel aanmaken"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================
-- LISTINGS tabel
-- ============================================
CREATE TABLE public.listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT CHECK (category IN (
    'garagesale', 'rommelmarkt', 'kofferbakverkoop', 'vlooienmarkt', 'overig'
  )),
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT,
  location GEOGRAPHY(POINT, 4326),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  date_start DATE NOT NULL,
  date_end DATE,
  time_start TIME,
  time_end TIME,
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence_rule TEXT,
  images TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'draft', 'expired', 'cancelled')),
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS voor listings
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Iedereen kan actieve listings zien"
  ON public.listings FOR SELECT
  USING (status = 'active' OR auth.uid() = user_id);

CREATE POLICY "Ingelogde gebruikers kunnen listings aanmaken"
  ON public.listings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Eigenaren kunnen eigen listings bewerken"
  ON public.listings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Eigenaren kunnen eigen listings verwijderen"
  ON public.listings FOR DELETE
  USING (auth.uid() = user_id);

-- Index voor locatie-zoekopdrachten
CREATE INDEX idx_listings_location ON public.listings USING GIST (location);
CREATE INDEX idx_listings_date ON public.listings (date_start);
CREATE INDEX idx_listings_city ON public.listings (city);
CREATE INDEX idx_listings_status ON public.listings (status);

-- ============================================
-- FAVORITES tabel
-- ============================================
CREATE TABLE public.favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, listing_id)
);

-- RLS voor favorites
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gebruikers kunnen eigen favorieten zien"
  ON public.favorites FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Gebruikers kunnen favorieten toevoegen"
  ON public.favorites FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Gebruikers kunnen favorieten verwijderen"
  ON public.favorites FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- Automatische updated_at trigger
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- Handige functie: listings in de buurt zoeken
-- ============================================
CREATE OR REPLACE FUNCTION nearby_listings(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_km DOUBLE PRECISION DEFAULT 10
)
RETURNS SETOF public.listings AS $$
  SELECT *
  FROM public.listings
  WHERE status = 'active'
    AND date_start >= CURRENT_DATE
    AND ST_DWithin(
      location,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::GEOGRAPHY,
      radius_km * 1000
    )
  ORDER BY date_start ASC;
$$ LANGUAGE sql STABLE;
