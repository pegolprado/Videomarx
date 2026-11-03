/** Opções gratuitas: vídeo animado (FFmpeg real), Gemini e Cloudflare (simulados), cofre de chaves. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { ApiError } from '@google/genai';
import { ffmpeg, probe } from '../src/ffmpeg.ts';
import { slideshowHandler } from '../src/handlers/media.ts';
import { supportedKinds } from '../src/handlers/index.ts';
import { GeminiAdapter } from '../src/providers/gemini.ts';
import { CloudflareAI } from '../src/providers/cloudflare.ts';
import { SecretStore } from '../src/secrets.ts';
import { JobError, TransientError } from '../src/errors.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetRow, JobContext } from '../src/types.ts';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-free-'));
  mkdirSync(join(dir, 'work'));
  for (const [i, color] of ['red', 'green', 'blue'].entries()) {
    await ffmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1024x1024:d=1`, '-frames:v', '1', '-update', '1', join(dir, `img${i}.jpg`)]);
  }
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'libmp3lame', join(dir, 'voz.mp3')]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function slideCtx(params: Record<string, unknown>, withAudio: boolean) {
  const imgs: Partial<AssetRow>[] = [0, 1, 2].map((i) => ({ id: `i${i}`, kind: 'image', category: 'generated', path: `u1/g/img${i}.jpg`, metadata: { synthetic: true } }));
  const audio: Partial<AssetRow> = { id: 'a1', kind: 'audio', category: 'generated', path: 'u1/g/voz.mp3', duration_s: 6, metadata: {} };
  const inputs = withAudio ? [...imgs, audio] : imgs;
  const created: Partial<AssetRow>[] = [];
  let outLocal = '';
  const ctx = {
    job: { id: 'j1', user_id: 'u1', project_id: null, params, state: {}, input_asset_ids: inputs.map((a) => a.id) },
    config: {}, workDir: join(dir, 'work'), inputs,
    storage: {
      download: async (path: string, dest: string) => copyFileSync(join(dir, path.split('/').pop()!), dest),
      upload: async (local: string) => {
        if (local.endsWith('.mp4')) {
          outLocal = join(dir, `out-${Date.now()}.mp4`);
          copyFileSync(local, outLocal);
        }
        return 1;
      },
    },
    progress: async () => {},
    createAsset: async (row: Partial<AssetRow>) => {
      created.push(row);
      return { id: `o${created.length}`, ...row } as AssetRow;
    },
  } as unknown as JobContext;
  return { ctx, created, out: () => outLocal };
}

describe('vídeo animado', () => {
  it('3 imagens + narração de 6 s viram vídeo vertical com áudio do tamanho da narração', async () => {
    const { ctx, created, out } = slideCtx({ aspect: '9:16', resolution: 720, motion: 'auto', transition: 'fade' }, true);
    await slideshowHandler(ctx);
    const info = await probe(out());
    expect(info).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    expect(info.duration!).toBeGreaterThan(5.5);
    expect(info.duration!).toBeLessThan(6.6);
    expect(created.find((c) => c.kind === 'video')).toMatchObject({ category: 'generated', metadata: expect.objectContaining({ synthetic: true }) });
  }, 120_000);

  it('sem narração usa o tempo por imagem e fica sem áudio', async () => {
    const { ctx, out } = slideCtx({ aspect: '1:1', resolution: 720, motion: 'zoom_in', transition: 'none', seconds_per_image: 2 }, false);
    await slideshowHandler(ctx);
    const info = await probe(out());
    expect(info).toMatchObject({ width: 720, height: 720, hasAudio: false });
    expect(info.duration!).toBeCloseTo(6, 0);
  }, 120_000);
});

describe('Gemini', () => {
  const schema = z.object({ prompt_en: z.string(), notes_pt: z.string() });
  it('pede JSON com esquema e valida a resposta', async () => {
    const generateContent = vi.fn(async () => ({ text: '{"prompt_en":"a cat","notes_pt":"ok"}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
    const g = new GeminiAdapter({ generateContent } as never, 'gemini-flash-latest', [], []);
    const r = await g.generate('sistema', 'pedido', schema);
    expect(r).toMatchObject({ data: { prompt_en: 'a cat' }, usd: 0 });
    const req = (generateContent.mock.calls[0] as unknown as [{ config: Record<string, unknown> }])[0];
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema).toMatchObject({ type: 'object' });
    expect(req.config.responseJsonSchema).not.toHaveProperty('$schema');
  });
  it('resposta fora do formato vira erro claro; limite grátis tenta de novo', async () => {
    const bad = new GeminiAdapter({ generateContent: async () => ({ text: '{"x":1}' }) } as never, 'm', [], []);
    await expect(bad.generate('s', 'u', schema)).rejects.toBeInstanceOf(JobError);
    const limited = new GeminiAdapter({ generateContent: async () => { throw new ApiError({ message: 'quota', status: 429 }); } } as never, 'm', ['m2'], [0]);
    await expect(limited.generate('s', 'u', schema)).rejects.toBeInstanceOf(TransientError);
    const auth = new GeminiAdapter({ generateContent: async () => { throw new ApiError({ message: 'bad key', status: 403 }); } } as never, 'm', [], []);
    await expect(auth.generate('s', 'u', schema)).rejects.toMatchObject({ code: 'provider_auth' });
  });
  it('congestionado (503): tenta de novo e depois passa para outro modelo grátis; modelo inexistente (404) é pulado', async () => {
    const calls: string[] = [];
    const generateContent = vi.fn(async ({ model }: { model: string }) => {
      calls.push(model);
      if (model === 'principal') throw new ApiError({ message: 'high demand', status: 503 });
      if (model === 'sumiu') throw new ApiError({ message: 'not found', status: 404 });
      return { text: '{"prompt_en":"ok","notes_pt":"ok"}' };
    });
    const g = new GeminiAdapter({ generateContent } as never, 'principal', ['sumiu', 'reserva'], [0, 0]);
    const r = await g.generate('s', 'u', schema);
    expect(r.usage.model).toBe('reserva');
    expect(calls).toEqual(['principal', 'principal', 'principal', 'sumiu', 'reserva']);
  });
});

describe('Cloudflare', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('chama o FLUX.1 schnell e devolve a imagem', async () => {
    const fetchFn = vi.fn(async () => ok({ success: true, result: { image: Buffer.from('JPEGDATA').toString('base64') } }));
    const cf = new CloudflareAI('conta123', 'token', fetchFn);
    expect((await cf.flux('um gato')).toString()).toBe('JPEGDATA');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/conta123/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: 'um gato', steps: 6 });
  });
  it('cota diária esgotada, chave errada e instabilidade', async () => {
    const quota = new CloudflareAI('c', 't', async () => ok({ success: false, errors: [{ message: 'You have used up your daily free allocation of 10,000 neurons' }] }, 429));
    await expect(quota.flux('x')).rejects.toMatchObject({ code: 'free_quota' });
    const auth = new CloudflareAI('c', 't', async () => ok({ success: false, errors: [{ message: 'Authentication error' }] }, 401));
    await expect(auth.flux('x')).rejects.toMatchObject({ code: 'provider_auth' });
    const down = new CloudflareAI('c', 't', async () => ok({ success: false }, 503));
    await expect(down.flux('x')).rejects.toBeInstanceOf(TransientError);
  });
});

describe('cofre de chaves e capacidades', () => {
  it('cofre do banco tem prioridade sobre o ambiente e mantém o último valor se o banco falhar', async () => {
    process.env.GEMINI_API_KEY = 'do-ambiente';
    let fail = false;
    const db = { from: () => ({ select: async () => (fail ? { data: null, error: { message: 'x' } } : { data: [{ name: 'GEMINI_API_KEY', value: 'do-painel-123' }], error: null }) }) } as unknown as SupabaseClient;
    const s = new SecretStore(db);
    await s.refresh();
    expect(s.get('GEMINI_API_KEY')).toBe('do-painel-123');
    const fp = s.fingerprint();
    fail = true;
    await s.refresh();
    expect(s.get('GEMINI_API_KEY')).toBe('do-painel-123');
    expect(s.fingerprint()).toBe(fp);
    delete process.env.GEMINI_API_KEY;
  });
  it('só com opções grátis o worker pega textos, imagens e vídeo animado', () => {
    const kinds = supportedKinds({ ffmpeg: true, runway: false, anthropic: false, gemini: true, cloudflare: true });
    expect(kinds).toEqual(expect.arrayContaining(['ai.text', 'ai.image', 'media.slideshow']));
    expect(kinds).not.toContain('ai.video');
  });
});
