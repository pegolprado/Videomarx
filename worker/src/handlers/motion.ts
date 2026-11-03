/** Modelo animado (HyperFrames): textos + imagens (+ áudio opcional) → MP4, grátis no nosso servidor. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMotionHtml, validateMotion } from '../../../shared/motion.ts';
import type { MotionParams } from '../../../shared/jobs.ts';
import { ffmpeg } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { renderMotion } from '../providers/motion.ts';
import type { Handler } from '../types.ts';
import { saveOutput } from './media.ts';

export const motionHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as MotionParams;
  const images = ctx.inputs.filter((a) => a.kind === 'image');
  const audio = ctx.inputs.find((a) => a.kind === 'audio');
  const invalid = validateMotion(p, images.length);
  if (invalid) throw new JobError('invalid_params', invalid);

  const dir = join(ctx.workDir, 'projeto');
  await mkdir(join(dir, 'assets'), { recursive: true });
  const rel: string[] = [];
  for (const [i, img] of images.entries()) {
    const ext = (img.path.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const name = `assets/img${i}.${ext}`;
    await ctx.storage.download(img.path, join(dir, name));
    rel.push(name);
  }
  await ctx.progress(0.1, undefined, undefined, 'Imagens preparadas');
  const { html, plan } = buildMotionHtml(p, rel);
  const silent = join(ctx.workDir, 'animado.mp4');
  await renderMotion({ dir, html, output: silent, browser: ctx.config.motionBrowser });
  await ctx.progress(0.85, undefined, undefined, 'Animação renderizada');

  let final = silent;
  if (audio) {
    const audioLocal = join(ctx.workDir, 'audio.' + (audio.path.split('.').pop() || 'mp3'));
    await ctx.storage.download(audio.path, audioLocal);
    final = join(ctx.workDir, 'animado-com-audio.mp4');
    // a duração é a do vídeo; a trilha termina com fade suave
    const fadeAt = Math.max(0, plan.duration - 1.5).toFixed(2);
    await ffmpeg(['-y', '-i', silent, '-i', audioLocal, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-af', `afade=t=out:st=${fadeAt}:d=1.5`, '-c:a', 'aac', '-b:a', '160k', '-t', plan.duration.toFixed(2), '-movflags', '+faststart', final]);
  }
  const asset = await saveOutput(ctx, final, {
    name: (p.title?.trim() || 'Modelo animado').slice(0, 120),
    category: 'generated',
    ext: 'mp4',
    metadata: { synthetic: false, provider: 'motion', template: p.template, palette: p.palette, aspect: p.aspect, source_asset_ids: ctx.inputs.map((a) => a.id) },
  });
  return { outputs: [asset.id], actualUsd: null };
};
