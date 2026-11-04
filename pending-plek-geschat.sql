-- Telegram-bot: pin is alleen op plaatsnaam gezet en die naam bestaat op
-- meer plekken (bv. Hamm in Westfalen, aan de Sieg en in Hamburg). Het
-- kaartje vraagt dan om een adres en 'direct plaatsen' slaat hem over.
alter table public.pending_events add column if not exists plek_geschat boolean not null default false;
