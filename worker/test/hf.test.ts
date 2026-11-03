/** GPU grátis (Spaces Gradio do Hugging Face) e Pollinations: servidores simulados; FFmpeg real. */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ffmpeg, probe } from '../src/ffmpeg.ts';
import { GradioSpace, extractFileUrl, mapSpaceError, pickDependency, spaceBase, type GradioConfig } from '../src/providers/gradio.ts';
import { PollinationsAdapter, videoUrl } from '../src/providers/pollinations.ts';
import { talkHandler, transformHandler, videoHandler } from '../src/handlers/ai.ts';
import { JobError, TransientError } from '../src/errors.ts';
import type { AssetRow, JobContext } from '../src/types.ts';

let dir: string;
let outBytes: Buffer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-hf-'));
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=16:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', join(dir, 'out.mp4')]);
  outBytes = readFileSync(join(dir, 'out.mp4'));
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'origem.mp4')]);
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=512x512:d=1', '-frames:v', '1', '-update', '1', join(dir, 'char.jpg')]);
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', join(dir, 'fala.mp3')]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = 'https://dono-space.hf.space';
const sse = (msgs: object[]) => new Response(new ReadableStream({
  start(c) {
    for (const m of msgs) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(m)}\n\n`));
    c.close();
  },
}));

/** Space falso: guarda o corpo do queue/join e responde com os eventos dados. */
function fakeSpace(cfg: GradioConfig, events: object[], uploads = ['/tmp/g/a', '/tmp/g/b']) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let joined: { data: unknown[]; fn_index: number } | undefined;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === `${BASE}/config`) return Response.json(cfg);
    if (url.endsWith('/gradio_api/upload')) return Response.json(uploads.slice(0, (init!.body as FormData).getAll('files').length));
    if (url.endsWith('/gradio_api/queue/join')) {
      joined = JSON.parse(String(init!.body));
      return Response.json({ event_id: 'e1' });
    }
    if (url.includes('/gradio_api/queue/data')) return sse(events);
    if (url.includes('/file=')) return new Response(outBytes);
    return new Response('?', { status: 404 });
  });
  return { fetchFn, calls, joined: () => joined };
}

const done = (ok = true, error?: string) => ({
  msg: 'process_completed', event_id: 'e1', success: ok,
  output: ok ? { data: [{ video: { path: '/tmp/out.mp4', url: `${BASE}/gradio_api/file=/tmp/out.mp4` }, subtitles: null }] } : { error, data: null },
});

function ctxFor(params: Record<string, unknown>, inputs: Partial<AssetRow>[], space: GradioSpace, extra: Partial<JobContext> = {}) {
  const created: Partial<AssetRow>[] = [];
  const state: Record<string, unknown> = {};
  const stored = new Map<string, string>([['u1/orig.mp4', join(dir, 'origem.mp4')], ['u1/c.jpg', join(dir, 'char.jpg')], ['u1/fala.mp3', join(dir, 'fala.mp3')]]);
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: [{ id: 'img1', path: 'u1/c.jpg' }] }), maybeSingle: async () => ({ data: null }) };
  const ctx = {
    job: { id: 'j1', user_id: 'u1', project_id: null, params, state, input_asset_ids: inputs.map((i) => i.id), estimated_credits: 0 },
    settings: { creditValueUsd: 0.01, markup: 1, runwayUsdPerCredit: 0.01, abortIfProviderEstimateExceeds: true },
    config: {}, workDir: mkdtempSync(join(dir, 'w-')), inputs,
    storage: {
      signedUrl: async (path: string) => `https://storage.example/${path}`,
      download: async (path: string, dest: string) => copyFileSync(stored.get(path)!, dest),
      upload: async (local: string, path: string) => { stored.set(path, local); return 1; },
    },
    db: { from: () => chain },
    hf: { open: () => space },
    progress: vi.fn(async (_p: number | null, s?: Record<string, unknown>) => { if (s) Object.assign(state, s); }),
    isCancelRequested: vi.fn(async () => false),
    createAsset: async (row: Partial<AssetRow>) => { created.push(row); return { id: `a${created.length}`, user_id: 'u1', ...row } as AssetRow; },
    loadAsset: async (id: string) => ({ id, user_id: 'u1', kind: 'image', path: 'u1/c.jpg', name: 'c.jpg' }) as AssetRow,
    loadCharacter: async () => ({ id: 'c1', user_id: 'u1', name: 'Luna', kind: 'anime', description: '', appearance: {}, custom_instructions: '', primary_image_id: 'img1', voice: {} }),
    ...extra,
  } as unknown as JobContext;
  return { ctx, created, state };
}

const animateCfg: GradioConfig = {
  api_prefix: '/gradio_api',
  components: [
    { id: 1, type: 'video', props: { label: 'Driving video' } },
    { id: 2, type: 'slider', props: { label: 'Duration (s)', minimum: 2, maximum: 20, value: 2 } },
    { id: 3, type: 'image', props: { label: 'Reference' } },
    { id: 4, type: 'radio', props: { label: 'Mode', choices: [['Move', 'Move'], ['Character Swap', 'Character Swap']], value: 'Move' } },
    { id: 5, type: 'radio', props: { label: 'Quality', choices: ['Medium Res', 'Low Res'], value: 'Medium Res' } },
    { id: 6, type: 'state', props: {} },
  ],
  dependencies: [{ api_name: 'outra', inputs: [3] }, { api_name: 'animate_scene', inputs: [1, 2, 3, 4, 5, 6] }],
};

describe('Spaces Gradio', () => {
  it('endereço do Space e escolha do endpoint', () => {
    expect(spaceBase('alexnasa/Wan2.2-Animate-ZEROGPU')).toBe('https://alexnasa-wan2-2-animate-zerogpu.hf.space');
    expect(spaceBase('https://x.hf.space/')).toBe('https://x.hf.space');
    expect(() => spaceBase('sem-barra')).toThrow(JobError);
    expect(pickDependency(animateCfg, '/animate_scene', [])).toBe(1);
    expect(pickDependency(animateCfg, 'sumiu', ['video', 'image'])).toBe(1);
    expect(() => pickDependency(animateCfg, null, ['audio'])).toThrow(/mudou/);
  });

  it('extrai a URL do resultado em formatos diferentes', () => {
    const f = (p: string) => `F:${p}`;
    expect(extractFileUrl([{ video: { path: '/a.mp4' }, subtitles: null }], f)).toBe('F:/a.mp4');
    expect(extractFileUrl([{ url: 'https://u' }], f)).toBe('https://u');
    expect(extractFileUrl([null, [{ image: { path: '/i.png' } }]], f)).toBe('F:/i.png');
    expect(extractFileUrl([null], f)).toBeNull();
  });

  it('traduz cota esgotada e GPU ocupada', () => {
    expect(mapSpaceError('You have exceeded your GPU quota (60s requested vs. 12s left). Try again in 20:00:00')).toMatchObject({ code: 'free_quota' });
    expect(mapSpaceError('No GPU was available after 60s')).toBeInstanceOf(TransientError);
    expect(mapSpaceError('ValueError: bad image')).toMatchObject({ code: 'provider_failed' });
  });
});

describe('troca de personagem grátis (Wan 2.2 Animate)', () => {
  const src = { id: 'v1', user_id: 'u1', kind: 'video' as const, name: 'danca.mp4', path: 'u1/orig.mp4', duration_s: 5, has_audio: true };

  it('preenche as entradas pelo tipo, escolhe "Character Swap" e baixa, devolvendo o áudio original', async () => {
    const fs = fakeSpace(animateCfg, [
      { msg: 'estimation', event_id: 'e1', rank: 2, rank_eta: 120 },
      { msg: 'process_starts', event_id: 'e1' },
      { msg: 'progress', event_id: 'e1', progress_data: [{ index: 3, length: 6 }] },
      done(),
    ]);
    const space = new GradioSpace('dono/space', 'hf_tok', fs.fetchFn);
    const { ctx, created } = ctxFor({ engine: 'hf', mode: 'full_body', character_id: 'c1', trim_start: 1, trim_end: 4 }, [src], space);
    const res = await transformHandler(ctx);
    const j = fs.joined()!;
    expect(j.fn_index).toBe(1);
    expect(j.data).toEqual([
      { video: { path: '/tmp/g/a', orig_name: 'clip.mp4', meta: { _type: 'gradio.FileData' } }, subtitles: null },
      3,
      { path: '/tmp/g/b', orig_name: 'personagem.jpg', meta: { _type: 'gradio.FileData' } },
      'Character Swap',
      'Low Res',
      null,
    ]);
    // token enviado ao Space
    expect((fs.calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer hf_tok');
    expect(res.actualUsd).toBe(0);
    expect(created[0]).toMatchObject({ category: 'transformed', metadata: expect.objectContaining({ provider: 'hf', mode: 'full_body' }) });
    expect(vi.mocked(ctx.progress).mock.calls.some((c) => String(c[3]).includes('posição 3'))).toBe(true);
  }, 60_000);

  it('cota grátis esgotada vira mensagem clara (sem nova tentativa)', async () => {
    const fs = fakeSpace(animateCfg, [done(false, 'You have exceeded your free GPU quota. Try again in 23:10:00')]);
    const { ctx } = ctxFor({ engine: 'hf', mode: 'full_body', character_id: 'c1' }, [src], new GradioSpace('dono/space', undefined, fs.fetchFn));
    await expect(transformHandler(ctx)).rejects.toMatchObject({ code: 'free_quota' });
  }, 60_000);

  it('recusa modo que o Space não oferece antes de gastar cota', async () => {
    const cfg: GradioConfig = { ...animateCfg, components: animateCfg.components.map((c) => (c.id === 4 ? { ...c, props: { choices: ['Character Swap'] } } : c)) };
    const fs = fakeSpace(cfg, [done()]);
    const { ctx } = ctxFor({ engine: 'hf', mode: 'cinematic', character_id: 'c1' }, [src], new GradioSpace('dono/space', undefined, fs.fetchFn));
    await expect(transformHandler(ctx)).rejects.toMatchObject({ code: 'unsupported_mode' });
    expect(fs.joined()).toBeUndefined();
  });
});

describe('vídeo com movimento grátis (Wan 2.2)', () => {
  const cfg: GradioConfig = {
    components: [
      { id: 1, type: 'image', props: { label: 'Input Image' } },
      { id: 2, type: 'textbox', props: { label: 'Prompt', value: 'x' } },
      { id: 3, type: 'slider', props: { label: 'Steps', value: 4, minimum: 1, maximum: 30 } },
      { id: 4, type: 'textbox', props: { label: 'Negative Prompt', value: 'neg' } },
      { id: 5, type: 'slider', props: { label: 'Duration (seconds)', value: 3.5, minimum: 0.5, maximum: 4 } },
      { id: 6, type: 'checkbox', props: { label: 'Randomize seed', value: true } },
    ],
    dependencies: [{ api_name: 'generate_video', inputs: [1, 2, 3, 4, 5, 6] }],
  };

  it('usa a imagem do personagem, o prompt e limita a duração ao máximo do Space', async () => {
    const fs = fakeSpace(cfg, [done()], ['/tmp/g/img']);
    const { ctx, created } = ctxFor({ engine: 'hf', model: 'hf-wan2.2', prompt: 'ela acena e sorri', duration: 5, aspect: '9:16', character_id: 'c1' }, [], new GradioSpace('dono/space', undefined, fs.fetchFn));
    await videoHandler(ctx);
    // gradio 4 sem api_prefix → usa o padrão /gradio_api
    expect(fs.joined()!.data).toEqual([{ path: '/tmp/g/img', orig_name: expect.stringMatching(/^inicio-.*\.jpg$/), meta: { _type: 'gradio.FileData' } }, 'ela acena e sorri', 4, 'neg', 4, true]);
    expect(created[0].metadata).toMatchObject({ provider: 'hf', start_image_from_text: false });
  }, 60_000);

  it('sem imagem e sem Cloudflare explica o que falta', async () => {
    const fs = fakeSpace(cfg, [done()]);
    const { ctx } = ctxFor({ engine: 'hf', prompt: 'um gato', duration: 5, aspect: '9:16' }, [], new GradioSpace('dono/space', undefined, fs.fetchFn));
    await expect(videoHandler(ctx)).rejects.toThrow(/Cloudflare/);
  });

  it('sem imagem, cria a primeira grátis na Cloudflare', async () => {
    const fs = fakeSpace(cfg, [done()], ['/tmp/g/img']);
    const flux = vi.fn(async () => readFileSync(join(dir, 'char.jpg')));
    const { ctx, created } = ctxFor({ engine: 'hf', prompt: 'um gato', duration: 3, aspect: '16:9' }, [], new GradioSpace('dono/space', undefined, fs.fetchFn), { cloudflare: { flux } as never });
    await videoHandler(ctx);
    expect(flux).toHaveBeenCalledWith(expect.stringContaining('16:9'));
    expect(created[0].metadata).toMatchObject({ start_image_from_text: true });
  }, 60_000);
});

describe('personagem falando grátis', () => {
  it('envia imagem e áudio ao endpoint detectado sozinho', async () => {
    const cfg: GradioConfig = {
      components: [
        { id: 1, type: 'image', props: {} }, { id: 2, type: 'audio', props: {} }, { id: 3, type: 'textbox', props: { label: 'Prompt' } },
        { id: 9, type: 'textbox', props: {} },
      ],
      dependencies: [{ api_name: 'traduz', inputs: [9] }, { api_name: 'infer', inputs: [1, 2, 3] }],
    };
    const fs = fakeSpace(cfg, [done()]);
    const inputs = [
      { id: 'i1', user_id: 'u1', kind: 'image' as const, name: 'luna.jpg', path: 'u1/c.jpg', character_id: 'c1' },
      { id: 'a1', user_id: 'u1', kind: 'audio' as const, name: 'fala.mp3', path: 'u1/fala.mp3', duration_s: 2 },
    ];
    const { ctx, created } = ctxFor({ engine: 'hf' }, inputs, new GradioSpace('dono/space', undefined, fs.fetchFn));
    await talkHandler(ctx);
    const j = fs.joined()!;
    expect(j.fn_index).toBe(1);
    expect((j.data[1] as { orig_name: string }).orig_name).toBe('fala.mp3');
    expect(j.data[2]).toMatch(/talking/);
    expect(created[0].metadata).toMatchObject({ provider: 'hf' });
  }, 60_000);
});

describe('Pollinations', () => {
  it('monta a URL de vídeo com modelo, duração, proporção e imagem', () => {
    const u = new URL(videoUrl({ model: 'alibaba/wan-2.2-fast', prompt: 'um barco / rio', duration: 5, aspectRatio: '9:16', image: 'https://s/x.jpg?token=a&b=1' }));
    expect(u.pathname).toBe('/video/um%20barco%20%2F%20rio');
    expect(u.searchParams.get('image')).toBe('https://s/x.jpg?token=a&b=1');
    expect(u.searchParams.get('model')).toBe('alibaba/wan-2.2-fast');
  });

  function pollFetch(statuses: string[]) {
    const seq = [...statuses];
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/video/')) return Response.json({ id: 'job1', status: 'pending' }, { status: 202 });
      if (url.endsWith('/v1/jobs/job1')) return Response.json({ status: seq.shift() ?? 'succeeded' });
      if (url.endsWith('/v1/jobs/job1/result')) return new Response(outBytes, { headers: { 'content-type': 'video/mp4' } });
      return new Response('?', { status: 404 });
    });
  }

  it('gera em modo assíncrono, salva o id antes de esperar e cobra a tabela', async () => {
    const fetchFn = pollFetch(['pending', 'succeeded']);
    const pol = new PollinationsAdapter('sk_teste', fetchFn, 1);
    const { ctx, created, state } = ctxFor({ engine: 'pollinations', model: 'pollinations-wan2.2', prompt: 'um barco', duration: 5, aspect: '9:16' }, [], undefined as never, { pollinations: pol });
    (ctx.job as { estimated_credits: number }).estimated_credits = 5;
    const res = await videoHandler(ctx);
    expect(state.video_pollinations).toBe('job1');
    expect(fetchFn.mock.calls[0][0]).toContain('model=alibaba%2Fwan-2.2-fast');
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer sk_teste', Prefer: 'respond-async' });
    expect(res.actualUsd).toBe(0.05);
    expect(created[0].metadata).toMatchObject({ provider: 'pollinations' });
    expect((await probe(join(ctx.workDir, readdirMp4(ctx.workDir)))).kind).toBe('video');
  }, 60_000);

  it('retomada usa o pedido salvo (não paga de novo)', async () => {
    const fetchFn = pollFetch(['succeeded']);
    const { ctx, state } = ctxFor({ engine: 'pollinations', prompt: 'um barco', duration: 5, aspect: '9:16' }, [], undefined as never, { pollinations: new PollinationsAdapter('sk', fetchFn, 1) });
    state.video_pollinations = 'job1';
    await videoHandler(ctx);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('/video/'))).toBe(false);
  }, 60_000);

  it('sem saldo pago: mensagem clara', async () => {
    const fetchFn = vi.fn(async () => Response.json({ status: 402, success: false, error: { code: 'PAYMENT_REQUIRED', message: 'Insufficient pollen' } }, { status: 402 }));
    const { ctx } = ctxFor({ engine: 'pollinations', prompt: 'x', duration: 5, aspect: '9:16' }, [], undefined as never, { pollinations: new PollinationsAdapter('sk', fetchFn, 1) });
    await expect(videoHandler(ctx)).rejects.toMatchObject({ code: 'provider_billing' });
  });
});

function readdirMp4(d: string): string {
  return readdirSync(d).find((f) => f.startsWith('pollinations-'))!;
}
