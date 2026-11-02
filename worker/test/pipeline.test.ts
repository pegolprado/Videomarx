/** Vídeo automático de ponta a ponta: provedores simulados, FFmpeg real. */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseSrt } from '../../shared/srt.ts';
import { ffmpeg, probe } from '../src/ffmpeg.ts';
import { autoVideoHandler } from '../src/handlers/pipeline.ts';
import type { Config } from '../src/config.ts';
import type { AssetRow, JobContext } from '../src/types.ts';

let dir: string;
let jpeg: Buffer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-auto-'));
  mkdirSync(join(dir, 'voices'));
  mkdirSync(join(dir, 'store'));
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=orange:s=1024x1024:d=1', '-frames:v', '1', '-update', '1', join(dir, 'img.jpg')]);
  jpeg = readFileSync(join(dir, 'img.jpg'));
  // piper falso: 1 s de áudio a cada 10 caracteres do texto (mín. 1 s)
  writeFileSync(join(dir, 'piper'), `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --output_file) OUT="$2"; shift;; esac; shift; done
TEXT=$(cat); LEN=\${#TEXT}; D=$(( LEN / 10 )); [ $D -lt 1 ] && D=1
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=220:duration=$D" "$OUT"
`);
  chmodSync(join(dir, 'piper'), 0o755);
  writeFileSync(join(dir, 'voices', 'pt_BR-faber-medium.onnx'), 'x');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=3', '-c:a', 'libmp3lame', join(dir, 'store', 'musica.mp3')]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PLAN = {
  title: 'Curiosidades do mar',
  scenes: [
    { narration: 'Você sabia que o polvo tem três corações?', image_prompt_en: 'an octopus' }, // 41 chars → 4 s
    { narration: 'E o sangue dele é azul.', image_prompt_en: 'blue blood' }, // 23 → 2 s
    { narration: 'Siga para mais curiosidades!', image_prompt_en: 'ocean' }, // 28 → 2 s
  ],
};

function makeCtx(state: Record<string, unknown> = {}) {
  const store = new Map<string, string>([['u1/m/musica.mp3', join(dir, 'store', 'musica.mp3')]]);
  const assets = new Map<string, Partial<AssetRow>>([['m1', { id: 'm1', user_id: 'u1', kind: 'audio', path: 'u1/m/musica.mp3' }]]);
  const flux = vi.fn(async () => jpeg);
  const generate = vi.fn(async () => ({ data: PLAN, usd: 0, usage: { input_tokens: 1, output_tokens: 1, model: 'g' } }));
  let n = 0;
  const ctx = {
    job: {
      id: 'j1', user_id: 'u1', project_id: null, state, input_asset_ids: [],
      params: { mode: 'topic', topic: 'polvos', scenes: 3, aspect: '9:16', style: 'anime', voice: 'pt_BR-faber-medium', caption: 'boxed', music_asset_id: 'm1', music_volume: 0.2 },
    },
    config: { piperBin: join(dir, 'piper'), voicesDir: join(dir, 'voices') } as Config,
    workDir: mkdtempSync(join(dir, 'work-')),
    inputs: [],
    cloudflare: { flux },
    gemini: { generate },
    storage: {
      download: async (path: string, dest: string) => copyFileSync(store.get(path)!, dest),
      upload: async (local: string, path: string) => {
        const keep = join(dir, 'store', path.replace(/\//g, '_'));
        copyFileSync(local, keep);
        store.set(path, keep);
        return 1;
      },
    },
    progress: vi.fn(async (_p: number | null, s?: Record<string, unknown>) => {
      if (s) Object.assign(state, s);
    }),
    createAsset: async (row: Partial<AssetRow>) => {
      const a = { id: `a${++n}`, user_id: 'u1', ...row } as AssetRow;
      assets.set(a.id, a);
      return a;
    },
    loadAsset: async (id: string) => assets.get(id) as AssetRow,
    loadCharacter: async () => { throw new Error('sem personagem'); },
  } as unknown as JobContext;
  return { ctx, flux, generate, store, assets };
}

describe('vídeo automático', () => {
  it('tema → roteiro → 3 imagens → narração por cena → vídeo com legenda e música', async () => {
    const { ctx, flux, store, assets } = makeCtx();
    const res = await autoVideoHandler(ctx);
    expect(flux).toHaveBeenCalledTimes(3);
    expect((flux.mock.calls[0] as unknown as [string])[0]).toContain('anime illustration');
    const video = assets.get(res.outputs[0])!;
    const info = await probe(store.get(video.path!)!);
    expect(info).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    // 4 s + 2 s + 2 s de narração
    expect(info.duration!).toBeGreaterThan(7.6);
    expect(info.duration!).toBeLessThan(8.6);
    const sub = assets.get(res.outputs[1])!;
    const cues = parseSrt(readFileSync(store.get(sub.path!)!, 'utf8'));
    // a fala da 2ª cena começa quando a 1ª termina (4 s)
    expect(cues.find((c) => c.text.startsWith('E o sangue'))!.start).toBeCloseTo(4, 1);
    expect(res.result).toMatchObject({ title: 'Curiosidades do mar' });
  }, 180_000);

  it('retomada não gera imagens de novo nem refaz o roteiro', async () => {
    const first = makeCtx();
    await autoVideoHandler(first.ctx);
    const saved = first.ctx.job.state as { images: string[] };
    expect(saved.images).toHaveLength(3);
    const again = makeCtx({ ...first.ctx.job.state });
    // reaproveita os arquivos já salvos
    for (const [k, v] of first.store) again.store.set(k, v);
    for (const [k, v] of first.assets) again.assets.set(k, v);
    await autoVideoHandler(again.ctx);
    expect(again.flux).not.toHaveBeenCalled();
    expect(again.generate).not.toHaveBeenCalled();
  }, 180_000);

  it('sem Gemini, o modo tema explica o que falta; o modo roteiro funciona sem ele', async () => {
    const { ctx } = makeCtx();
    (ctx as unknown as { gemini?: unknown }).gemini = undefined;
    await expect(autoVideoHandler(ctx)).rejects.toMatchObject({ code: 'not_configured' });
    const s = makeCtx();
    (s.ctx as unknown as { gemini?: unknown }).gemini = undefined;
    Object.assign(s.ctx.job.params, { mode: 'script', script: 'Primeira cena.\n\nSegunda cena.', voice: '', music_asset_id: undefined, caption: 'none' });
    const res = await autoVideoHandler(s.ctx);
    const info = await probe(s.store.get(s.assets.get(res.outputs[0])!.path!)!);
    expect(info.hasAudio).toBe(false);
    expect(s.flux).toHaveBeenCalledTimes(2);
  }, 180_000);
});
