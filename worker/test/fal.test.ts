/** fal.ai: fila simulada; FFmpeg real para o resultado (devolução do áudio original). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@fal-ai/client';
import { ffmpeg, probe } from '../src/ffmpeg.ts';
import { FalAdapter, mapFalError, type FalQueueLike } from '../src/providers/fal.ts';
import { talkHandler, transformHandler, videoHandler } from '../src/handlers/ai.ts';
import { CanceledError, JobError, TransientError } from '../src/errors.ts';
import type { AssetRow, JobContext } from '../src/types.ts';

let dir: string;
let outVideo: string; // "resultado" da fal (sem áudio), servido como data: URL
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-fal-'));
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=16:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', join(dir, 'fal-out.mp4')]);
  outVideo = `data:video/mp4;base64,${readFileSync(join(dir, 'fal-out.mp4')).toString('base64')}`;
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'origem.mp4')]);
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=512x512:d=1', '-frames:v', '1', '-update', '1', join(dir, 'char.jpg')]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeQueue(statuses: string[] = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'], url = 'data:video/mp4;base64,AAAA') {
  const seq = [...statuses];
  return {
    submit: vi.fn(async () => ({ request_id: 'req-1' })),
    status: vi.fn(async () => ({ status: (seq.shift() ?? 'COMPLETED') as 'COMPLETED' })),
    result: vi.fn(async () => ({ data: { video: { url } } })),
    cancel: vi.fn(async () => undefined),
  } satisfies FalQueueLike;
}

function baseCtx(params: Record<string, unknown>, inputs: Partial<AssetRow>[] = [], state: Record<string, unknown> = {}) {
  const created: Partial<AssetRow>[] = [];
  const stored = new Map<string, string>([['u1/orig.mp4', join(dir, 'origem.mp4')], ['u1/c.jpg', join(dir, 'char.jpg')]]);
  const ctx = {
    job: { id: 'j1', user_id: 'u1', project_id: null, params, state, input_asset_ids: inputs.map((i) => i.id), estimated_credits: 40 },
    settings: { creditValueUsd: 0.01, markup: 1, runwayUsdPerCredit: 0.01, abortIfProviderEstimateExceeds: true },
    config: {}, workDir: mkdtempSync(join(dir, 'w-')), inputs,
    storage: {
      signedUrl: async (path: string) => `https://storage.example/${path}`,
      download: async (path: string, dest: string) => { const { copyFileSync } = await import('node:fs'); copyFileSync(stored.get(path)!, dest); },
      upload: async (local: string, path: string) => { stored.set(path, local); return 1; },
    },
    db: { from: () => { const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: [{ id: 'img1', path: 'u1/c.jpg' }] }) }; return chain; } },
    progress: vi.fn(async (_p: number | null, s?: Record<string, unknown>) => { if (s) Object.assign(state, s); }),
    isCancelRequested: vi.fn(async () => false),
    createAsset: async (row: Partial<AssetRow>) => { created.push(row); return { id: `a${created.length}`, user_id: 'u1', ...row } as AssetRow; },
    loadAsset: async (id: string) => ({ id, user_id: 'u1', kind: 'image', path: 'u1/c.jpg' }) as AssetRow,
    loadCharacter: async () => ({ id: 'c1', user_id: 'u1', name: 'Luna', kind: 'anime', description: '', appearance: {}, custom_instructions: '', primary_image_id: 'img1', voice: {} }),
  } as unknown as JobContext;
  return { ctx, created, stored };
}

describe('FalAdapter', () => {
  it('envia, acompanha a fila e devolve a URL do vídeo; salva o id do pedido antes de esperar', async () => {
    const q = fakeQueue();
    const { ctx } = baseCtx({});
    const url = await new FalAdapter(q, 1).run(ctx, 'video', 'veed/fabric-1.0', { image_url: 'x', audio_url: 'y', resolution: '480p' }, { label: 'Teste' });
    expect(url).toBe('data:video/mp4;base64,AAAA');
    expect(q.submit).toHaveBeenCalledWith('veed/fabric-1.0', { input: { image_url: 'x', audio_url: 'y', resolution: '480p' } });
    expect(ctx.job.state.video_fal).toBe('req-1');
  });
  it('retomada consulta o mesmo pedido (sem pagar de novo)', async () => {
    const q = fakeQueue(['COMPLETED']);
    const { ctx } = baseCtx({}, [], { video_fal: 'req-antigo' });
    await new FalAdapter(q, 1).run(ctx, 'video', 'veed/fabric-1.0', {}, { label: 'x' });
    expect(q.submit).not.toHaveBeenCalled();
    expect(q.status).toHaveBeenCalledWith('veed/fabric-1.0', { requestId: 'req-antigo', logs: false });
  });
  it('cancelamento pedido pelo usuário cancela na fal', async () => {
    const q = fakeQueue(['IN_QUEUE', 'IN_QUEUE']);
    const { ctx } = baseCtx({});
    (ctx.isCancelRequested as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(new FalAdapter(q, 1).run(ctx, 'v', 'veed/fabric-1.0', {}, { label: 'x' })).rejects.toBeInstanceOf(CanceledError);
    expect(q.cancel).toHaveBeenCalled();
  });
  it('classifica erros', () => {
    expect(mapFalError(new ApiError({ message: 'x', status: 401, body: {} }))).toMatchObject({ code: 'provider_auth' });
    expect(mapFalError(new ApiError({ message: 'x', status: 422, body: { detail: 'image_url inválida' } }))).toMatchObject({ code: 'provider_rejected', message: expect.stringContaining('image_url inválida') });
    expect(mapFalError(new ApiError({ message: 'x', status: 503, body: {} }))).toBeInstanceOf(TransientError);
    expect(mapFalError(new Error('ECONNRESET'))).toBeInstanceOf(TransientError);
  });
});

describe('funções com a fal.ai', () => {
  it('troca de personagem: envia o trecho a 16 quadros/s e devolve o áudio original ao resultado', async () => {
    const q = fakeQueue(['COMPLETED'], outVideo);
    const src: Partial<AssetRow> = { id: 'v1', user_id: 'u1', kind: 'video', category: 'original', name: 'danca.mp4', path: 'u1/orig.mp4', duration_s: 5, has_audio: true, metadata: {}, rights_confirmed_at: 'x' };
    const { ctx, created, stored } = baseCtx({ engine: 'fal', mode: 'full_body', character_id: 'c1', trim_start: 1, trim_end: 4, resolution: '720p' }, [src]);
    (ctx as unknown as { fal: FalAdapter }).fal = new FalAdapter(q, 1);
    const res = await transformHandler(ctx);
    const [endpoint, { input }] = q.submit.mock.calls[0] as unknown as [string, { input: Record<string, unknown> }];
    expect(endpoint).toBe('fal-ai/wan/v2.2-14b/animate/replace');
    expect(input).toMatchObject({ resolution: '720p', image_url: 'https://storage.example/u1/c.jpg' });
    const clip = await probe(stored.get('u1/temp/j1-clip.mp4')!);
    expect(clip.fps).toBe(16);
    expect(clip.duration).toBeCloseTo(3, 0);
    const final = created.find((c) => c.category === 'transformed')!;
    const info = await probe(stored.get(final.path!)!);
    expect(info.hasAudio).toBe(true);
    expect(final.metadata).toMatchObject({ provider: 'fal', synthetic: true });
    expect(res.actualUsd).toBe(0.4);
  }, 120_000);

  it('vídeo por imagem (Wan 2.2) e personagem falando (Fabric)', async () => {
    const q1 = fakeQueue(['COMPLETED'], outVideo);
    const v = baseCtx({ engine: 'fal', model: 'fal-wan2.2', prompt: 'o cachorro sorri e balança a cabeça', aspect: '9:16', duration: 5, character_id: 'c1', resolution: '480p' });
    (v.ctx as unknown as { fal: FalAdapter }).fal = new FalAdapter(q1, 1);
    await videoHandler(v.ctx);
    expect((q1.submit.mock.calls[0] as unknown as [string, { input: Record<string, unknown> }])[1].input).toMatchObject({ aspect_ratio: '9:16', resolution: '480p', image_url: 'https://storage.example/u1/c.jpg' });

    const q2 = fakeQueue(['COMPLETED'], outVideo);
    const t = baseCtx({ resolution: '480p' }, [
      { id: 'i1', kind: 'image' as const, name: 'bulldog.jpg', path: 'u1/c.jpg', character_id: null },
      { id: 'a1', kind: 'audio' as const, name: 'fala.mp3', path: 'u1/fala.mp3', duration_s: 3 },
    ]);
    (t.ctx as unknown as { fal: FalAdapter }).fal = new FalAdapter(q2, 1);
    await talkHandler(t.ctx);
    expect(q2.submit).toHaveBeenCalledWith('veed/fabric-1.0', { input: { image_url: 'https://storage.example/u1/c.jpg', audio_url: 'https://storage.example/u1/fala.mp3', resolution: '480p' } });
    expect(t.created.find((c) => c.kind === 'video')).toMatchObject({ category: 'generated' });
  }, 120_000);

  it('sem chave da fal: erro claro', async () => {
    const { ctx } = baseCtx({}, [{ id: 'i1', kind: 'image' as const, path: 'u1/c.jpg' }, { id: 'a1', kind: 'audio' as const, path: 'x', duration_s: 2 }]);
    await expect(talkHandler(ctx)).rejects.toBeInstanceOf(JobError);
  });
});
