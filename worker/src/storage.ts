import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TransientError } from './errors.ts';

export const BUCKET = 'media';

export class Storage {
  constructor(private readonly db: SupabaseClient) {}

  async signedUrl(path: string, seconds = 3600): Promise<string> {
    const { data, error } = await this.db.storage.from(BUCKET).createSignedUrl(path, seconds);
    if (error || !data) throw new TransientError(`Falha ao gerar URL temporária: ${error?.message}`);
    return data.signedUrl;
  }

  /** Baixa por streaming (não carrega o arquivo inteiro na memória). */
  async download(path: string, dest: string): Promise<void> {
    await downloadUrl(await this.signedUrl(path, 600), dest);
  }

  async upload(localPath: string, path: string, contentType: string): Promise<number> {
    const body = await readFile(localPath);
    const { error } = await this.db.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
    if (error) throw new TransientError(`Falha ao salvar arquivo: ${error.message}`);
    return (await stat(localPath)).size;
  }

  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.db.storage.from(BUCKET).remove(paths);
  }
}

export async function downloadUrl(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new TransientError(`Falha de conexão ao baixar arquivo: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new TransientError(`Falha ao baixar arquivo (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
}

export function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (
    {
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', srt: 'application/x-subrip',
    } as Record<string, string>
  )[ext ?? ''] ?? 'application/octet-stream';
}

export function extFromUrl(url: string, fallback: string): string {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : fallback;
}
