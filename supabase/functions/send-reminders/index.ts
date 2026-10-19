import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FROM_EMAIL       = 'YardiGo <info@mail.yardigo.nl>';
const BASE_URL         = 'https://yardigo.nl';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
  auth: { persistSession: false },
});

async function getStoredSecret(): Promise<string> {
  const { data } = await sb
    .from('app_config')
    .select('value')
    .eq('key', 'cron_secret')
    .single();
  return data?.value ?? '';
}

Deno.serve(async (req: Request) => {
  const cronHdr    = req.headers.get('x-cron-secret') ?? '';
  const authHdr    = req.headers.get('Authorization') ?? '';
  const bearerOk   = SUPABASE_SERVICE && authHdr === `Bearer ${SUPABASE_SERVICE}`;

  // Validate cron secret from DB
  let cronOk = false;
  if (cronHdr) {
    const stored = await getStoredSecret();
    cronOk = stored !== '' && cronHdr === stored;
  }

  if (!bearerOk && !cronOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  let frequency: string | null = null;
  try {
    const body = await req.clone().json().catch(() => ({}));
    frequency = body.frequency ?? null;
  } catch (_) {}
  if (!frequency) {
    const url = new URL(req.url);
    frequency = url.searchParams.get('frequency');
  }

  const now = new Date();
  const freqList: string[] = frequency ? [frequency] : [];
  if (!freqList.length) {
    if (now.getDay() === 5) freqList.push('weekly');
    if (now.getDate() === 1) freqList.push('monthly');
    if (!freqList.length) {
      return new Response(JSON.stringify({ skipped: true, reason: 'Not a send day' }), { status: 200 });
    }
  }

  const results: { freq: string; sent: number; skipped: number; errors: number }[] = [];

  for (const freq of freqList) {
    const intervalDays = freq === 'weekly' ? 6 : freq === 'monthly' ? 27 : 1;
    const cutoff = new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000).toISOString();

    let q = sb.from('profiles')
      .select('id, display_name, country, city, unsubscribe_token')
      .eq('promo_email_opt_in', true)
      .eq('email_frequency', freq);
    q = q.or(`last_reminder_sent_at.is.null,last_reminder_sent_at.lt.${cutoff}`);
    const { data: users, error: uErr } = await q;
    if (uErr) { console.error('users query error', uErr); continue; }
    if (!users || users.length === 0) { results.push({ freq, sent: 0, skipped: 0, errors: 0 }); continue; }

    let sent = 0, skipped = 0, errors = 0;

    for (const user of users) {
      const { data: adminUser } = await sb.auth.admin.getUserById(user.id);
      if (!adminUser?.user?.email) { skipped++; continue; }
      const email = adminUser.user.email;
      const name  = user.display_name || email.split('@')[0];

      const todayStr = now.toISOString().slice(0, 10);
      let lq = sb.from('listings')
        .select('id, title, date_start, city, type')
        .gte('date_end', todayStr)
        .eq('status', 'published')
        .order('date_start', { ascending: true })
        .limit(5);
      if (user.city) {
        lq = lq.ilike('city', `%${user.city.split(',')[0].trim()}%`);
      }
      const { data: listings } = await lq;
      if (!listings || listings.length === 0) { skipped++; continue; }

      const isFr = user.country === 'BE';
      const listingsHtml = listings.map((l: any) => {
        const dateStr = l.date_start
          ? new Date(l.date_start).toLocaleDateString(
              isFr ? 'fr-FR' : 'nl-NL',
              { weekday: 'short', day: 'numeric', month: 'long' }
            )
          : '';
        return `<div style="border:1px solid #E8E0D4;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#FDFAF6">
  <div style="font-size:13px;font-weight:700;color:#2C2416">${esc(l.title || 'Garagesale')}</div>
  <div style="font-size:11px;color:#7A6E62;margin-top:2px">${dateStr}${l.city ? ` · ${esc(l.city)}` : ''}</div>
</div>`;
      }).join('');

      const unsubUrl = `${BASE_URL}/?uitschrijven-promo=1&token=${user.unsubscribe_token}`;
      const subject  = isFr
        ? `${listings.length} vente${listings.length > 1 ? 's' : ''} près de chez vous cette ${freq === 'weekly' ? 'semaine' : 'mois'} 🛍️`
        : `${listings.length} verkop${listings.length > 1 ? 'en' : ''} bij jou in de buurt deze ${freq === 'weekly' ? 'week' : 'maand'} 🛍️`;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#F9F5EF;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#E07B39;border-radius:14px 14px 0 0;padding:20px 24px;text-align:center">
    <div style="font-size:22px;font-weight:800;color:white">YardiGo</div>
    <div style="font-size:11px;color:rgba(255,255,255,.85);margin-top:2px">${isFr ? 'Garagesales près de chez vous' : 'Garagesales bij jou in de buurt'}</div>
  </div>
  <div style="background:white;border-radius:0 0 14px 14px;padding:24px;border:1.5px solid #E8E0D4;border-top:none">
    <p style="margin:0 0 12px;color:#2C2416;font-size:15px;font-weight:700">${isFr ? `Bonjour ${esc(name)} 👋` : `Hoi ${esc(name)} 👋`}</p>
    <p style="margin:0 0 16px;color:#4A3E32;font-size:13px;line-height:1.6">${isFr
      ? 'Voici les prochaines ventes de garage près de chez vous :'
      : 'Dit zijn de komende verkopen bij jou in de buurt:'}</p>
    ${listingsHtml}
    <div style="text-align:center;margin:20px 0 0">
      <a href="${BASE_URL}/" style="display:inline-block;background:#E07B39;color:white;border-radius:10px;padding:12px 28px;font-weight:700;font-size:14px;text-decoration:none">${isFr ? 'Voir toutes les ventes →' : 'Bekijk alle verkopen →'}</a>
    </div>
    <p style="margin:20px 0 0;color:#7A6E62;font-size:12px;line-height:1.6">${isFr ? 'À bientôt,<br><strong>L\'équipe YardiGo</strong>' : 'Veel plezier,<br><strong>Het YardiGo-team</strong>'}</p>
  </div>
  <div style="text-align:center;margin-top:14px">
    <a href="${unsubUrl}" style="color:#9E9587;font-size:10px">${isFr ? 'Se désabonner de ces conseils' : 'Uitschrijven voor deze tips'}</a>
  </div>
</div>
</body></html>`;

      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: [email], subject, html }),
      });

      if (sendRes.ok) {
        sent++;
        await sb.from('profiles').update({ last_reminder_sent_at: now.toISOString() }).eq('id', user.id);
      } else {
        errors++;
        console.error('Resend failed', user.id, await sendRes.text());
      }
    }

    results.push({ freq, sent, skipped, errors });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

function esc(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
