/** Limpeza periódica: arquivos temporários vencidos e exclusões de conta. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Storage } from './storage.ts';

export async function runMaintenance(db: SupabaseClient, storage: Storage, log: (m: string, d?: Record<string, unknown>) => void) {
  const { data: setting } = await db.from('app_settings').select('value').eq('key', 'temp_retention_days').single();
  const days = Number(setting?.value ?? 7);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: temps } = await db.from('assets').select('id,path,thumbnail_path').eq('category', 'temp').lt('created_at', cutoff).limit(500);
  if (temps?.length) {
    await storage.remove(temps.flatMap((t) => [t.path, t.thumbnail_path].filter(Boolean) as string[]));
    await db.from('assets').delete().in('id', temps.map((t) => t.id));
    log('maintenance.temp_deleted', { count: temps.length });
  }

  const { data: deletions } = await db.from('profiles').select('id').not('deletion_requested_at', 'is', null).limit(20);
  for (const { id } of deletions ?? []) {
    // apaga todos os arquivos da pasta do usuário e depois a conta (cascata no banco)
    for (const folder of ['uploads', 'generated', 'exports', 'temp', 'thumbs']) {
      for (;;) {
        const { data: files } = await db.storage.from('media').list(`${id}/${folder}`, { limit: 1000 });
        if (!files?.length) break;
        await storage.remove(files.map((f) => `${id}/${folder}/${f.name}`));
        if (files.length < 1000) break;
      }
    }
    const { error } = await db.auth.admin.deleteUser(id);
    log('maintenance.account_deleted', { id, error: error?.message });
  }
}
