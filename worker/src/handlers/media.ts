/** Tarefas de mídia executadas localmente com FFmpeg. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildExportArgs, concatFilter, escapeFilterPath, selectSegmentsFilter, slideDurations, slideshowFilter, speechSegments } from '../../../shared/ffmpeg.ts';
import type { AutocutParams, ConcatParams, ExportParams, SlideshowParams } from '../../../shared/jobs.ts';
import { parseSrt } from '../../../shared/srt.ts';
import { ffmpeg, frameAt, probe, type ProbeInfo } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { mimeFor } from '../storage.ts';
import type { AssetRow, Handler, JobContext } from '../types.ts';

export const SYNTHETIC_NOTE = 'Contém conteúdo gerado ou alterado por IA (VideoAI Studio)';

const ALLOWED_FORMATS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2', 'mp3', 'wav', 'ogg'];

/** Salva um arquivo local como novo asset, já analisado (com miniatura). */
export async function saveOutput(
  ctx: JobContext,
  local: string,
  opts: { name: string; category: string; ext: string; characterId?: string | null; metadata?: Record<string, unknown>; rightsFrom?: AssetRow; info?: ProbeInfo },
): Promise<AssetRow> {
  const info = opts.info ?? (await probe(local));
  const id = randomUUID();
  const folder = opts.category === 'export' ? 'exports' : opts.category === 'temp' ? 'temp' : 'generated';
  const path = `${ctx.job.user_id}/${folder}/${id}.${opts.ext}`;
  const size = await ctx.storage.upload(local, path, mimeFor(path));
  let thumbnail: string | null = null;
  if (info.kind === 'video' || info.kind === 'image') {
    const thumbLocal = join(ctx.workDir, `${id}-thumb.jpg`);
    await frameAt(local, thumbLocal, info.kind === 'video' ? Math.min(1, (info.duration ?? 0) / 3) : 0);
    thumbnail = `${ctx.job.user_id}/thumbs/${id}.jpg`;
    await ctx.storage.upload(thumbLocal, thumbnail, 'image/jpeg');
  }
  return ctx.createAsset({
    id,
    kind: info.kind === 'unknown' ? 'other' : info.kind,
    category: opts.category,
    name: opts.name,
    path,
    mime: mimeFor(path),
    size_bytes: size,
    duration_s: info.duration,
    width: info.width,
    height: info.height,
    has_audio: info.hasAudio,
    thumbnail_path: thumbnail,
    character_id: opts.characterId ?? null,
    project_id: ctx.job.project_id,
    metadata: opts.metadata ?? {},
    probe_status: 'ok',
    rights_confirmed_at: opts.rightsFrom?.rights_confirmed_at ?? null,
  } as Partial<AssetRow> & Pick<AssetRow, 'kind' | 'category' | 'name' | 'path'>);
}

async function fetchInput(ctx: JobContext, asset: AssetRow, label = 'in'): Promise<string> {
  const ext = asset.path.split('.').pop() || 'bin';
  const local = join(ctx.workDir, `${label}-${asset.id}.${ext}`);
  await ctx.storage.download(asset.path, local);
  return local;
}

function isSynthetic(...assets: AssetRow[]) {
  return assets.some((a) => a.metadata?.synthetic === true || ['generated', 'transformed'].includes(a.category));
}

export const probeHandler: Handler = async (ctx) => {
  const asset = ctx.inputs[0];
  const local = await fetchInput(ctx, asset);
  if (asset.kind === 'subtitle') {
    const cues = parseSrt(await readFile(local, 'utf8'));
    if (!cues.length) {
      await markInvalid(ctx, asset, 'Legenda .srt vazia ou inválida');
      throw new JobError('invalid_file', 'Legenda .srt vazia ou inválida.');
    }
    const duration = cues[cues.length - 1].end;
    await ctx.db.from('assets').update({ probe_status: 'ok', duration_s: duration, metadata: { ...asset.metadata, cues: cues.length } }).eq('id', asset.id);
    return { outputs: [asset.id], result: { cues: cues.length }, actualUsd: null };
  }
  let info: ProbeInfo;
  try {
    info = await probe(local);
  } catch (e) {
    await markInvalid(ctx, asset, (e as Error).message);
    throw e;
  }
  const problems: string[] = [];
  if (!ALLOWED_FORMATS.includes(info.format)) problems.push(`Formato não suportado (${info.format || 'desconhecido'})`);
  if (asset.kind === 'video' && info.kind !== 'video') problems.push('O arquivo não contém vídeo');
  if (asset.kind === 'image' && info.kind !== 'image') problems.push('O arquivo não é uma imagem');
  if (asset.kind === 'audio' && !info.hasAudio) problems.push('O arquivo não contém áudio');
  if (info.kind === 'video' && (!info.duration || info.duration < 0.5)) problems.push('Vídeo vazio ou curto demais');
  if (info.kind === 'video' && (info.width ?? 0) < 240) problems.push('Resolução muito baixa');
  if (problems.length) {
    await markInvalid(ctx, asset, problems.join('; '));
    throw new JobError('invalid_file', problems.join('; '));
  }

  const meta: Record<string, unknown> = { format: info.format, video_codec: info.videoCodec };
  let thumbnail: string | null = null;
  if (info.kind === 'video' || info.kind === 'image') {
    const t = join(ctx.workDir, 'thumb.jpg');
    await frameAt(local, t, info.kind === 'video' ? Math.min(1, (info.duration ?? 0) / 3) : 0);
    thumbnail = `${asset.user_id}/thumbs/${asset.id}.jpg`;
    await ctx.storage.upload(t, thumbnail, 'image/jpeg');
  }
  if (info.kind === 'video' && info.duration) {
    // quadros de prévia para o usuário conferir quem aparece no vídeo
    const frames: string[] = [];
    for (const [i, f] of [0.1, 0.5, 0.9].entries()) {
      const t = join(ctx.workDir, `frame${i}.jpg`);
      await frameAt(local, t, info.duration * f, 640);
      const p = `${asset.user_id}/thumbs/${asset.id}-f${i}.jpg`;
      await ctx.storage.upload(t, p, 'image/jpeg');
      frames.push(p);
    }
    meta.preview_frames = frames;
    const ratio = (info.width ?? 1) / (info.height ?? 1);
    meta.aspect = ratio > 1.2 ? '16:9' : ratio < 0.8 ? '9:16' : '1:1';
  }
  const { error } = await ctx.db
    .from('assets')
    .update({
      probe_status: 'ok',
      duration_s: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      has_audio: info.hasAudio,
      size_bytes: info.sizeBytes,
      thumbnail_path: thumbnail,
      metadata: { ...asset.metadata, ...meta },
    })
    .eq('id', asset.id);
  if (error) throw new Error(error.message);
  return { outputs: [asset.id], result: { ...info }, actualUsd: null };
};

async function markInvalid(ctx: JobContext, asset: AssetRow, reason: string) {
  await ctx.db.from('assets').update({ probe_status: 'invalid', metadata: { ...asset.metadata, invalid_reason: reason } }).eq('id', asset.id);
}

export const trimHandler: Handler = async (ctx) => {
  const src = ctx.inputs[0];
  const p = ctx.job.params as { trim_start?: number; trim_end?: number };
  const start = Math.max(0, p.trim_start ?? 0);
  const end = Math.min(Number(src.duration_s), p.trim_end ?? Number(src.duration_s));
  if (end - start < 0.3) throw new JobError('invalid_params', 'Trecho muito curto.');
  const local = await fetchInput(ctx, src);
  const out = join(ctx.workDir, 'trim.mp4');
  const args = ['-y', '-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', local, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  if (src.has_audio) args.push('-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  await ffmpeg([...args, out]);
  const asset = await saveOutput(ctx, out, {
    name: `${src.name} (${start.toFixed(1)}–${end.toFixed(1)} s)`,
    category: src.category === 'original' ? 'original' : src.category,
    ext: 'mp4',
    rightsFrom: src,
    metadata: { source_asset_id: src.id, synthetic: isSynthetic(src) },
  });
  return { outputs: [asset.id], actualUsd: null };
};

export const exportHandler: Handler = async (ctx) => {
  const src = ctx.inputs[0];
  const p = ctx.job.params as unknown as ExportParams;
  const local = await fetchInput(ctx, src);
  let subtitlePath: string | undefined;
  if (p.subtitle_asset_id) {
    const sub = await ctx.loadAsset(p.subtitle_asset_id);
    if (sub.user_id !== ctx.job.user_id || sub.kind !== 'subtitle') throw new JobError('invalid_params', 'Legenda inválida.');
    subtitlePath = await fetchInput(ctx, sub, 'sub');
  }
  const synthetic = isSynthetic(src);
  const out = join(ctx.workDir, 'export.mp4');
  const plan = buildExportArgs(local, out, p, { duration: Number(src.duration_s), hasAudio: !!src.has_audio }, {
    subtitlePath,
    fontFile: p.text_overlay?.text ? ctx.config.fontFile : undefined,
    syntheticNote: synthetic ? SYNTHETIC_NOTE : 'Editado com VideoAI Studio',
  });
  await ctx.progress(0.2, undefined, undefined, 'Convertendo');
  await ffmpeg(plan.args);
  const asset = await saveOutput(ctx, out, {
    name: `${src.name} — ${p.aspect} ${p.resolution}p`,
    category: 'export',
    ext: 'mp4',
    rightsFrom: src,
    metadata: { source_asset_id: src.id, export: p, synthetic },
  });
  return { outputs: [asset.id], actualUsd: null };
};

export const concatHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as ConcatParams;
  const ordered = ctx.job.input_asset_ids.map((id) => ctx.inputs.find((a) => a.id === id)!);
  const locals: string[] = [];
  for (const a of ordered) locals.push(await fetchInput(ctx, a));
  const plan = concatFilter(
    ordered.map((a) => ({ duration: Number(a.duration_s), hasAudio: !!a.has_audio })),
    p.aspect,
    p.resolution,
    p.transition,
    p.transition_seconds ?? 0.5,
  );
  const args = ['-y'];
  for (const l of locals) args.push('-i', l);
  let filter = plan.filter;
  let audioLabel = '[aout]';
  if (p.music_asset_id) {
    const music = await ctx.loadAsset(p.music_asset_id);
    if (music.user_id !== ctx.job.user_id || music.kind !== 'audio') throw new JobError('invalid_params', 'Música inválida.');
    args.push('-stream_loop', '-1', '-i', await fetchInput(ctx, music, 'music'));
    const vol = Math.min(Math.max(p.music_volume ?? 0.3, 0), 1);
    filter += `;[${locals.length}:a]volume=${vol},atrim=0:${plan.duration.toFixed(3)}[bg];[aout][bg]amix=inputs=2:duration=first:dropout_transition=0[amix]`;
    audioLabel = '[amix]';
  }
  const out = join(ctx.workDir, 'sequence.mp4');
  await ctx.progress(0.2, undefined, undefined, 'Montando a sequência');
  await ffmpeg([...args, '-filter_complex', filter, '-map', '[vout]', '-map', audioLabel, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-c:a', 'aac', '-b:a', '160k', '-t', plan.duration.toFixed(3), '-movflags', '+faststart',
    '-metadata', `comment=${isSynthetic(...ordered) ? SYNTHETIC_NOTE : 'Editado com VideoAI Studio'}`, out]);
  const asset = await saveOutput(ctx, out, {
    name: `Sequência (${ordered.length} clipes)`,
    category: 'export',
    ext: 'mp4',
    rightsFrom: ordered.every((a) => a.rights_confirmed_at) ? ordered[0] : undefined,
    metadata: { source_asset_ids: ctx.job.input_asset_ids, concat: p, synthetic: isSynthetic(...ordered) },
  });
  return { outputs: [asset.id], actualUsd: null };
};

export const autocutHandler: Handler = async (ctx) => {
  const src = ctx.inputs[0];
  if (!src.has_audio) throw new JobError('invalid_params', 'O vídeo não tem áudio para identificar pausas.');
  const p = ctx.job.params as AutocutParams;
  const local = await fetchInput(ctx, src);
  const noise = Math.min(Math.max(p.noise_db ?? -35, -70), -10);
  const minSilence = Math.min(Math.max(p.min_silence ?? 0.6, 0.2), 5);
  const { stderr } = await ffmpeg(['-i', local, '-af', `silencedetect=noise=${noise}dB:d=${minSilence}`, '-f', 'null', '-']);
  const segments = speechSegments(stderr, Number(src.duration_s), Math.min(Math.max(p.padding ?? 0.15, 0), 1));
  if (!segments.length) throw new JobError('no_speech', 'Nenhum trecho com fala foi encontrado. Ajuste a sensibilidade.');
  const removed = Number(src.duration_s) - segments.reduce((n, s) => n + s.end - s.start, 0);
  const filterFile = join(ctx.workDir, 'select.txt');
  await writeFile(filterFile, selectSegmentsFilter(segments, true));
  const out = join(ctx.workDir, 'autocut.mp4');
  await ffmpeg(['-y', '-i', local, '-filter_complex_script', filterFile, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  const asset = await saveOutput(ctx, out, {
    name: `${src.name} (sem pausas)`,
    category: 'export',
    ext: 'mp4',
    rightsFrom: src,
    metadata: { source_asset_id: src.id, segments, removed_seconds: Math.round(removed * 10) / 10, synthetic: isSynthetic(src) },
  });
  return { outputs: [asset.id], result: { segments, removed_seconds: removed }, actualUsd: null };
};

/** Vídeo a partir de imagens: movimento de câmera, transições, narração e legenda. */
export const slideshowHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as SlideshowParams;
  const aspect = p.aspect === '16:9' || p.aspect === '1:1' ? p.aspect : '9:16';
  const resolution = p.resolution === 1080 ? 1080 : 720;
  const ordered = ctx.job.input_asset_ids.map((id) => ctx.inputs.find((a) => a.id === id)!).filter(Boolean);
  const images = ordered.filter((a) => a.kind === 'image');
  const audio = ordered.find((a) => a.kind === 'audio') ?? null;
  if (!images.length) throw new JobError('invalid_params', 'Escolha ao menos uma imagem.');
  const td = p.transition === 'none' ? 0 : 0.6;
  const durations = slideDurations(images.length, { audioSeconds: audio?.duration_s ? Number(audio.duration_s) : null, secondsPerImage: p.seconds_per_image, transition: td });
  const plan = slideshowFilter(durations, aspect, resolution, p.motion ?? 'auto', td ? 'fade' : 'none', td || 0.6);

  const args = ['-y'];
  for (const img of images) args.push('-i', await fetchInput(ctx, img));
  let filter = plan.filter;
  let videoLabel = '[vout]';
  if (p.subtitle_asset_id) {
    const sub = await ctx.loadAsset(p.subtitle_asset_id);
    if (sub.user_id !== ctx.job.user_id || sub.kind !== 'subtitle') throw new JobError('invalid_params', 'Legenda inválida.');
    const subPath = await fetchInput(ctx, sub, 'sub');
    filter += `;[vout]subtitles='${escapeFilterPath(subPath)}':force_style='FontSize=16,Outline=2,MarginV=60'[vsub]`;
    videoLabel = '[vsub]';
  }
  if (audio) args.push('-i', await fetchInput(ctx, audio, 'audio'));
  const filterFile = join(ctx.workDir, 'slideshow.txt');
  await writeFile(filterFile, filter);
  const out = join(ctx.workDir, 'slideshow.mp4');
  await ctx.progress(0.2, undefined, undefined, 'Animando as imagens');
  const synthetic = isSynthetic(...ordered);
  const enc = ['-filter_complex_script', filterFile, '-map', videoLabel];
  if (audio) enc.push('-map', `${images.length}:a`, '-c:a', 'aac', '-b:a', '160k');
  else enc.push('-an');
  enc.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', '30', '-t', plan.duration.toFixed(3), '-movflags', '+faststart',
    '-metadata', `comment=${synthetic ? SYNTHETIC_NOTE : 'Criado com VideoAI Studio'}`, out);
  await ffmpeg([...args, ...enc]);
  const asset = await saveOutput(ctx, out, {
    name: `Vídeo animado (${images.length} cenas)`,
    category: 'generated',
    ext: 'mp4',
    metadata: { source_asset_ids: ctx.job.input_asset_ids, slideshow: { ...p, aspect, resolution }, synthetic },
  });
  return { outputs: [asset.id], actualUsd: null };
};
