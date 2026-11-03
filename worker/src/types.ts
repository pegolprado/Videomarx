import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobKind } from '../../shared/jobs.ts';
import type { Config } from './config.ts';
import type { Storage } from './storage.ts';
import type { RunwayAdapter } from './providers/runway.ts';
import type { TextGenerator } from './providers/anthropic.ts';
import type { CloudflareAI } from './providers/cloudflare.ts';
import type { FalAdapter } from './providers/fal.ts';
import type { GradioSpace } from './providers/gradio.ts';
import type { PollinationsAdapter } from './providers/pollinations.ts';

/** GPU grátis do Hugging Face: abre um Space (com o token, se houver). */
export interface HfProvider {
  open(space: string): GradioSpace;
}

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: JobKind;
  status: string;
  provider: string;
  model: string | null;
  params: Record<string, unknown>;
  input_asset_ids: string[];
  estimated_credits: number;
  state: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
  provider_task_ids: string[];
}

export interface AssetRow {
  id: string;
  user_id: string;
  kind: 'image' | 'video' | 'audio' | 'subtitle' | 'other';
  category: string;
  name: string;
  bucket: string;
  path: string;
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
  thumbnail_path: string | null;
  fps: number | null;
  character_id: string | null;
  project_id: string | null;
  metadata: Record<string, unknown>;
  probe_status: string;
  rights_confirmed_at: string | null;
}

export interface CharacterRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  description: string;
  appearance: Record<string, string | undefined>;
  custom_instructions: string;
  primary_image_id: string | null;
  voice: Record<string, unknown>;
}

export interface Settings {
  creditValueUsd: number;
  markup: number;
  runwayUsdPerCredit: number;
  abortIfProviderEstimateExceeds: boolean;
}

export interface HandlerResult {
  outputs: string[];
  result?: Record<string, unknown>;
  /** custo real do provedor em USD; null = tarefa local, cobra a estimativa */
  actualUsd: number | null;
  providerCost?: Record<string, unknown>;
}

export interface JobContext {
  job: JobRow;
  db: SupabaseClient;
  config: Config;
  settings: Settings;
  storage: Storage;
  runway?: RunwayAdapter;
  /** Claude */
  text?: TextGenerator;
  /** Gemini (plano grátis) */
  gemini?: TextGenerator;
  /** Cloudflare Workers AI (cota grátis) */
  cloudflare?: CloudflareAI;
  /** fal.ai (pago por uso) */
  fal?: FalAdapter;
  /** GPU grátis do Hugging Face */
  hf?: HfProvider;
  /** Pollinations (pago por uso) */
  pollinations?: PollinationsAdapter;
  workDir: string;
  inputs: AssetRow[];
  /** registra progresso/estado (estado sobrevive a quedas do worker) */
  progress(p: number | null, state?: Record<string, unknown>, taskId?: string, event?: string): Promise<void>;
  isCancelRequested(): Promise<boolean>;
  /** cria um registro de arquivo para o resultado */
  createAsset(row: Partial<AssetRow> & Pick<AssetRow, 'kind' | 'category' | 'name' | 'path'>): Promise<AssetRow>;
  loadCharacter(id: string): Promise<CharacterRow>;
  loadAsset(id: string): Promise<AssetRow>;
}

export type Handler = (ctx: JobContext) => Promise<HandlerResult>;
