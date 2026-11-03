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
  'ai.talk',
  'local.transcribe',
  'local.tts',
  'pipeline.auto_video',
  'media.motion',
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
  'ai.talk': 'Personagem falando',
  'local.transcribe': 'Legendas automáticas',
  'local.tts': 'Voz (motor próprio)',
  'pipeline.auto_video': 'Vídeo automático',
  'media.motion': 'Modelo animado',
};

export const KIND_PROVIDER: Record<JobKind, 'ffmpeg' | 'runway' | 'anthropic' | 'local' | 'gemini' | 'cloudflare' | 'fal' | 'hf' | 'pollinations' | 'motion'> = {
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
  'ai.talk': 'fal',
  'local.transcribe': 'local',
  'local.tts': 'local',
  'pipeline.auto_video': 'ffmpeg',
  'media.motion': 'motion',
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

/** Vídeo automático: tema (ou roteiro) → cenas → imagens → narração → vídeo. */
export interface AutoVideoParams {
  mode: 'topic' | 'script';
  topic?: string;
  script?: string;
  split?: 'paragraph' | 'line' | 'sentence';
  scenes?: number;
  aspect: Aspect;
  style?: string;
  character_id?: string;
  /** voz do Piper; vazio = sem narração */
  voice?: string;
  speed?: number;
  caption?: 'classic' | 'boxed' | 'big' | 'none';
  motion?: SlideMotion | 'auto';
  music_asset_id?: string;
  music_volume?: number;
  /** segundos por cena quando não há narração */
  seconds_per_scene?: number;
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

export type FalResolution = '480p' | '720p';

export interface VideoParams {
  /**
   * fal = Wan 2.2 a partir de imagem (barato); hf = GPU grátis do Hugging Face (limite diário);
   * pollinations = Wan 2.2 pago na Pollinations; padrão = Runway
   */
  engine?: 'runway' | 'fal' | 'hf' | 'pollinations';
  resolution?: FalResolution;
  model: 'gen4.5' | 'gen4_turbo' | 'veo3.1' | 'veo3.1_fast' | 'fal-wan2.2' | 'hf-wan2.2' | 'pollinations-wan2.2';
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
  /**
   * fal = Wan 2.2 Animate (troca no vídeo original / transferência de movimento);
   * hf = o mesmo modelo na GPU grátis do Hugging Face (limite diário); padrão = Runway
   */
  engine?: 'runway' | 'fal' | 'hf';
  resolution?: '480p' | '580p' | '720p';
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

/** Personagem falando: imagem + áudio → vídeo com boca sincronizada (VEED Fabric via fal, ou GPU grátis do Hugging Face). */
export interface TalkParams {
  engine?: 'fal' | 'hf';
  resolution?: FalResolution;
  /** descrição opcional da cena (motor grátis) */
  prompt?: string;
}

export type MotionTemplate = 'kinetic' | 'showcase' | 'launch';
export type MotionPalette = 'noite' | 'sol' | 'oceano' | 'neon' | 'papel';

/** Modelo animado (HyperFrames, grátis no nosso servidor): textos e imagens → vídeo com animações. */
export interface MotionParams {
  template: MotionTemplate;
  aspect: Aspect;
  palette: MotionPalette;
  title: string;
  /** frases exibidas em sequência (uma por cena) */
  lines: string[];
  /** chamada final (opcional) */
  cta?: string;
  /** segundos por frase/imagem */
  seconds_per_item?: number;
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
