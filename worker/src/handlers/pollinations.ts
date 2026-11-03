/** Vídeo com movimento pela Pollinations (Wan 2.2, ~US$ 0,05 por vídeo de 5 s). */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { clampPrompt } from '../../../shared/prompt.ts';
import type { VideoParams } from '../../../shared/jobs.ts';
import { JobError } from '../errors.ts';
import type { HandlerResult, JobContext } from '../types.ts';
import { characterRefs } from './ai.ts';
import { saveOutput } from './media.ts';

export const POLLINATIONS_VIDEO_MODEL = 'alibaba/wan-2.2-fast';

export async function pollinationsVideo(ctx: JobContext, p: VideoParams): Promise<HandlerResult> {
  if (!ctx.pollinations) throw new JobError('not_configured', 'A integração com a Pollinations não está configurada neste servidor.');
  const promptText = clampPrompt(p.prompt ?? '');
  if (!promptText) throw new JobError('invalid_params', 'Descreva a cena.');
  let image: string | undefined;
  if (p.image_asset_id) {
    const img = await ctx.loadAsset(p.image_asset_id);
    if (img.user_id !== ctx.job.user_id || img.kind !== 'image') throw new JobError('invalid_params', 'Imagem inicial inválida.');
    image = await ctx.storage.signedUrl(img.path, 4 * 3600);
  } else if (p.character_id && p.use_character_image !== false) {
    image = (await characterRefs(ctx, p.character_id, 1)).primaryUrl ?? undefined;
  }
  const local = join(ctx.workDir, `pollinations-${randomUUID()}.mp4`);
  await ctx.pollinations.video(ctx, 'video', {
    model: POLLINATIONS_VIDEO_MODEL,
    prompt: promptText,
    duration: 5,
    aspectRatio: p.aspect === '16:9' ? '16:9' : '9:16',
    image,
    seed: p.seed,
  }, local);
  const asset = await saveOutput(ctx, local, {
    name: p.scene_index != null ? `Cena ${p.scene_index + 1}` : 'Vídeo gerado',
    category: 'generated',
    ext: 'mp4',
    characterId: p.character_id ?? null,
    metadata: { synthetic: true, provider: 'pollinations', model: POLLINATIONS_VIDEO_MODEL, prompt: promptText, scene_index: p.scene_index ?? null, from_image: !!image },
  });
  // a Pollinations não informa o custo na resposta: registra o valor da tabela
  const usd = Math.round(((ctx.job.estimated_credits * ctx.settings.creditValueUsd) / (ctx.settings.markup || 1)) * 10_000) / 10_000;
  return { outputs: [asset.id], actualUsd: usd, providerCost: { pollinations_estimated_usd: usd } };
}
