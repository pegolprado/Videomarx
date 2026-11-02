import type { JobKind } from '../../../shared/jobs.ts';
import type { Handler } from '../types.ts';
import { autocutHandler, concatHandler, exportHandler, probeHandler, trimHandler } from './media.ts';
import { imageHandler, textHandler, transformHandler, ttsHandler, videoHandler } from './ai.ts';
import { localTtsHandler, transcribeHandler } from './local.ts';

export const HANDLERS: Record<JobKind, Handler> = {
  'media.probe': probeHandler,
  'media.trim': trimHandler,
  'media.export': exportHandler,
  'media.concat': concatHandler,
  'media.autocut': autocutHandler,
  'ai.image': imageHandler,
  'ai.video': videoHandler,
  'ai.transform': transformHandler,
  'ai.tts': ttsHandler,
  'ai.text': textHandler,
  'local.transcribe': transcribeHandler,
  'local.tts': localTtsHandler,
};

/** Só busca na fila o que este worker consegue executar. */
export function supportedKinds(caps: { ffmpeg: boolean; runway: boolean; anthropic: boolean; local_transcribe?: boolean; local_tts?: boolean }): JobKind[] {
  const kinds: JobKind[] = [];
  if (caps.ffmpeg) kinds.push('media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut');
  // tarefas da Runway também usam FFmpeg (preparar trechos, miniaturas)
  if (caps.runway && caps.ffmpeg) kinds.push('ai.image', 'ai.video', 'ai.transform', 'ai.tts');
  if (caps.anthropic) kinds.push('ai.text');
  // motor próprio: dependem também do FFmpeg (conversão de áudio)
  if (caps.local_transcribe && caps.ffmpeg) kinds.push('local.transcribe');
  if (caps.local_tts && caps.ffmpeg) kinds.push('local.tts');
  return kinds;
}
