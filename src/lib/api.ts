import type { JobKind } from '@shared/jobs';
import { supabase } from './supabase';
import type { Asset, AssetKind, Estimate, Job } from './types';

export async function estimateJob(kind: JobKind, params: Record<string, unknown>, inputs: string[] = []): Promise<Estimate> {
  const { data, error } = await supabase.rpc('estimate_job', { p_kind: kind, p_params: params, p_input_asset_ids: inputs });
  if (error) throw error;
  return data as Estimate;
}

/**
 * Cria a tarefa. A chave de idempotência evita cobrança duplicada em
 * cliques repetidos/reenvios; confirmedCredits é o valor que o usuário viu.
 */
export async function createJob(opts: {
  kind: JobKind;
  params: Record<string, unknown>;
  inputs?: string[];
  projectId?: string | null;
  confirmedCredits: number;
  idempotencyKey?: string;
}): Promise<Job> {
  const { data, error } = await supabase.rpc('create_job', {
    p_kind: opts.kind,
    p_params: opts.params,
    p_input_asset_ids: opts.inputs ?? [],
    p_project_id: opts.projectId ?? null,
    p_idempotency_key: opts.idempotencyKey ?? crypto.randomUUID(),
    p_confirmed_credits: opts.confirmedCredits,
  });
  if (error) throw error;
  return data as Job;
}

export async function cancelJob(id: string): Promise<Job> {
  const { data, error } = await supabase.rpc('cancel_job', { p_job_id: id });
  if (error) throw error;
  return data as Job;
}

export function kindFromMime(mime: string): AssetKind | null {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/x-subrip' || mime === 'text/vtt') return 'subtitle';
  return null;
}

export const ACCEPT: Record<AssetKind, string> = {
  video: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
  image: 'image/png,image/jpeg,image/webp',
  audio: 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/webm',
  subtitle: '.srt',
  other: '',
};

/**
 * Envio com barra de progresso real (URL de envio assinada + XHR), registro
 * do arquivo e análise automática no servidor (media.probe, gratuita).
 */
export async function uploadAsset(
  file: File,
  opts: { userId: string; category?: 'original' | 'reference' | 'temp'; characterId?: string | null; projectId?: string | null; rightsConfirmed?: boolean; maxMb: number },
  onProgress?: (fraction: number) => void,
): Promise<Asset> {
  let mime = file.type;
  if (!mime && file.name.toLowerCase().endsWith('.srt')) mime = 'application/x-subrip';
  const kind = kindFromMime(mime);
  if (!kind) throw new Error('Formato de arquivo não aceito.');
  if (file.size > opts.maxMb * 1024 * 1024) throw new Error(`O arquivo tem ${(file.size / 1048576).toFixed(0)} MB; o limite é ${opts.maxMb} MB.`);
  if (kind === 'video' && !opts.rightsConfirmed) throw new Error('Confirme que você tem direitos sobre o vídeo.');

  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const id = crypto.randomUUID();
  const path = `${opts.userId}/uploads/${id}.${ext}`;
  const { data: signed, error: signErr } = await supabase.storage.from('media').createSignedUploadUrl(path);
  if (signErr || !signed) throw signErr ?? new Error('Falha ao preparar envio.');

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signed.signedUrl);
    xhr.setRequestHeader('content-type', mime);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress?.(ev.loaded / ev.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(parseStorageError(xhr.responseText) ?? `Falha no envio (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Falha de conexão durante o envio.'));
    xhr.send(file);
  });

  const { data, error } = await supabase
    .from('assets')
    .insert({
      id,
      kind,
      category: opts.category ?? 'original',
      name: file.name.slice(0, 120),
      path,
      mime,
      size_bytes: file.size,
      character_id: opts.characterId ?? null,
      project_id: opts.projectId ?? null,
      rights_confirmed_at: opts.rightsConfirmed ? new Date().toISOString() : null,
    })
    .select('*')
    .single();
  if (error) {
    await supabase.storage.from('media').remove([path]);
    throw error;
  }
  // análise no servidor (gratuita): valida o arquivo, lê duração/resolução e gera miniaturas
  await createJob({ kind: 'media.probe', params: {}, inputs: [id], confirmedCredits: 0, idempotencyKey: `probe-${id}` });
  return data as Asset;
}

function parseStorageError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { message?: string; error?: string };
    return j.message ?? j.error ?? null;
  } catch {
    return null;
  }
}

const urlCache = new Map<string, { url: string; exp: number }>();

/** URL temporária (1 h) para exibir/baixar arquivos privados. */
export async function signedUrl(path: string, download?: string): Promise<string> {
  const key = `${path}|${download ?? ''}`;
  const hit = urlCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from('media').createSignedUrl(path, 3600, download ? { download } : undefined);
  if (error || !data) throw error ?? new Error('Arquivo indisponível');
  urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 50 * 60_000 });
  return data.signedUrl;
}

export async function deleteAsset(asset: Asset): Promise<void> {
  const paths = [asset.path, asset.thumbnail_path, ...((asset.metadata.preview_frames as string[] | undefined) ?? [])].filter(Boolean) as string[];
  const { error } = await supabase.from('assets').delete().eq('id', asset.id);
  if (error) throw error;
  await supabase.storage.from('media').remove(paths);
}

/** Duplica um arquivo (cópia física no armazenamento + novo registro). */
export async function duplicateAsset(asset: Asset, userId: string): Promise<void> {
  const ext = asset.path.split('.').pop();
  const id = crypto.randomUUID();
  const path = `${userId}/uploads/${id}.${ext}`;
  const { error: copyErr } = await supabase.storage.from('media').copy(asset.path, path);
  if (copyErr) throw copyErr;
  const category = ['original', 'reference'].includes(asset.category) ? asset.category : 'original';
  const { error } = await supabase.from('assets').insert({
    id, kind: asset.kind, category, name: `${asset.name} (cópia)`, path, mime: asset.mime, size_bytes: asset.size_bytes,
    character_id: asset.character_id, rights_confirmed_at: asset.rights_confirmed_at,
  });
  if (error) throw error;
  await createJob({ kind: 'media.probe', params: {}, inputs: [id], confirmedCredits: 0, idempotencyKey: `probe-${id}` });
}
