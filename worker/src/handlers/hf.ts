/**
 * Motor GRÁTIS: GPU gratuita do Hugging Face (Spaces ZeroGPU).
 *  - vídeo com movimento: Wan 2.2 imagem → vídeo (sem imagem, a primeira é criada grátis na Cloudflare)
 *  - troca de personagem / transferência de movimento: Wan 2.2 Animate
 *  - personagem falando: imagem + áudio
 * Sem custo por uso; a cota diária de GPU é pequena (minutos por dia) e a fila é pública.
 * Os Spaces usados ficam em app_settings (hf_space_*) para o administrador trocar quando um sair do ar.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clampPrompt } from '../../../shared/prompt.ts';
import type { TalkParams, TransformParams, VideoParams } from '../../../shared/jobs.ts';
import { prepareClip } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { clampToSlider, findChoice, type FileData, type GradioComponent, type GradioSpace, type SpaceEvent } from '../providers/gradio.ts';
import type { HandlerResult, JobContext } from '../types.ts';
import { characterRefs, withOriginalAudio } from './ai.ts';
import { saveOutput } from './media.ts';

export interface SpaceSetting {
  space: string;
  api: string | null;
}

export const DEFAULT_SPACES: Record<'video' | 'animate' | 'talk', SpaceSetting> = {
  video: { space: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', api: 'generate_video' },
  animate: { space: 'alexnasa/Wan2.2-Animate-ZEROGPU', api: 'animate_scene' },
  talk: { space: 'apexstudio/infinitetalk', api: null },
};

async function spaceSetting(ctx: JobContext, which: keyof typeof DEFAULT_SPACES): Promise<SpaceSetting> {
  const { data } = await ctx.db.from('app_settings').select('value').eq('key', `hf_space_${which}`).maybeSingle();
  const v = (data as { value?: Partial<SpaceSetting> | string } | null)?.value;
  if (typeof v === 'string' && v.includes('/')) return { space: v, api: null };
  if (v && typeof v === 'object' && v.space) return { space: v.space, api: v.api ?? null };
  return DEFAULT_SPACES[which];
}

function openSpace(ctx: JobContext, space: string): GradioSpace {
  if (!ctx.hf) throw new JobError('not_configured', 'O motor grátis (Hugging Face) não está disponível neste servidor.');
  return ctx.hf.open(space);
}

const label = (c: GradioComponent) => String(c.props?.label ?? '').toLowerCase();
const isNumberInput = (c: GradioComponent) => c.type === 'slider' || c.type === 'number';
const DURATION_RE = /duration|seconds|second|dura[cç][aã]o|segundos|length|time/;

/** Converte os eventos da fila em progresso legível. */
function progressReporter(ctx: JobContext, range: [number, number]) {
  let lastRank = -1;
  return async (e: SpaceEvent) => {
    const [from, to] = range;
    if (e.stage === 'queue') {
      if (e.rank === lastRank) return;
      lastRank = e.rank ?? 0;
      const eta = e.eta ? `, cerca de ${Math.max(1, Math.round(e.eta / 60))} min` : '';
      await ctx.progress(from, undefined, undefined, `Na fila da GPU grátis: posição ${lastRank + 1}${eta}`);
    } else if (e.stage === 'running') {
      await ctx.progress(from + (to - from) * 0.1, undefined, undefined, 'Gerando na GPU grátis…');
    } else if (e.fraction != null) {
      await ctx.progress(from + (to - from) * (0.1 + 0.9 * Math.min(1, Math.max(0, e.fraction))));
    }
  };
}

function freeResult(extra?: Record<string, unknown>): HandlerResult {
  return { outputs: [], actualUsd: 0, providerCost: { hf_free: true, ...extra } };
}

// ---------------------------------------------------------------------------
/** Vídeo com movimento grátis (Wan 2.2 imagem → vídeo). */
export async function hfVideo(ctx: JobContext, p: VideoParams): Promise<HandlerResult> {
  const setting = await spaceSetting(ctx, 'video');
  const space = openSpace(ctx, setting.space);
  const promptText = clampPrompt(p.prompt ?? '');
  if (!promptText) throw new JobError('invalid_params', 'Descreva o movimento da cena.');

  // imagem inicial: escolhida, do personagem, ou criada grátis a partir do texto
  const imageLocal = join(ctx.workDir, `inicio-${randomUUID()}.jpg`);
  let fromText = false;
  if (p.image_asset_id) {
    const img = await ctx.loadAsset(p.image_asset_id);
    if (img.user_id !== ctx.job.user_id || img.kind !== 'image') throw new JobError('invalid_params', 'Imagem inicial inválida.');
    await ctx.storage.download(img.path, imageLocal);
  } else if (p.character_id) {
    const { character } = await characterRefs(ctx, p.character_id, 1);
    if (!character.primary_image_id) throw new JobError('invalid_params', 'O personagem ainda não tem imagem principal.');
    const img = await ctx.loadAsset(character.primary_image_id);
    await ctx.storage.download(img.path, imageLocal);
  } else {
    if (!ctx.cloudflare) {
      throw new JobError('invalid_params', 'Para criar vídeo só com texto no motor grátis, configure a Cloudflare (imagens grátis) ou escolha uma imagem inicial.');
    }
    const shape = p.aspect === '16:9' ? 'wide horizontal 16:9 frame' : p.aspect === '1:1' ? 'square frame' : 'tall vertical 9:16 frame';
    await writeFile(imageLocal, await ctx.cloudflare.flux(`${promptText}. Cinematic, detailed, ${shape}.`));
    fromText = true;
    await ctx.progress(0.1, undefined, undefined, 'Imagem inicial criada (grátis)');
  }

  let promptUsed = false;
  const url = await space.predict({
    api: setting.api,
    requiredTypes: ['image'],
    files: { image: imageLocal },
    fill: (c, up) => {
      const l = label(c);
      if (c.type === 'image') return up.image;
      if (c.type === 'textbox' && !/negativ/.test(l) && !promptUsed) {
        promptUsed = true;
        return promptText;
      }
      if (isNumberInput(c) && DURATION_RE.test(l) && !/step|guidance|seed|fps/.test(l)) return clampToSlider(c, p.duration || 5);
      if (c.type === 'checkbox' && /random/.test(l)) return !p.seed;
      if (isNumberInput(c) && /seed/.test(l) && p.seed) return p.seed;
      return undefined;
    },
    onEvent: progressReporter(ctx, [0.15, 0.9]),
    isCanceled: () => ctx.isCancelRequested(),
  });
  const local = join(ctx.workDir, `hf-${randomUUID()}.mp4`);
  await space.download(url, local);
  const asset = await saveOutput(ctx, local, {
    name: p.scene_index != null ? `Cena ${p.scene_index + 1}` : 'Vídeo gerado (grátis)',
    category: 'generated',
    ext: 'mp4',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'hf', space: setting.space, prompt: promptText, scene_index: p.scene_index ?? null, start_image_from_text: fromText },
  });
  return { ...freeResult({ space: setting.space }), outputs: [asset.id] };
}

// ---------------------------------------------------------------------------
const SWAP_RE = /swap|replace|replacement|mix|troca|substitu/i;
const MOVE_RE = /move|animat|pose|retarget|motion|movimento/i;

/** Troca de personagem grátis (Wan 2.2 Animate). */
export async function hfTransform(ctx: JobContext, p: TransformParams): Promise<HandlerResult> {
  if (p.mode !== 'full_body' && p.mode !== 'cinematic') throw new JobError('unsupported_mode', 'Este modo não está disponível no motor grátis.');
  const setting = await spaceSetting(ctx, 'animate');
  const space = openSpace(ctx, setting.space);
  const modeRe = p.mode === 'full_body' ? SWAP_RE : MOVE_RE;
  // confere antes de gastar cota se o Space oferece o modo pedido
  const cfg = await space.config();
  const hasChoice = cfg.components.some((c) => (c.type === 'radio' || c.type === 'dropdown') && findChoice(c, modeRe));
  const anyChoice = cfg.components.some((c) => (c.type === 'radio' || c.type === 'dropdown') && (findChoice(c, SWAP_RE) || findChoice(c, MOVE_RE)));
  if (anyChoice && !hasChoice) {
    throw new JobError('unsupported_mode', p.mode === 'full_body' ? 'O Space grátis configurado não oferece troca de personagem.' : 'O Space grátis configurado não oferece transferência de movimento. Use o Modo C.');
  }

  const src = ctx.inputs[0];
  const { character } = await characterRefs(ctx, p.character_id, 1);
  if (!character.primary_image_id) throw new JobError('invalid_params', 'Escolha uma imagem principal para o personagem antes de transformar vídeos.');
  const charLocal = join(ctx.workDir, 'personagem.jpg');
  await ctx.storage.download((await ctx.loadAsset(character.primary_image_id)).path, charLocal);

  const start = Math.max(0, p.trim_start ?? 0);
  const end = Math.min(Number(src.duration_s), p.trim_end ?? Number(src.duration_s));
  const seconds = end - start;
  const original = join(ctx.workDir, 'source.' + (src.path.split('.').pop() || 'mp4'));
  await ctx.storage.download(src.path, original);
  const clip = join(ctx.workDir, 'clip.mp4');
  // trecho leve (16 quadros/s, lado maior 832 px): envia rápido e gasta menos cota
  await prepareClip(original, clip, start, seconds, false, 16, 832);
  await ctx.progress(0.1, undefined, undefined, 'Trecho preparado');

  const url = await space.predict({
    api: setting.api,
    requiredTypes: ['video', 'image'],
    files: { video: clip, image: charLocal },
    fill: (c, up) => {
      const l = label(c);
      if (c.type === 'video') return { video: up.video as FileData, subtitles: null };
      if (c.type === 'image') return up.image;
      if (isNumberInput(c) && DURATION_RE.test(l)) return clampToSlider(c, Math.max(1, Math.floor(seconds)));
      if (c.type === 'radio' || c.type === 'dropdown') return findChoice(c, modeRe) ?? findChoice(c, /low|480|baixa|fast/i) ?? undefined;
      return undefined;
    },
    onEvent: progressReporter(ctx, [0.15, 0.9]),
    isCanceled: () => ctx.isCancelRequested(),
  });
  const local = join(ctx.workDir, `hf-${randomUUID()}.mp4`);
  await space.download(url, local);
  const finalLocal = await withOriginalAudio(ctx, src, local, start, end);
  const asset = await saveOutput(ctx, finalLocal, {
    name: `${src.name} → ${character.name}`,
    category: 'transformed',
    ext: 'mp4',
    characterId: character.id,
    rightsFrom: src,
    metadata: { synthetic: true, provider: 'hf', space: setting.space, mode: p.mode, source_asset_id: src.id, trim: [start, end] },
  });
  return { ...freeResult({ space: setting.space }), outputs: [asset.id] };
}

// ---------------------------------------------------------------------------
/** Personagem falando grátis (imagem + áudio), experimental. */
export async function hfTalk(ctx: JobContext): Promise<HandlerResult> {
  const p = ctx.job.params as TalkParams;
  const image = ctx.inputs.find((a) => a.kind === 'image');
  const audio = ctx.inputs.find((a) => a.kind === 'audio');
  if (!image || !audio) throw new JobError('invalid_params', 'Escolha uma imagem e um áudio.');
  const setting = await spaceSetting(ctx, 'talk');
  const space = openSpace(ctx, setting.space);
  const imageLocal = join(ctx.workDir, 'rosto.' + (image.path.split('.').pop() || 'jpg'));
  const audioLocal = join(ctx.workDir, 'fala.' + (audio.path.split('.').pop() || 'mp3'));
  await ctx.storage.download(image.path, imageLocal);
  await ctx.storage.download(audio.path, audioLocal);
  const prompt = clampPrompt(p.prompt ?? '') || 'A person talking naturally to the camera, natural head movement and expressions.';
  let promptUsed = false;
  const url = await space.predict({
    api: setting.api,
    requiredTypes: ['image', 'audio'],
    files: { image: imageLocal, audio: audioLocal },
    fill: (c, up) => {
      if (c.type === 'image') return up.image;
      if (c.type === 'audio') return up.audio;
      if (c.type === 'textbox' && !/negativ/.test(label(c)) && !promptUsed) {
        promptUsed = true;
        return prompt;
      }
      return undefined;
    },
    onEvent: progressReporter(ctx, [0.1, 0.9]),
    isCanceled: () => ctx.isCancelRequested(),
  });
  const local = join(ctx.workDir, `hf-${randomUUID()}.mp4`);
  await space.download(url, local);
  const asset = await saveOutput(ctx, local, {
    name: `Falando — ${image.name}`.slice(0, 120),
    category: 'generated',
    ext: 'mp4',
    characterId: image.character_id,
    metadata: { synthetic: true, provider: 'hf', space: setting.space, source_asset_ids: [image.id, audio.id] },
  });
  return { ...freeResult({ space: setting.space }), outputs: [asset.id] };
}
