import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BUCKET = 'listings';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
  auth: { persistSession: false },
});

async function getStoredSecret(): Promise<string> {
  const { data } = await sb.from('app_config').select('value').eq('key', 'cron_secret').single();
  return data?.value ?? '';
}

function extractPath(url: string): string | null {
  if (!url) return null;
  const m = String(url).match(/\/listings\/(.+)$/);
  if (m) return m[1];
  if (!String(url).startsWith('http')) return String(url);
  return null;
}

async function listAllStorageFiles(): Promise<string[]> {
  const out: string[] = [];
  const { data: topLevel, error: e1 } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
  if (e1) throw e1;
  for (const item of topLevel ?? []) {
    if (item.id === null) {
      const { data: files } = await sb.storage.from(BUCKET).list(item.name, { limit: 10000 });
      for (const fi of files ?? []) {
        if (fi.id !== null) out.push(`${item.name}/${fi.name}`);
      }
    } else {
      out.push(item.name);
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const authHdr  = req.headers.get('Authorization') ?? '';
  const cronHdr  = req.headers.get('x-cron-secret') ?? '';
  const bearerOk = SUPABASE_SERVICE !== '' && authHdr === `Bearer ${SUPABASE_SERVICE}`;
  let cronOk = false;
  if (cronHdr) {
    const stored = await getStoredSecret();
    cronOk = stored !== '' && cronHdr === stored;
  }
  if (!bearerOk && !cronOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  let dryRun = false;
  try {
    const body = await req.clone().json().catch(() => ({}));
    dryRun = body && body.dryRun === true;
  } catch (_) {}
  const url = new URL(req.url);
  if (url.searchParams.get('dryRun') === '1') dryRun = true;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const { data: all, error: eAll } = await sb
    .from('listings')
    .select('id, images, date_start, date_end')
    .not('images', 'is', null);
  if (eAll) {
    return new Response(JSON.stringify({ error: 'listings query', details: eAll }), { status: 500 });
  }

  const expiredIds: string[] = [];
  const keepSet = new Set<string>();
  for (const l of all ?? []) {
    const imgs = Array.isArray(l.images) ? l.images : [];
    if (imgs.length === 0) continue;
    const effective = (l.date_end ?? l.date_start) as string | null;
    const isExpired = effective !== null && effective < todayStr;
    if (isExpired) {
      expiredIds.push(l.id);
    } else {
      for (const u of imgs) {
        const p = extractPath(u);
        if (p) keepSet.add(p);
      }
    }
  }

  const allFiles = await listAllStorageFiles();
  const toDelete = allFiles.filter(p => !keepSet.has(p));

  let removed = 0;
  const removeErrors: any[] = [];
  let listingsCleared = 0;

  if (!dryRun) {
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const { data, error } = await sb.storage.from(BUCKET).remove(batch);
      if (error) { removeErrors.push({ batch_start: i, message: error.message }); continue; }
      removed += data?.length ?? 0;
    }
    if (expiredIds.length > 0) {
      const { error: eUpd, count } = await sb
        .from('listings')
        .update({ images: null }, { count: 'exact' })
        .in('id', expiredIds);
      if (eUpd) removeErrors.push({ stage: 'update_listings', message: eUpd.message });
      else listingsCleared = count ?? expiredIds.length;
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    dryRun,
    storage_files_total: allFiles.length,
    referenced_kept: keepSet.size,
    expired_listings_with_photos: expiredIds.length,
    would_delete_or_deleted: toDelete.length,
    actually_removed_from_storage: removed,
    listings_cleared: listingsCleared,
    remove_errors: removeErrors,
    ran_at: now.toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
