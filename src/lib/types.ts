import type { Aspect, JobKind, JobStatus } from '@shared/jobs';

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  role: 'user' | 'admin';
  plan_id: string;
  terms_accepted_at: string | null;
  suspended: boolean;
  created_at: string;
  deletion_requested_at: string | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  monthly_credits: number;
  max_projects: number;
  max_characters: number;
  max_upload_mb: number;
  max_video_seconds: number;
  max_job_credits: number;
  daily_credit_limit: number;
  price_brl_cents: number | null;
  features: string[];
  sort: number;
  active: boolean;
}

export interface Character {
  id: string;
  user_id: string;
  parent_id: string | null;
  version_label: string | null;
  name: string;
  kind: string;
  description: string;
  appearance: Record<string, string>;
  personality: string;
  expressions: string;
  speaking_style: string;
  preferred_settings: string;
  reference_poses: string;
  custom_instructions: string;
  voice: { preset_id?: string; language?: string; speed?: number; stability?: number };
  primary_image_id: string | null;
  is_favorite: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'subtitle' | 'other';
export type AssetCategory = 'original' | 'generated' | 'transformed' | 'reference' | 'export' | 'temp';

export interface Asset {
  id: string;
  user_id: string;
  kind: AssetKind;
  category: AssetCategory;
  name: string;
  path: string;
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
  thumbnail_path: string | null;
  character_id: string | null;
  project_id: string | null;
  job_id: string | null;
  metadata: Record<string, unknown> & { synthetic?: boolean; preview_frames?: string[]; aspect?: Aspect; invalid_reason?: string; model?: string; prompt?: string };
  probe_status: 'pending' | 'ok' | 'invalid';
  rights_confirmed_at: string | null;
  is_favorite: boolean;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  type: 'transform' | 'generate' | 'edit' | 'social' | 'voice' | 'image';
  aspect: Aspect;
  character_id: string | null;
  data: Record<string, unknown>;
  thumbnail_asset_id: string | null;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
}

export interface Script {
  id: string;
  title: string;
  platform: string | null;
  content: { task: string; input: Record<string, unknown>; output: Record<string, unknown> };
  character_id: string | null;
  project_id: string | null;
  is_favorite: boolean;
  created_at: string;
}

export interface EstimateItem {
  key: string;
  label: string;
  unit: 'request' | 'second' | 'image' | 'chars50';
  units: number;
  credits: number;
  max_seconds: number | null;
  min_seconds: number | null;
}

export interface Estimate {
  credits: number;
  provider: string | null;
  items: EstimateItem[];
  errors: string[];
  credit_value_usd: number;
}

export interface Job {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: JobKind;
  status: JobStatus;
  provider: string;
  model: string | null;
  params: Record<string, unknown>;
  input_asset_ids: string[];
  output_asset_ids: string[];
  result: Record<string, unknown> | null;
  estimate: Estimate;
  estimated_credits: number;
  charged_credits: number | null;
  actual_usd: number | null;
  provider_cost: Record<string, unknown>;
  provider_task_ids: string[];
  progress: number;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreditAccount {
  user_id: string;
  available: number;
  reserved: number;
}

export interface LedgerEntry {
  id: number;
  delta: number;
  kind: 'grant' | 'reserve' | 'refund' | 'adjust' | 'purchase';
  job_id: string | null;
  note: string | null;
  created_at: string;
}

export interface PriceRow {
  key: string;
  label: string;
  provider: string;
  unit: string;
  credits_per_unit: number;
  min_credits: number;
  min_seconds: number | null;
  max_seconds: number | null;
  active: boolean;
  notes: string;
}
