/**
 * Vídeo automático, só com opções gratuitas:
 *   tema (Gemini) ou roteiro → cenas → imagens (Cloudflare) → narração por cena
 *   (Piper) → vídeo animado com legenda e música (FFmpeg).
 * Cada imagem dura exatamente a narração da sua cena. O progresso (roteiro e
 * imagens já geradas) fica salvo: se a tarefa for retomada, nada é refeito.
 * Ideia de fluxo inspirada no Pixelle-Video (AIDC-AI, Apache-2.0).
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { CAPTION_STYLES, escapeFilterPath, slideDurations, slideshowFilter, syncedSlideDurations } from '../../../shared/ffmpeg.ts';
import type { AutoVideoParams } from '../../../shared/jobs.ts';
import { characterDescriptor, splitNarration, styledImagePrompt } from '../../../shared/prompt.ts';
import { estimateCues, toSrt, type Cue } from '../../../shared/srt.ts';
import { ffmpeg, probe } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { piperSpeak } from '../providers/local.ts';
import { saveOutput, SYNTHETIC_NOTE } from './media.ts';
import { TEXT_SYSTEM } from './ai.ts';
import type { CharacterRow, Handler, JobContext } from '../types.ts';

const PlanSchema = z.object({
  title: z.string(),
  scenes: z.array(z.object({ narration: z.string(), image_prompt_en: z.string() })),
});
const PromptsSchema = z.object({ prompts: z.array(z.string()) });
type Plan = z.infer<typeof PlanSchema>;

const TD = 0.6;
const MAX_SCENES = 20;

async function makePlan(ctx: JobContext, p: AutoVideoParams, character: CharacterRow | null): Promise<Plan> {
  const who = character ? `\nPersonagem principal: ${character.name} (${characterDescriptor(character)}). Ele(a) aparece nas cenas.` : '';
  if (p.mode === 'topic') {
    if (!ctx.gemini) throw new JobError('not_configured', 'O modo "a partir de um tema" usa o Gemini (grátis). Configure a chave em Administração → Integrações, ou use o modo "roteiro pronto".');
    const n = Math.min(Math.max(Math.round(p.scenes ?? 6), 3), 12);
    const { data } = await ctx.gemini.generate(
      TEXT_SYSTEM,
      `Crie o roteiro de um vídeo curto para redes sociais sobre: "${(p.topic ?? '').slice(0, 500)}".
Exatamente ${n} cenas. A primeira cena é o gancho. Para cada cena:
- narration: o que será falado, em português do Brasil, 1 ou 2 frases curtas (10 a 25 palavras), linguagem falada;
- image_prompt_en: descrição visual concreta da imagem da cena, em inglês, sem texto escrito na imagem.
title: título curto do vídeo.${who}`,
      PlanSchema,
    );
    return data;
  }
  const narrations = splitNarration(p.script ?? '', p.split ?? 'paragraph').slice(0, MAX_SCENES);
  if (!narrations.length) throw new JobError('invalid_params', 'Escreva o roteiro.');
  let prompts = narrations;
  // no roteiro pronto, o Gemini só melhora as descrições das imagens: se estiver congestionado, segue sem ele
  if (ctx.gemini) {
    const res = await ctx.gemini.generate(
      TEXT_SYSTEM,
      `Para cada trecho de narração abaixo, escreva uma descrição visual concreta em inglês (image_prompt) para ilustrá-lo, sem texto escrito na imagem. Devolva exatamente ${narrations.length} itens em "prompts", na mesma ordem.${who}\n${JSON.stringify(narrations)}`,
      PromptsSchema,
    ).catch((e: Error) => {
      if (e instanceof JobError && e.code === 'provider_auth') throw e;
      return null;
    });
    if (res && res.data.prompts.length === narrations.length) prompts = res.data.prompts;
  }
  return { title: narrations[0].slice(0, 60), scenes: narrations.map((narration, i) => ({ narration, image_prompt_en: prompts[i] })) };
}

export const autoVideoHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as AutoVideoParams;
  if (!ctx.cloudflare) throw new JobError('not_configured', 'As imagens grátis usam a Cloudflare: configure a chave em Administração → Integrações.');
  const aspect = p.aspect === '16:9' || p.aspect === '1:1' ? p.aspect : '9:16';
  const state = ctx.job.state as { plan?: Plan; images?: string[] };
  let character: CharacterRow | null = null;
  if (p.character_id) {
    character = await ctx.loadCharacter(p.character_id);
    if (character.user_id !== ctx.job.user_id) throw new JobError('forbidden', 'Personagem inválido.');
  }

  // 1) roteiro
  let plan = state.plan;
  if (!plan) {
    await ctx.progress(0.03, undefined, undefined, 'Escrevendo o roteiro');
    plan = await makePlan(ctx, p, character);
    plan.scenes = plan.scenes.filter((s) => s.narration.trim()).slice(0, MAX_SCENES);
    if (!plan.scenes.length) throw new JobError('invalid_output', 'O roteiro veio vazio. Tente outro tema.');
    await ctx.progress(0.1, { plan }, undefined, `Roteiro pronto: ${plan.scenes.length} cenas`);
  }
  const n = plan.scenes.length;

  // 2) imagens (as já geradas não são refeitas, para poupar a cota grátis)
  const images = [...(state.images ?? [])];
  const localImages: string[] = [];
  const orientation = aspect === '9:16' ? 'vertical portrait composition, subject centered' : aspect === '16:9' ? 'wide horizontal composition' : 'square composition';
  for (let i = 0; i < n; i++) {
    const local = join(ctx.workDir, `cena${i}.jpg`);
    if (images[i]) {
      const a = await ctx.loadAsset(images[i]);
      await ctx.storage.download(a.path, local);
    } else {
      const prompt = styledImagePrompt(`${plan.scenes[i].image_prompt_en}, ${orientation}`, p.style, character ?? undefined);
      await writeFile(local, await ctx.cloudflare.flux(prompt));
      const asset = await saveOutput(ctx, local, {
        name: `${plan.title.slice(0, 40)} — cena ${i + 1}`,
        category: 'generated',
        ext: 'jpg',
        characterId: character?.id ?? null,
        metadata: { synthetic: true, provider: 'cloudflare', model: 'flux-1-schnell', prompt, scene: i },
      });
      images[i] = asset.id;
      await ctx.progress(0.1 + (0.5 * (i + 1)) / n, { images }, undefined, `Imagem ${i + 1} de ${n}`);
    }
    localImages.push(local);
  }

  // 3) narração por cena (cada imagem dura a fala da sua cena)
  const audios: string[] = [];
  const audioSeconds: number[] = [];
  if (p.voice) {
    for (let i = 0; i < n; i++) {
      const wav = join(ctx.workDir, `fala${i}.wav`);
      await piperSpeak(ctx.config, p.voice, plan.scenes[i].narration, wav, p.speed ?? 1);
      const d = (await probe(wav)).duration ?? 0;
      if (d <= 0) throw new JobError('tts_failed', `A narração da cena ${i + 1} ficou vazia.`);
      audios.push(wav);
      audioSeconds.push(d);
      await ctx.progress(0.6 + (0.15 * (i + 1)) / n, undefined, undefined, `Narração ${i + 1} de ${n}`);
    }
  }
  const durations = audios.length ? syncedSlideDurations(audioSeconds, TD) : slideDurations(n, { secondsPerImage: p.seconds_per_scene ?? 4, transition: TD });
  const starts: number[] = [];
  durations.reduce((t, d) => (starts.push(t), t + d - TD), 0);
  const sceneLen = durations.map((d, i) => (i < n - 1 ? d - TD : d));

  // 4) legenda: texto de cada cena dividido dentro do tempo da cena
  const cues: Cue[] = plan.scenes.flatMap((s, i) => estimateCues(s.narration, sceneLen[i]).map((c) => ({ ...c, start: c.start + starts[i], end: c.end + starts[i] })));
  const srtLocal = join(ctx.workDir, 'legenda.srt');
  await writeFile(srtLocal, toSrt(cues), 'utf8');

  // 5) faixa de narração única
  let narration: string | null = null;
  if (audios.length) {
    narration = join(ctx.workDir, 'narracao.wav');
    const args = ['-y'];
    for (const a of audios) args.push('-i', a);
    args.push('-filter_complex', `${audios.map((_, i) => `[${i}:a]`).join('')}concat=n=${audios.length}:v=0:a=1[a]`, '-map', '[a]', narration);
    await ffmpeg(args);
  }

  // 6) vídeo
  await ctx.progress(0.8, undefined, undefined, 'Montando o vídeo');
  const plan2 = slideshowFilter(durations, aspect, 720, p.motion ?? 'auto', 'fade', TD);
  const args = ['-y'];
  for (const img of localImages) args.push('-i', img);
  let filter = plan2.filter;
  let vLabel = '[vout]';
  const caption = p.caption ?? 'classic';
  if (caption !== 'none') {
    filter += `;[vout]subtitles='${escapeFilterPath(srtLocal)}':force_style='${CAPTION_STYLES[caption]}'[vsub]`;
    vLabel = '[vsub]';
  }
  let aLabel: string | null = null;
  let idx = n;
  if (narration) {
    args.push('-i', narration);
    aLabel = `${idx}:a`;
    idx++;
  }
  if (p.music_asset_id) {
    const music = await ctx.loadAsset(p.music_asset_id);
    if (music.user_id !== ctx.job.user_id || music.kind !== 'audio') throw new JobError('invalid_params', 'Música inválida.');
    const musicLocal = join(ctx.workDir, `musica.${music.path.split('.').pop() || 'mp3'}`);
    await ctx.storage.download(music.path, musicLocal);
    args.push('-stream_loop', '-1', '-i', musicLocal);
    const vol = Math.min(Math.max(p.music_volume ?? (narration ? 0.15 : 0.6), 0), 1);
    filter += narration
      ? `;[${idx}:a]volume=${vol}[bg];[${n}:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
      : `;[${idx}:a]volume=${vol},atrim=0:${plan2.duration.toFixed(3)}[aout]`;
    aLabel = '[aout]';
  }
  const filterFile = join(ctx.workDir, 'filtro.txt');
  await writeFile(filterFile, filter);
  const out = join(ctx.workDir, `video-${randomUUID()}.mp4`);
  const enc = ['-filter_complex_script', filterFile, '-map', vLabel];
  if (aLabel) enc.push('-map', aLabel, '-c:a', 'aac', '-b:a', '160k');
  else enc.push('-an');
  enc.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', '30', '-t', plan2.duration.toFixed(3), '-movflags', '+faststart', '-metadata', `comment=${SYNTHETIC_NOTE}`, out);
  await ffmpeg([...args, ...enc]);

  const video = await saveOutput(ctx, out, {
    name: plan.title.slice(0, 100) || 'Vídeo automático',
    category: 'generated',
    ext: 'mp4',
    characterId: character?.id ?? null,
    metadata: { synthetic: true, pipeline: 'auto_video', title: plan.title, scenes: plan.scenes, style: p.style ?? null, image_asset_ids: images },
  });
  const srtPath = `${ctx.job.user_id}/generated/${randomUUID()}.srt`;
  const srtSize = await ctx.storage.upload(srtLocal, srtPath, 'application/x-subrip');
  const sub = await ctx.createAsset({
    kind: 'subtitle', category: 'generated', name: `Legenda — ${plan.title.slice(0, 60)}`, path: srtPath, mime: 'application/x-subrip',
    size_bytes: srtSize, duration_s: plan2.duration, probe_status: 'ok', metadata: { source_asset_id: video.id, estimated: true },
  });
  return { outputs: [video.id, sub.id], result: { title: plan.title, scenes: plan.scenes, duration: plan2.duration }, actualUsd: null };
};
