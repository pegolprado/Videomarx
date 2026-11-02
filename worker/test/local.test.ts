/**
 * Motor próprio: Whisper e Piper são substituídos por scripts falsos que
 * imitam a interface de linha de comando deles; o resto (FFmpeg, legendas,
 * registro dos arquivos) roda de verdade.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSrt } from '../../shared/srt.ts';
import { ffmpeg } from '../src/ffmpeg.ts';
import { detectLocal } from '../src/providers/local.ts';
import { localTtsHandler, transcribeHandler } from '../src/handlers/local.ts';
import { supportedKinds } from '../src/handlers/index.ts';
import type { Config } from '../src/config.ts';
import type { AssetRow, JobContext } from '../src/types.ts';

let dir: string;
let config: Config;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-local-'));
  mkdirSync(join(dir, 'voices'));
  mkdirSync(join(dir, 'work'));
  // whisper-cli falso: confere os argumentos e grava <of>.srt
  writeFileSync(join(dir, 'whisper-cli'), `#!/bin/bash
echo "$@" > "${dir}/whisper-args.txt"
while [ $# -gt 0 ]; do case "$1" in -of) OF="$2"; shift;; esac; shift; done
printf '1\\n00:00:00,000 --> 00:00:01,500\\nOlá, tudo bem?\\n\\n2\\n00:00:01,500 --> 00:00:02,000\\n[Música]\\n\\n3\\n00:00:02,000 --> 00:00:03,200\\nVamos começar.\\n' > "$OF.srt"
`);
  // piper falso: lê o texto e grava 1,5 s de áudio no --output_file
  writeFileSync(join(dir, 'piper'), `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --output_file) OUT="$2"; shift;; --length_scale) echo "$2" > "${dir}/length.txt"; shift;; esac; shift; done
cat > "${dir}/piper-text.txt"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=300:duration=1.5" "$OUT"
`);
  chmodSync(join(dir, 'whisper-cli'), 0o755);
  chmodSync(join(dir, 'piper'), 0o755);
  writeFileSync(join(dir, 'model.bin'), 'x');
  writeFileSync(join(dir, 'voices', 'pt_BR-faber-medium.onnx'), 'x');
  writeFileSync(join(dir, 'voices', 'pt_BR-faber-medium.onnx.json'), '{}');
  writeFileSync(join(dir, 'voices', 'sem-config.onnx'), 'x');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'fala.mp4')]);
  config = {
    whisperBin: join(dir, 'whisper-cli'), whisperModel: join(dir, 'model.bin'), piperBin: join(dir, 'piper'),
    voicesDir: join(dir, 'voices'), localThreads: 2,
  } as Config;
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeCtx(params: Record<string, unknown>, inputs: Partial<AssetRow>[] = []) {
  const created: Partial<AssetRow>[] = [];
  const uploads: Record<string, string> = {};
  const ctx = {
    job: { id: 'j1', user_id: 'u1', project_id: null, params, state: {} },
    config,
    workDir: join(dir, 'work'),
    inputs,
    storage: {
      download: async (_path: string, dest: string) => copyFileSync(join(dir, 'fala.mp4'), dest),
      upload: async (local: string, path: string) => {
        uploads[path] = readFileSync(local, 'utf8').slice(0, 2000);
        return 123;
      },
    },
    progress: async () => {},
    createAsset: async (row: Partial<AssetRow>) => {
      const a = { id: `a${created.length + 1}`, ...row } as AssetRow;
      created.push(a);
      return a;
    },
  } as unknown as JobContext;
  return { ctx, created, uploads };
}

describe('motor próprio', () => {
  it('detecta Whisper, Piper e só as vozes completas (.onnx + .onnx.json)', async () => {
    expect(await detectLocal(config)).toEqual({ transcribe: true, tts: true, voices: ['pt_BR-faber-medium'] });
    expect(await detectLocal({ ...config, whisperModel: '/nao/existe' })).toMatchObject({ transcribe: false });
    expect(supportedKinds({ ffmpeg: true, runway: false, anthropic: false, local_transcribe: true, local_tts: true })).toEqual(
      expect.arrayContaining(['local.transcribe', 'local.tts']),
    );
    expect(supportedKinds({ ffmpeg: false, runway: false, anthropic: false, local_transcribe: true })).not.toContain('local.transcribe');
  });

  it('gera legendas a partir do áudio do vídeo e descarta marcações como [Música]', async () => {
    const { ctx, created, uploads } = fakeCtx({ language: 'pt', max_line: 42 }, [{ id: 'v1', name: 'aula.mp4', path: 'u1/uploads/v1.mp4', kind: 'video' }]);
    const res = await transcribeHandler(ctx);
    const args = readFileSync(join(dir, 'whisper-args.txt'), 'utf8');
    expect(args).toContain('-l pt');
    expect(args).toContain('-osrt');
    expect(args).toContain('-ml 42');
    expect(created[0]).toMatchObject({ kind: 'subtitle', category: 'generated', probe_status: 'ok' });
    const srt = Object.values(uploads)[0];
    expect(parseSrt(srt).map((c) => c.text)).toEqual(['Olá, tudo bem?', 'Vamos começar.']);
    expect(res.result).toMatchObject({ cues: 2, text: 'Olá, tudo bem? Vamos começar.' });
    expect(res.actualUsd).toBeNull();
  }, 60_000);

  it('gera voz em MP3 com legenda estimada', async () => {
    const { ctx, created } = fakeCtx({ text: 'Olá! Eu sou a Luna.', voice: 'pt_BR-faber-medium', speed: 1.25, make_subtitles: true });
    const res = await localTtsHandler(ctx);
    expect(readFileSync(join(dir, 'piper-text.txt'), 'utf8')).toBe('Olá! Eu sou a Luna.');
    expect(readFileSync(join(dir, 'length.txt'), 'utf8').trim()).toBe('0.800');
    expect(created.map((c) => c.kind)).toEqual(['audio', 'subtitle']);
    expect(created[0]).toMatchObject({ category: 'generated', metadata: expect.objectContaining({ synthetic: true, engine: 'piper' }) });
    expect(Number(created[0].duration_s)).toBeCloseTo(1.5, 0);
    expect(res.outputs).toHaveLength(2);
  }, 60_000);

  it('recusa voz inexistente ou nome suspeito', async () => {
    for (const voice of ['nao-existe', '../../etc/passwd']) {
      const { ctx } = fakeCtx({ text: 'oi', voice });
      await expect(localTtsHandler(ctx)).rejects.toThrow(/Voz indisponível/);
    }
  });
});
