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
  anthropicModel: string;
  geminiModel: string;
  workerId: string;
  concurrency: number;
  pollMs: number;
  tmpDir: string;
  fontFile: string;
  version: string;
  /** motor próprio: Whisper (whisper.cpp) e Piper */
  whisperBin: string;
  whisperModel: string;
  piperBin: string;
  voicesDir: string;
  localThreads: number;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    // alias do Google que aponta para o Flash mais recente (plano gratuito)
    geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    workerId: process.env.WORKER_ID || `${hostname()}-${process.pid}`,
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2)),
    pollMs: Math.max(1000, Number(process.env.WORKER_POLL_MS || 3000)),
    tmpDir: process.env.WORKER_TMP_DIR || join(tmpdir(), 'videoai-worker'),
    fontFile: process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    version: process.env.WORKER_VERSION || '0.3.0',
    whisperBin: process.env.WHISPER_BIN || '/usr/local/bin/whisper-cli',
    whisperModel: process.env.WHISPER_MODEL_PATH || '/models/whisper.bin',
    piperBin: process.env.PIPER_BIN || '/opt/piper/piper',
    voicesDir: process.env.PIPER_VOICES_DIR || '/voices',
    localThreads: Math.max(1, Number(process.env.LOCAL_AI_THREADS || 2)),
  };
}
