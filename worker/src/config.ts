import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  runwayKey?: string;
  anthropicKey?: string;
  anthropicModel: string;
  workerId: string;
  concurrency: number;
  pollMs: number;
  tmpDir: string;
  fontFile: string;
  version: string;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    runwayKey: process.env.RUNWAYML_API_SECRET || undefined,
    anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    workerId: process.env.WORKER_ID || `${hostname()}-${process.pid}`,
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2)),
    pollMs: Math.max(1000, Number(process.env.WORKER_POLL_MS || 3000)),
    tmpDir: process.env.WORKER_TMP_DIR || join(tmpdir(), 'videoai-worker'),
    fontFile: process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    version: process.env.WORKER_VERSION || '0.1.0',
  };
}
