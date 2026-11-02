import type { JobKind } from '../../../shared/jobs.ts';
import type { Handler } from '../types.ts';
import { autocutHandler, concatHandler, exportHandler, probeHandler, slideshowHandler, trimHandler } from './media.ts';
import { imageHandler, textHandler, transformHandler, ttsHandler, videoHandler } from './ai.ts';
import { localTtsHandler, transcribeHandler } from './local.ts';
import { autoVideoHandler } from './pipeline.ts';

export const HANDLERS: Record<JobKind, Handler> = {
  'media.probe': probeHandler,
  'media.trim': trimHandler,
  'media.export': exportHandler,
  'media.concat': concatHandler,
  'media.autocut': autocutHandler,
  'media.slideshow': slideshowHandler,
  'ai.image': imageHandler,
  'ai.video': videoHandler,
  'ai.transform': transformHandler,
  'ai.tts': ttsHandler,
  'ai.text': textHandler,
  'local.transcribe': transcribeHandler,
  'local.tts': localTtsHandler,
  'pipeline.auto_video': autoVideoHandler,
};

/** Só busca na fila o que este worker consegue executar. */
export interface WorkerCaps {
  ffmpeg: boolean;
  runway: boolean;
  anthropic: boolean;
  gemini?: boolean;
  cloudflare?: boolean;
  local_transcribe?: boolean;
  local_tts?: boolean;
}

export function supportedKinds(caps: WorkerCaps): JobKind[] {
  const kinds: JobKind[] = [];
  if (caps.ffmpeg) kinds.push('media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut', 'media.slideshow');
  // tarefas de IA visual também usam FFmpeg (preparar trechos, miniaturas)
  if (caps.runway && caps.ffmpeg) kinds.push('ai.video', 'ai.transform', 'ai.tts');
  if ((caps.runway || caps.cloudflare) && caps.ffmpeg) kinds.push('ai.image');
  if (caps.anthropic || caps.gemini) kinds.push('ai.text');
  // motor próprio: dependem também do FFmpeg (conversão de áudio)
  if (caps.local_transcribe && caps.ffmpeg) kinds.push('local.transcribe');
  if (caps.local_tts && caps.ffmpeg) kinds.push('local.tts');
  // vídeo automático: imagens grátis da Cloudflare + FFmpeg (Gemini e voz são opcionais conforme o modo)
  if (caps.cloudflare && caps.ffmpeg) kinds.push('pipeline.auto_video');
  return kinds;
}
