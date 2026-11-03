/** Tarefas de IA (Runway e Claude). */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type RunwayML from '@runwayml/sdk';
import { characterDescriptor, characterImagePrompt, clampPrompt } from '../../../shared/prompt.ts';
import { IMAGE_RATIOS, VIDEO_MODELS, VIDEO_RATIOS, ratioFor } from '../../../shared/ratios.ts';
import { estimateCues, toSrt } from '../../../shared/srt.ts';
import { isVoicePreset } from '../../../shared/voices.ts';
import type { Aspect, ImageParams, TextParams, TransformParams, TtsParams, VideoParams } from '../../../shared/jobs.ts';
import { ffmpeg, frameAt, prepareClip } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import { downloadUrl, extFromUrl } from '../storage.ts';
import { spentCredits } from '../providers/runway.ts';
import { ScenePromptSchema, SocialPackSchema, SplitScriptSchema } from '../providers/anthropic.ts';
import { saveOutput } from './media.ts';
import type { AssetRow, CharacterRow, Handler, JobContext } from '../types.ts';

function runwayOf(ctx: JobContext) {
  if (!ctx.runway) throw new JobError('not_configured', 'A integração com a Runway não está configurada neste servidor.');
  return ctx.runway;
}

function assertAspect(a: unknown): Aspect {
  if (a === '9:16' || a === '16:9' || a === '1:1') return a;
  throw new JobError('invalid_params', 'Proporção inválida.');
}

interface CharacterRefs {
  character: CharacterRow;
  primaryUrl: string | null;
  refs: { uri: string; tag: string }[];
}

async function characterRefs(ctx: JobContext, characterId: string, max = 3): Promise<CharacterRefs> {
  const character = await ctx.loadCharacter(characterId);
  if (character.user_id !== ctx.job.user_id) throw new JobError('forbidden', 'Personagem inválido.');
  const { data } = await ctx.db
    .from('assets')
    .select('id,path')
    .eq('character_id', characterId)
    .eq('user_id', ctx.job.user_id)
    .eq('kind', 'image')
    .eq('probe_status', 'ok')
    .order('created_at', { ascending: false })
    .limit(10);
  const images = (data ?? []) as Pick<AssetRow, 'id' | 'path'>[];
  const primary = images.find((i) => i.id === character.primary_image_id) ?? null;
  const ordered = [...(primary ? [primary] : []), ...images.filter((i) => i.id !== primary?.id)].slice(0, max);
  const tags = ['char', 'charB', 'charC'];
  const refs = await Promise.all(ordered.map(async (img, i) => ({ uri: await ctx.storage.signedUrl(img.path), tag: tags[i] })));
  return { character, primaryUrl: primary ? refs[0].uri : null, refs };
}

async function storeFromUrl(ctx: JobContext, url: string, fallbackExt: string): Promise<string> {
  const local = join(ctx.workDir, `${randomUUID()}.${extFromUrl(url, fallbackExt)}`);
  await downloadUrl(url, local);
  return local;
}

function costOf(ctx: JobContext) {
  const r = runwayOf(ctx);
  return { actualUsd: r.usd(ctx), providerCost: { runway_credits: spentCredits(ctx.job.state) } };
}

// ---------------------------------------------------------------------------
export const imageHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as ImageParams;
  if (p.engine === 'cloudflare') return cloudflareImage(ctx, p);
  const runway = runwayOf(ctx);
  const aspect = assertAspect(p.aspect);
  const model = p.model === 'gen4_image_turbo' ? 'gen4_image_turbo' : 'gen4_image';
  let promptText = clampPrompt(p.prompt ?? '');
  let refs: { uri: string; tag: string }[] = [];
  let character: CharacterRow | null = null;
  if (p.character_id) {
    const cr = await characterRefs(ctx, p.character_id);
    character = cr.character;
    refs = cr.refs;
    promptText = characterImagePrompt(cr.character, p.view ?? 'custom', p.prompt ?? '', refs.length > 0);
  }
  if (!promptText) throw new JobError('invalid_params', 'Descreva a imagem.');
  if (model === 'gen4_image_turbo' && !refs.length) {
    throw new JobError('invalid_params', 'O modelo Turbo exige ao menos uma imagem de referência do personagem.');
  }
  const ratio = IMAGE_RATIOS[aspect] as '1080:1920';
  const [url] = await runway.runTask(
    ctx,
    'image',
    () =>
      runway.client.textToImage.create(
        (model === 'gen4_image_turbo'
          ? { model, promptText, ratio, referenceImages: refs, seed: p.seed }
          : { model, promptText, ratio, referenceImages: refs.length ? refs : undefined, seed: p.seed }) as RunwayML.TextToImageCreateParams,
      ),
    { label: 'Imagem', range: [0.1, 0.9] },
  );
  const local = await storeFromUrl(ctx, url, 'png');
  const asset = await saveOutput(ctx, local, {
    name: character ? `${character.name} — ${p.view ?? 'imagem'}` : 'Imagem gerada',
    category: character ? 'reference' : 'generated',
    ext: local.split('.').pop() || 'png',
    characterId: character?.id,
    metadata: { synthetic: true, provider: 'runway', model, prompt: promptText, view: p.view ?? null },
  });
  if (character && !character.primary_image_id) {
    await ctx.db.from('characters').update({ primary_image_id: asset.id }).eq('id', character.id);
  }
  return { outputs: [asset.id], ...costOf(ctx) };
};

/** Imagem pela cota grátis da Cloudflare (sem imagem de referência: só a descrição do personagem). */
async function cloudflareImage(ctx: JobContext, p: ImageParams) {
  if (!ctx.cloudflare) throw new JobError('not_configured', 'A integração com a Cloudflare não está configurada neste servidor.');
  let character: CharacterRow | null = null;
  let prompt = clampPrompt(p.prompt ?? '');
  if (p.character_id) {
    character = await ctx.loadCharacter(p.character_id);
    if (character.user_id !== ctx.job.user_id) throw new JobError('forbidden', 'Personagem inválido.');
    prompt = characterImagePrompt(character, p.view ?? 'custom', p.prompt ?? '', false);
  }
  if (!prompt) throw new JobError('invalid_params', 'Descreva a imagem.');
  const orientation = p.aspect === '9:16' ? 'vertical portrait composition' : p.aspect === '16:9' ? 'wide horizontal composition' : 'square composition';
  await ctx.progress(0.2, undefined, undefined, 'Gerando imagem (Cloudflare)');
  const bytes = await ctx.cloudflare.flux(`${prompt}. ${orientation}, subject centered`);
  const local = join(ctx.workDir, `${randomUUID()}.jpg`);
  await writeFile(local, bytes);
  const asset = await saveOutput(ctx, local, {
    name: character ? `${character.name} — ${p.view ?? 'imagem'}` : 'Imagem gerada',
    category: character ? 'reference' : 'generated',
    ext: 'jpg',
    characterId: character?.id,
    metadata: { synthetic: true, provider: 'cloudflare', model: 'flux-1-schnell', prompt, view: p.view ?? null },
  });
  if (character && !character.primary_image_id) {
    await ctx.db.from('characters').update({ primary_image_id: asset.id }).eq('id', character.id);
  }
  return { outputs: [asset.id], actualUsd: null };
}

// ---------------------------------------------------------------------------
export const videoHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as VideoParams;
  if (p.engine === 'fal' || p.model === 'fal-wan2.2') return falVideo(ctx, p);
  const runway = runwayOf(ctx);
  const aspect = assertAspect(p.aspect);
  const spec = VIDEO_MODELS.find((m) => m.id === p.model);
  if (!spec) throw new JobError('invalid_params', 'Modelo de vídeo indisponível.');
  if (!(spec.durations as readonly number[]).includes(p.duration)) {
    throw new JobError('invalid_params', `${spec.label} aceita durações de ${spec.durations.join(', ')} s.`);
  }
  const promptText = clampPrompt(p.prompt ?? '');
  if (!promptText) throw new JobError('invalid_params', 'Descreva a cena.');

  let imageUrl: string | null = null;
  if (p.image_asset_id) {
    const img = await ctx.loadAsset(p.image_asset_id);
    if (img.user_id !== ctx.job.user_id || img.kind !== 'image') throw new JobError('invalid_params', 'Imagem inicial inválida.');
    imageUrl = await ctx.storage.signedUrl(img.path);
  } else if (p.use_character_image && p.character_id) {
    imageUrl = (await characterRefs(ctx, p.character_id, 1)).primaryUrl;
    if (!imageUrl) throw new JobError('invalid_params', 'O personagem ainda não tem imagem principal.');
  }
  if (spec.needsImage && !imageUrl) throw new JobError('invalid_params', `${spec.label} exige uma imagem inicial.`);
  const ratio = ratioFor(p.model, aspect, !imageUrl);
  if (!ratio) throw new JobError('invalid_params', `${spec.label} não gera vídeos ${aspect}${imageUrl ? '' : ' a partir de texto'}.`);

  const [url] = await runway.runTask(
    ctx,
    'video',
    () =>
      imageUrl
        ? runway.client.imageToVideo.create({ model: p.model, promptImage: imageUrl, promptText, ratio, duration: p.duration, seed: p.seed } as RunwayML.ImageToVideoCreateParams)
        : runway.client.textToVideo.create({ model: p.model, promptText, ratio, duration: p.duration, seed: p.seed } as RunwayML.TextToVideoCreateParams),
    { label: 'Vídeo', range: [0.05, 0.9] },
  );
  const local = await storeFromUrl(ctx, url, 'mp4');
  const asset = await saveOutput(ctx, local, {
    name: p.scene_index != null ? `Cena ${p.scene_index + 1}` : 'Vídeo gerado',
    category: 'generated',
    ext: 'mp4',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'runway', model: p.model, prompt: promptText, scene_index: p.scene_index ?? null, from_image: !!imageUrl },
  });
  return { outputs: [asset.id], ...costOf(ctx) };
};

// ---------------------------------------------------------------------------
const OUTFIT_TEXT = {
  original: 'keep the original clothing from the video',
  character: "dressed in @char's outfit",
  new: '',
};

export const transformHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as TransformParams;
  if (p.engine === 'fal') return falTransform(ctx, p);
  const runway = runwayOf(ctx);
  if (!['full_body', 'appearance', 'stylized', 'cinematic'].includes(p.mode)) {
    throw new JobError('unsupported_mode', 'Este modo ainda não tem integração capaz de executá-lo.');
  }
  const src = ctx.inputs[0];
  const { character, primaryUrl } = await characterRefs(ctx, p.character_id, 1);
  if (!primaryUrl) throw new JobError('invalid_params', 'Escolha uma imagem principal para o personagem antes de transformar vídeos.');
  const aspect = assertAspect(src.metadata?.aspect ?? '9:16');
  const start = Math.max(0, p.trim_start ?? 0);
  const end = Math.min(Number(src.duration_s), p.trim_end ?? Number(src.duration_s));
  const state = ctx.job.state as Record<string, string | undefined>;

  // 1) trecho preparado (720p, H.264) — salvo para retomada
  let clipPath = state.clip_path;
  if (!clipPath) {
    const local = join(ctx.workDir, 'source.' + (src.path.split('.').pop() || 'mp4'));
    await ctx.storage.download(src.path, local);
    const clip = join(ctx.workDir, 'clip.mp4');
    await prepareClip(local, clip, start, end - start, !!src.has_audio);
    clipPath = `${ctx.job.user_id}/temp/${ctx.job.id}-clip.mp4`;
    await ctx.storage.upload(clip, clipPath, 'video/mp4');
    await ctx.createAsset({ kind: 'video', category: 'temp', name: 'Trecho preparado', path: clipPath, mime: 'video/mp4', probe_status: 'ok', duration_s: end - start, metadata: { source_asset_id: src.id } });
    await ctx.progress(0.08, { clip_path: clipPath }, undefined, 'Trecho preparado');
  }
  const clipUrl = await ctx.storage.signedUrl(clipPath, 4 * 3600);
  const extra = clampPrompt(p.scene_prompt ?? '', 600);
  const descriptor = clampPrompt(characterDescriptor(character), 300);
  let outputs: string[];

  if (p.mode === 'full_body' || p.mode === 'cinematic') {
    let characterUri = primaryUrl;
    if (p.mode === 'cinematic') {
      if (!extra) throw new JobError('invalid_params', 'Descreva o cenário da nova cena.');
      const [img] = await runway.runTask(
        ctx,
        'scene_image',
        () =>
          runway.client.textToImage.create({
            model: 'gen4_image',
            promptText: clampPrompt(`@char standing in this scene: ${extra}. Full body visible, facing the camera, cinematic lighting, same face, hair and outfit as the reference.`),
            ratio: IMAGE_RATIOS[aspect] as '1080:1920',
            referenceImages: [{ uri: primaryUrl, tag: 'char' }],
            seed: p.seed,
          }),
        { label: 'Cena do personagem', range: [0.1, 0.35] },
      );
      characterUri = img;
    }
    const ratio = VIDEO_RATIOS.act_two[aspect] as '720:1280';
    outputs = await runway.runTask(
      ctx,
      'act_two',
      () =>
        runway.client.characterPerformance.create({
          model: 'act_two',
          character: { type: 'image', uri: characterUri },
          reference: { type: 'video', uri: clipUrl },
          bodyControl: p.body_control ?? true,
          expressionIntensity: Math.min(Math.max(Math.round(p.expression_intensity ?? 3), 1), 5),
          ratio,
          seed: p.seed,
        }),
      { label: 'Transferência de atuação', range: [p.mode === 'cinematic' ? 0.35 : 0.1, 0.9] },
    );
  } else {
    let keyframeUrl: string | undefined;
    if (p.use_character_keyframe ?? true) {
      let framePath = state.frame_path;
      if (!framePath) {
        const clipLocal = join(ctx.workDir, 'clip-dl.mp4');
        await ctx.storage.download(clipPath, clipLocal);
        const frame = join(ctx.workDir, 'frame0.jpg');
        await frameAt(clipLocal, frame, 0, 1280);
        framePath = `${ctx.job.user_id}/temp/${ctx.job.id}-frame0.jpg`;
        await ctx.storage.upload(frame, framePath, 'image/jpeg');
        await ctx.createAsset({ kind: 'image', category: 'temp', name: 'Quadro inicial', path: framePath, mime: 'image/jpeg', probe_status: 'ok', metadata: { source_asset_id: src.id } });
        await ctx.progress(0.1, { frame_path: framePath });
      }
      const frameUrl = await ctx.storage.signedUrl(framePath, 4 * 3600);
      const outfit = p.outfit === 'new' ? `wearing ${clampPrompt(p.new_outfit ?? '', 200)}` : OUTFIT_TEXT[p.outfit ?? 'character'];
      const look =
        p.mode === 'stylized'
          ? `@frame restyled so the person becomes @char (${descriptor}), ${outfit}`
          : `@frame with the person's appearance changed to match @char, ${outfit}`;
      const [kf] = await runway.runTask(
        ctx,
        'keyframe',
        () =>
          runway.client.textToImage.create({
            model: 'gen4_image',
            promptText: clampPrompt(`${look}. Keep exactly the same pose, body position, framing, background and lighting as @frame. ${extra}`),
            ratio: IMAGE_RATIOS[aspect] as '1080:1920',
            referenceImages: [
              { uri: frameUrl, tag: 'frame' },
              { uri: primaryUrl, tag: 'char' },
            ],
            seed: p.seed,
          }),
        { label: 'Quadro-guia', range: [0.12, 0.35] },
      );
      keyframeUrl = kf;
    }
    const intensity = p.intensity === 'subtle' ? 'Subtle change.' : p.intensity === 'strong' ? 'Strong, complete transformation.' : '';
    const promptText = clampPrompt(
      p.mode === 'stylized'
        ? `Transform the person into this character: ${descriptor}. ${extra} Keep the original motion, timing and camera. ${intensity}`
        : `Change the person's appearance to: ${descriptor}. ${p.outfit === 'original' ? 'Keep the original clothing.' : ''} ${extra} Keep the original action, motion and camera. ${intensity}`,
    );
    outputs = await runway.runTask(
      ctx,
      'aleph',
      () =>
        runway.client.videoToVideo.create({
          model: 'aleph2',
          videoUri: clipUrl,
          promptText,
          keyframes: keyframeUrl ? [{ seconds: 0, uri: keyframeUrl }] : undefined,
          seed: p.seed,
        }),
      { label: 'Transformação do vídeo', range: [keyframeUrl ? 0.35 : 0.1, 0.9] },
    );
  }

  const local = await storeFromUrl(ctx, outputs[0], 'mp4');
  const asset = await saveOutput(ctx, local, {
    name: `${src.name} → ${character.name}`,
    category: 'transformed',
    ext: 'mp4',
    characterId: character.id,
    rightsFrom: src,
    metadata: { synthetic: true, provider: 'runway', mode: p.mode, source_asset_id: src.id, trim: [start, end] },
  });
  return { outputs: [asset.id], ...costOf(ctx) };
};

// ---------------------------------------------------------------------------
// fal.ai
// ---------------------------------------------------------------------------
function falOf(ctx: JobContext) {
  if (!ctx.fal) throw new JobError('not_configured', 'A integração com a fal.ai não está configurada neste servidor.');
  return ctx.fal;
}

/** A fal não informa o custo na resposta: registra o valor da tabela (o que foi reservado). */
function falCost(ctx: JobContext) {
  const usd = Math.round(((ctx.job.estimated_credits * ctx.settings.creditValueUsd) / (ctx.settings.markup || 1)) * 10_000) / 10_000;
  return { actualUsd: usd, providerCost: { fal_estimated_usd: usd } };
}

function falRes(r: unknown): '480p' | '580p' | '720p' {
  return r === '720p' || r === '580p' ? r : '480p';
}

/** Vídeo com movimento a partir de imagem (Wan 2.2 Turbo). */
async function falVideo(ctx: JobContext, p: VideoParams) {
  const fal = falOf(ctx);
  const aspect = assertAspect(p.aspect);
  const promptText = clampPrompt(p.prompt ?? '');
  if (!promptText) throw new JobError('invalid_params', 'Descreva o movimento da cena.');
  let imageUrl: string | null = null;
  if (p.image_asset_id) {
    const img = await ctx.loadAsset(p.image_asset_id);
    if (img.user_id !== ctx.job.user_id || img.kind !== 'image') throw new JobError('invalid_params', 'Imagem inicial inválida.');
    imageUrl = await ctx.storage.signedUrl(img.path, 4 * 3600);
  } else if (p.character_id) {
    imageUrl = (await characterRefs(ctx, p.character_id, 1)).primaryUrl;
  }
  if (!imageUrl) throw new JobError('invalid_params', 'O Wan 2.2 precisa de uma imagem inicial: escolha um personagem com imagem principal ou uma imagem.');
  const url = await fal.run(ctx, 'video', 'fal-ai/wan/v2.2-a14b/image-to-video/turbo', {
    image_url: imageUrl,
    prompt: promptText,
    resolution: falRes(p.resolution) === '720p' ? '720p' : '480p',
    aspect_ratio: aspect,
    ...(p.seed ? { seed: p.seed } : {}),
  }, { label: 'Vídeo (Wan 2.2)', range: [0.05, 0.9] });
  const local = await storeFromUrl(ctx, url, 'mp4');
  const asset = await saveOutput(ctx, local, {
    name: p.scene_index != null ? `Cena ${p.scene_index + 1}` : 'Vídeo gerado',
    category: 'generated',
    ext: 'mp4',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'fal', model: 'wan-2.2-a14b-i2v-turbo', prompt: promptText, scene_index: p.scene_index ?? null },
  });
  return { outputs: [asset.id], ...falCost(ctx) };
}

/** Troca de personagem (Wan 2.2 Animate): replace = mesmo cenário; move = cenário do personagem. */
async function falTransform(ctx: JobContext, p: TransformParams) {
  const fal = falOf(ctx);
  if (p.mode !== 'full_body' && p.mode !== 'cinematic') throw new JobError('unsupported_mode', 'Este modo não está disponível na fal.ai.');
  const src = ctx.inputs[0];
  const { character, primaryUrl } = await characterRefs(ctx, p.character_id, 1);
  if (!primaryUrl) throw new JobError('invalid_params', 'Escolha uma imagem principal para o personagem antes de transformar vídeos.');
  const start = Math.max(0, p.trim_start ?? 0);
  const end = Math.min(Number(src.duration_s), p.trim_end ?? Number(src.duration_s));
  const state = ctx.job.state as Record<string, string | undefined>;
  // trecho a 16 quadros/s: a fal cobra por "segundo" de 16 quadros, então não paga a mais por vídeos de 30/60 fps
  let clipPath = state.clip_path;
  if (!clipPath) {
    const local = join(ctx.workDir, 'source.' + (src.path.split('.').pop() || 'mp4'));
    await ctx.storage.download(src.path, local);
    const clip = join(ctx.workDir, 'clip.mp4');
    await prepareClip(local, clip, start, end - start, !!src.has_audio, 16);
    clipPath = `${ctx.job.user_id}/temp/${ctx.job.id}-clip.mp4`;
    await ctx.storage.upload(clip, clipPath, 'video/mp4');
    await ctx.createAsset({ kind: 'video', category: 'temp', name: 'Trecho preparado', path: clipPath, mime: 'video/mp4', probe_status: 'ok', duration_s: end - start, metadata: { source_asset_id: src.id } });
    await ctx.progress(0.08, { clip_path: clipPath }, undefined, 'Trecho preparado');
  }
  const clipUrl = await ctx.storage.signedUrl(clipPath, 4 * 3600);
  const endpoint = p.mode === 'full_body' ? 'fal-ai/wan/v2.2-14b/animate/replace' : 'fal-ai/wan/v2.2-14b/animate/move';
  const url = await fal.run(ctx, 'animate', endpoint, {
    video_url: clipUrl,
    image_url: primaryUrl,
    resolution: falRes(p.resolution),
    ...(p.seed ? { seed: p.seed } : {}),
  }, { label: p.mode === 'full_body' ? 'Troca de personagem' : 'Transferência de movimento', range: [0.1, 0.9] });
  const local = await storeFromUrl(ctx, url, 'mp4');
  // a saída da Wan vem sem som: devolve o áudio original do trecho
  let finalLocal = local;
  if (src.has_audio) {
    const original = join(ctx.workDir, 'original-audio.' + (src.path.split('.').pop() || 'mp4'));
    await ctx.storage.download(src.path, original);
    finalLocal = join(ctx.workDir, 'com-audio.mp4');
    await ffmpeg(['-y', '-i', local, '-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', original, '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', finalLocal]);
  }
  const asset = await saveOutput(ctx, finalLocal, {
    name: `${src.name} → ${character.name}`,
    category: 'transformed',
    ext: 'mp4',
    characterId: character.id,
    rightsFrom: src,
    metadata: { synthetic: true, provider: 'fal', model: endpoint, mode: p.mode, source_asset_id: src.id, trim: [start, end] },
  });
  return { outputs: [asset.id], ...falCost(ctx) };
}

/** Personagem falando: imagem + áudio → vídeo com boca sincronizada (VEED Fabric 1.0). */
export const talkHandler: Handler = async (ctx) => {
  const fal = falOf(ctx);
  const p = ctx.job.params as { resolution?: string };
  const image = ctx.inputs.find((a) => a.kind === 'image');
  const audio = ctx.inputs.find((a) => a.kind === 'audio');
  if (!image || !audio) throw new JobError('invalid_params', 'Escolha uma imagem e um áudio.');
  if (Number(audio.duration_s) > 30) throw new JobError('invalid_params', 'O áudio pode ter no máximo 30 segundos.');
  const url = await fal.run(ctx, 'talk', 'veed/fabric-1.0', {
    image_url: await ctx.storage.signedUrl(image.path, 4 * 3600),
    audio_url: await ctx.storage.signedUrl(audio.path, 4 * 3600),
    resolution: p.resolution === '720p' ? '720p' : '480p',
  }, { label: 'Personagem falando', range: [0.05, 0.9] });
  const local = await storeFromUrl(ctx, url, 'mp4');
  const asset = await saveOutput(ctx, local, {
    name: `Falando — ${image.name}`.slice(0, 120),
    category: 'generated',
    ext: 'mp4',
    characterId: image.character_id,
    metadata: { synthetic: true, provider: 'fal', model: 'veed/fabric-1.0', source_asset_ids: [image.id, audio.id] },
  });
  return { outputs: [asset.id], ...falCost(ctx) };
};

// ---------------------------------------------------------------------------
export const ttsHandler: Handler = async (ctx) => {
  const runway = runwayOf(ctx);
  const p = ctx.job.params as unknown as TtsParams;
  const text = (p.text ?? '').trim();
  if (!text || text.length > 3000) throw new JobError('invalid_params', 'O texto deve ter entre 1 e 3000 caracteres.');
  const presetId = p.voice;
  if (!isVoicePreset(presetId)) throw new JobError('invalid_params', 'Voz inválida.');
  const [url] = await runway.runTask(
    ctx,
    'tts',
    () =>
      runway.client.textToSpeech.create({
        model: 'eleven_v3',
        promptText: text,
        voice: { type: 'runway-preset', presetId },
        languageCode: p.language || 'pt',
        speed: p.speed ? Math.min(Math.max(p.speed, 0.7), 1.2) : undefined,
        stability: p.stability != null ? Math.min(Math.max(p.stability, 0), 1) : undefined,
      }),
    { label: 'Voz', range: [0.1, 0.85] },
  );
  const local = await storeFromUrl(ctx, url, 'mp3');
  const audio = await saveOutput(ctx, local, {
    name: `Voz — ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`,
    category: 'generated',
    ext: local.split('.').pop() || 'mp3',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'runway', model: 'eleven_v3', voice: p.voice, language: p.language, text },
  });
  const outputs = [audio.id];
  if (p.make_subtitles && audio.duration_s) {
    const srtLocal = join(ctx.workDir, 'voz.srt');
    await writeFile(srtLocal, toSrt(estimateCues(text, Number(audio.duration_s))));
    const path = `${ctx.job.user_id}/generated/${randomUUID()}.srt`;
    const size = await ctx.storage.upload(srtLocal, path, 'application/x-subrip');
    const sub = await ctx.createAsset({
      kind: 'subtitle', category: 'generated', name: `Legenda — ${text.slice(0, 30)}`, path, mime: 'application/x-subrip', size_bytes: size,
      duration_s: audio.duration_s, probe_status: 'ok', character_id: p.character_id ?? null, project_id: ctx.job.project_id,
      metadata: { estimated: true, source_asset_id: audio.id },
    });
    outputs.push(sub.id);
  }
  return { outputs, ...costOf(ctx) };
};

// ---------------------------------------------------------------------------
export const TEXT_SYSTEM = `Você é roteirista e diretor de vídeos curtos para redes sociais, escrevendo em português do Brasil.
Regras obrigatórias:
- Nunca invente dados de tendências, estatísticas, métricas, números de visualizações ou fatos sobre pessoas reais. Se o tema exigir dados, escreva de forma que não dependa deles.
- Não prometa viralização nem resultados garantidos.
- Comece pelo gancho nos 2 primeiros segundos; nada de introduções longas.
- Personagens são fictícios e originais; não imite pessoas reais nem marcas de terceiros.
- Conteúdo seguro: nada de fraude, desinformação, assédio ou conteúdo sexual.
- Campos terminados em _en são instruções para modelos de geração de vídeo: escreva em inglês, descrição visual concreta (sujeito, ação, cenário, câmera, luz), no máximo 900 caracteres, sem texto na tela.
- Durações de cena entre 4 e 10 segundos.`;

export const textHandler: Handler = async (ctx) => {
  const p = ctx.job.params as unknown as TextParams;
  const generator = p.engine === 'gemini' ? ctx.gemini : ctx.text;
  if (!generator) {
    throw new JobError('not_configured', p.engine === 'gemini' ? 'A integração com o Gemini não está configurada neste servidor.' : 'A integração de textos (Claude) não está configurada neste servidor.');
  }
  const input = p.input ?? {};
  let characterText = '';
  if (p.character_id) {
    const c = await ctx.loadCharacter(p.character_id);
    if (c.user_id !== ctx.job.user_id) throw new JobError('forbidden', 'Personagem inválido.');
    characterText = `\nPersonagem: ${c.name}. Descrição visual (use nos prompts _en): ${characterDescriptor(c)}.`;
  }
  const brief = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  if (!brief) throw new JobError('invalid_params', 'Preencha o pedido.');

  let result;
  let title = 'Roteiro';
  if (p.task === 'social_pack') {
    result = await generator.generate(
      TEXT_SYSTEM,
      `Crie um pacote de conteúdo com: 5 ideias, o roteiro completo da melhor ideia (gancho, desenvolvimento, momento principal, conclusão, chamada para ação quando apropriada), falas do personagem com tempo aproximado, cenas com prompts visuais, legenda do post, 5 títulos, descrição, até 10 hashtags relevantes (sem inventar volume de buscas), sugestão de capa e 3 variações do roteiro com ganchos diferentes.${characterText}\nPedido:\n${brief}`,
      SocialPackSchema,
    );
    title = result.data.script.title;
  } else if (p.task === 'split_script') {
    result = await generator.generate(
      TEXT_SYSTEM,
      `Divida o roteiro abaixo em cenas curtas e independentes para geração de vídeo, mantendo a ordem e o sentido das falas. Para cada cena: título curto, narração (texto original correspondente), prompt visual em inglês, movimento de câmera e duração.${characterText}\nPedido:\n${brief}`,
      SplitScriptSchema,
    );
    title = String(input.titulo ?? 'Roteiro dividido em cenas');
  } else if (p.task === 'scene_prompt') {
    result = await generator.generate(
      TEXT_SYSTEM,
      `Transforme a descrição de cena abaixo numa instrução organizada para um modelo de vídeo (prompt_en, até 900 caracteres) e explique em notes_pt, em uma ou duas frases, o que foi decidido.${characterText}\nCena:\n${brief}`,
      ScenePromptSchema,
    );
  } else {
    throw new JobError('invalid_params', 'Tarefa de texto desconhecida.');
  }

  if (p.task !== 'scene_prompt') {
    await ctx.db.from('scripts').insert({
      user_id: ctx.job.user_id,
      project_id: ctx.job.project_id,
      character_id: p.character_id ?? null,
      title,
      platform: typeof input.plataforma === 'string' ? input.plataforma : null,
      content: { task: p.task, input, output: result.data },
      job_id: ctx.job.id,
    });
  }
  return { outputs: [], result: { ...result.data }, actualUsd: result.usd, providerCost: { [p.engine === 'gemini' ? 'gemini' : 'anthropic']: result.usage } };
};
