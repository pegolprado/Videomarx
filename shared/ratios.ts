import type { Aspect } from './jobs';

/** Resoluções aceitas pela Runway por modelo (tipos do SDK oficial @runwayml/sdk 4.x). */
export const VIDEO_RATIOS: Record<string, Record<Aspect, string | null>> = {
  'gen4.5': { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960' },
  gen4_turbo: { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960' },
  'veo3.1': { '16:9': '1920:1080', '9:16': '1080:1920', '1:1': null },
  'veo3.1_fast': { '16:9': '1920:1080', '9:16': '1080:1920', '1:1': null },
  act_two: { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960' },
};

/** text-to-video da Gen-4.5 aceita só 1280:720 e 720:1280. */
export const TEXT_TO_VIDEO_RATIOS: Record<string, Record<Aspect, string | null>> = {
  'gen4.5': { '16:9': '1280:720', '9:16': '720:1280', '1:1': null },
  'veo3.1': VIDEO_RATIOS['veo3.1'],
  'veo3.1_fast': VIDEO_RATIOS['veo3.1_fast'],
};

export const IMAGE_RATIOS: Record<Aspect, string> = {
  '16:9': '1920:1080',
  '9:16': '1080:1920',
  '1:1': '1080:1080',
};

export const VIDEO_MODELS = [
  { id: 'gen4.5', label: 'Runway Gen-4.5', durations: [2, 3, 4, 5, 6, 7, 8, 9, 10], textToVideo: true, needsImage: false },
  { id: 'gen4_turbo', label: 'Runway Gen-4 Turbo (só a partir de imagem)', durations: [5, 10], textToVideo: false, needsImage: true },
  { id: 'veo3.1', label: 'Google Veo 3.1 (via Runway)', durations: [4, 6, 8], textToVideo: true, needsImage: false },
  { id: 'veo3.1_fast', label: 'Google Veo 3.1 Fast (via Runway)', durations: [4, 6, 8], textToVideo: true, needsImage: false },
  { id: 'fal-wan2.2', label: 'Wan 2.2 via fal.ai — barato (só a partir de imagem)', durations: [5], textToVideo: false, needsImage: true },
  { id: 'hf-wan2.2', label: 'Wan 2.2 GRÁTIS — GPU do Hugging Face (poucos vídeos por dia, pode demorar)', durations: [3, 5], textToVideo: true, needsImage: false },
  { id: 'pollinations-wan2.2', label: 'Wan 2.2 via Pollinations — barato (~US$ 0,05 por vídeo)', durations: [5], textToVideo: true, needsImage: false },
] as const;

export type VideoEngine = 'runway' | 'fal' | 'hf' | 'pollinations';

/** motor de cada modelo de vídeo */
export function videoEngine(model: string): VideoEngine {
  if (model === 'fal-wan2.2') return 'fal';
  if (model === 'hf-wan2.2') return 'hf';
  if (model === 'pollinations-wan2.2') return 'pollinations';
  return 'runway';
}

export function ratioFor(model: string, aspect: Aspect, textOnly: boolean): string | null {
  if (model === 'fal-wan2.2') return textOnly ? null : aspect;
  if (model === 'hf-wan2.2' || model === 'pollinations-wan2.2') return aspect;
  const table = textOnly ? TEXT_TO_VIDEO_RATIOS[model] : VIDEO_RATIOS[model];
  return table?.[aspect] ?? null;
}
