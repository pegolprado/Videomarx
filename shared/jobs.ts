/** Tipos de tarefa, estados e rótulos — compartilhados entre site e worker. */

export const JOB_KINDS = [
  'media.probe',
  'media.trim',
  'media.export',
  'media.concat',
  'media.autocut',
  'media.slideshow',
  'ai.image',
  'ai.video',
  'ai.transform',
  'ai.tts',
  'ai.text',
  'local.transcribe',
  'local.tts',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['waiting', 'queued', 'processing', 'succeeded', 'failed', 'canceled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACTIVE_STATUSES: readonly JobStatus[] = ['waiting', 'queued', 'processing'];

export const STATUS_LABEL: Record<JobStatus, string> = {
  waiting: 'Aguardando',
  queued: 'Na fila',
  processing: 'Processando',
  succeeded: 'Concluído',
  failed: 'Falhou',
  canceled: 'Cancelado',
};

export const KIND_LABEL: Record<JobKind, string> = {
  'media.probe': 'Análise do arquivo',
  'media.trim': 'Corte de trecho',
  'media.export': 'Exportação',
  'media.concat': 'Montagem da sequência',
  'media.autocut': 'Corte automático de pausas',
  'media.slideshow': 'Vídeo animado',
  'ai.image': 'Geração de imagem',
  'ai.video': 'Geração de vídeo',
  'ai.transform': 'Transformação de vídeo',
  'ai.tts': 'Geração de voz',
  'ai.text': 'Roteiro e textos',
  'local.transcribe': 'Legendas automáticas',
  'local.tts': 'Voz (motor próprio)',
};

export const KIND_PROVIDER: Record<JobKind, 'ffmpeg' | 'runway' | 'anthropic' | 'local' | 'gemini' | 'cloudflare'> = {
  'media.probe': 'ffmpeg',
  'media.trim': 'ffmpeg',
  'media.export': 'ffmpeg',
  'media.concat': 'ffmpeg',
  'media.autocut': 'ffmpeg',
  'media.slideshow': 'ffmpeg',
  'ai.image': 'runway',
  'ai.video': 'runway',
  'ai.transform': 'runway',
  'ai.tts': 'runway',
  'ai.text': 'anthropic',
  'local.transcribe': 'local',
  'local.tts': 'local',
};

export type Aspect = '9:16' | '16:9' | '1:1';
export const ASPECTS: readonly Aspect[] = ['9:16', '16:9', '1:1'];

export interface TrimParams {
  trim_start?: number;
  trim_end?: number;
}

export interface ExportParams extends TrimParams {
  aspect: Aspect;
  /** altura do lado menor: 720 ou 1080 */
  resolution: 720 | 1080;
  fit: 'crop' | 'pad';
  quality: 'economy' | 'high';
  speed?: number;
  volume?: number;
  fade_audio?: boolean;
  /** asset de legenda (.srt) a ser incorporada; se omitido, sem legenda */
  subtitle_asset_id?: string;
  /** brilho/contraste/saturação (ajustes básicos de cor) */
  color?: { brightness?: number; contrast?: number; saturation?: number };
  text_overlay?: { text: string; position: 'top' | 'center' | 'bottom' };
  mute?: boolean;
}

export interface ConcatParams {
  aspect: Aspect;
  resolution: 720 | 1080;
  transition: 'none' | 'fade';
  transition_seconds?: number;
  music_asset_id?: string;
  music_volume?: number;
}

export type SlideMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right';

/** Vídeo a partir de imagens: movimento de câmera, transições, narração e legenda. */
export interface SlideshowParams {
  aspect: Aspect;
  resolution: 720 | 1080;
  /** segundos por imagem quando não há narração */
  seconds_per_image?: number;
  /** movimento fixo ou "auto" (alterna) */
  motion?: SlideMotion | 'auto';
  transition?: 'fade' | 'none';
  /** legenda (.srt) a incorporar */
  subtitle_asset_id?: string;
}

export interface AutocutParams {
  /** nível abaixo do qual o áudio é considerado silêncio (dB) */
  noise_db?: number;
  /** pausa mínima (s) para ser removida */
  min_silence?: number;
  /** margem mantida antes/depois de cada fala (s) */
  padding?: number;
}

export type ImageView = 'portrait' | 'front' | 'side' | 'full_body' | 'expression' | 'pose' | 'scene' | 'cover' | 'custom';

export interface ImageParams {
  /** cloudflare = FLUX.1 schnell na cota grátis; padrão = Runway */
  engine?: 'runway' | 'cloudflare';
  model: 'gen4_image' | 'gen4_image_turbo';
  prompt: string;
  view?: ImageView;
  character_id?: string;
  aspect: Aspect;
  count?: 1;
  seed?: number;
}

export interface VideoParams {
  model: 'gen4.5' | 'gen4_turbo' | 'veo3.1' | 'veo3.1_fast';
  prompt: string;
  duration: number;
  aspect: Aspect;
  character_id?: string;
  /** imagem inicial (asset) — opcional para gen4.5/veo, obrigatória para gen4_turbo */
  image_asset_id?: string;
  /** usar a imagem principal do personagem como quadro inicial */
  use_character_image?: boolean;
  scene_index?: number;
  seed?: number;
}

export interface TransformParams extends TrimParams {
  mode: 'face_swap' | 'head' | 'full_body' | 'appearance' | 'stylized' | 'cinematic';
  character_id: string;
  rights_confirmed: true;
  /** descrição do cenário (recriação) ou do estilo (estilizado/aparência) */
  scene_prompt?: string;
  /** 1 a 5 — intensidade das expressões (Act-Two) */
  expression_intensity?: number;
  /** transferir também gestos e movimento do corpo (Act-Two) */
  body_control?: boolean;
  /** usar quadro inicial editado com o personagem como guia (Aleph) */
  use_character_keyframe?: boolean;
  outfit?: 'original' | 'character' | 'new';
  new_outfit?: string;
  intensity?: 'subtle' | 'medium' | 'strong';
  seed?: number;
}

export interface TtsParams {
  text: string;
  voice: string;
  language: string;
  speed?: number;
  stability?: number;
  character_id?: string;
  /** também gera uma legenda .srt estimada a partir do texto */
  make_subtitles?: boolean;
}

/** Legendas automáticas a partir da fala (Whisper no nosso servidor). */
export interface TranscribeParams {
  /** código ISO 639-1 (pt, en, es…) ou "auto" */
  language?: string;
  /** máximo de caracteres por linha de legenda */
  max_line?: number;
}

/** Voz sintética no nosso servidor (Piper). */
export interface LocalTtsParams {
  text: string;
  voice: string;
  speed?: number;
  character_id?: string;
  make_subtitles?: boolean;
}

export type TextTask = 'social_pack' | 'split_script' | 'scene_prompt' | 'character_prompt';

export interface TextParams {
  /** gemini = plano grátis do Google; padrão = Claude */
  engine?: 'anthropic' | 'gemini';
  task: TextTask;
  input: Record<string, unknown>;
  character_id?: string;
}
