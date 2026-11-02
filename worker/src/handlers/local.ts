/** Tarefas do motor próprio (sem custo de provedor). */
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateCues, parseSrt, toSrt } from '../../../shared/srt.ts';
import type { LocalTtsParams, TranscribeParams } from '../../../shared/jobs.ts';
import { ffmpeg } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { piperSpeak, toWhisperWav, whisperSrt } from '../providers/local.ts';
import { saveOutput } from './media.ts';
import type { Handler, JobContext } from '../types.ts';

const LANGS = ['auto', 'pt', 'en', 'es', 'fr', 'it', 'de'];

async function saveSubtitle(ctx: JobContext, srt: string, name: string, duration: number | null, metadata: Record<string, unknown>) {
  const local = join(ctx.workDir, `${randomUUID()}.srt`);
  await writeFile(local, srt, 'utf8');
  const path = `${ctx.job.user_id}/generated/${randomUUID()}.srt`;
  const size = await ctx.storage.upload(local, path, 'application/x-subrip');
  return ctx.createAsset({
    kind: 'subtitle', category: 'generated', name, path, mime: 'application/x-subrip', size_bytes: size,
    duration_s: duration, probe_status: 'ok', project_id: ctx.job.project_id, metadata,
  });
}

export const transcribeHandler: Handler = async (ctx) => {
  const src = ctx.inputs[0];
  const p = ctx.job.params as TranscribeParams;
  const language = LANGS.includes(p.language ?? 'pt') ? (p.language ?? 'pt') : 'pt';
  const maxLine = Math.min(Math.max(Math.round(p.max_line ?? 42), 0), 80);
  const ext = src.path.split('.').pop() || 'bin';
  const input = join(ctx.workDir, `in.${ext}`);
  await ctx.storage.download(src.path, input);
  const wav = join(ctx.workDir, 'audio.wav');
  await toWhisperWav(input, wav);
  await ctx.progress(0.15, undefined, undefined, 'Reconhecendo a fala');
  const raw = await whisperSrt(ctx.config, wav, join(ctx.workDir, 'legenda'), { language, maxLine });
  const cues = parseSrt(raw).filter((c) => c.text.trim() && !/^\[.*\]$/.test(c.text.trim()));
  if (!cues.length) throw new JobError('no_speech', 'Nenhuma fala foi reconhecida neste arquivo.');
  const sub = await saveSubtitle(ctx, toSrt(cues), `Legendas — ${src.name}`, cues[cues.length - 1].end, {
    engine: 'whisper', language, source_asset_id: src.id, cues: cues.length,
  });
  const text = cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
  return { outputs: [sub.id], result: { cues: cues.length, text: text.slice(0, 20_000) }, actualUsd: null };
};

export const localTtsHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as LocalTtsParams;
  const text = (p.text ?? '').trim();
  if (!text || text.length > 5000) throw new JobError('invalid_params', 'O texto deve ter entre 1 e 5000 caracteres.');
  const wav = join(ctx.workDir, 'voz.wav');
  await ctx.progress(0.1, undefined, undefined, 'Gerando a voz');
  await piperSpeak(ctx.config, p.voice, text, wav, p.speed ?? 1);
  if (!(await stat(wav).then((s) => s.size > 1000, () => false))) throw new JobError('tts_failed', 'A voz gerada ficou vazia.');
  const mp3 = join(ctx.workDir, 'voz.mp3');
  await ffmpeg(['-y', '-i', wav, '-c:a', 'libmp3lame', '-q:a', '3', mp3]);
  const audio = await saveOutput(ctx, mp3, {
    name: `Voz — ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`,
    category: 'generated',
    ext: 'mp3',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'local', engine: 'piper', voice: p.voice, text },
  });
  const outputs = [audio.id];
  if (p.make_subtitles && audio.duration_s) {
    const sub = await saveSubtitle(ctx, toSrt(estimateCues(text, Number(audio.duration_s))), `Legenda — ${text.slice(0, 30)}`, Number(audio.duration_s), {
      estimated: true, source_asset_id: audio.id,
    });
    outputs.push(sub.id);
  }
  return { outputs, actualUsd: null };
};
