/**
 * Worker do VideoAI Studio.
 * Busca tarefas na fila (Supabase), executa com FFmpeg, motor próprio e
 * provedores de IA, e registra progresso, custo real e resultado.
 * As chaves de API vêm do ambiente ou do cofre do banco (painel admin) e são
 * relidas a cada 30 s: colar uma chave no painel ativa a integração sozinha.
 */
import { mkdir } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config.ts';
import { run } from './ffmpeg.ts';
import { supportedKinds } from './handlers/index.ts';
import { runMaintenance } from './maintenance.ts';
import { TextAdapter } from './providers/anthropic.ts';
import { CloudflareAI } from './providers/cloudflare.ts';
import { FalAdapter } from './providers/fal.ts';
import { GeminiAdapter } from './providers/gemini.ts';
import { GradioSpace } from './providers/gradio.ts';
import { detectMotion } from './providers/motion.ts';
import { PollinationsAdapter } from './providers/pollinations.ts';
import { detectLocal } from './providers/local.ts';
import { RunwayAdapter } from './providers/runway.ts';
import { processJob, type RunnerDeps } from './runner.ts';
import { SecretStore } from './secrets.ts';
import { Storage } from './storage.ts';
import type { JobRow } from './types.ts';

const config = loadConfig();
const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const storage = new Storage(db);
const secrets = new SecretStore(db);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'], 10_000);
    await run('ffprobe', ['-version'], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Adaptadores recriados apenas quando alguma chave muda. */
let providers: Pick<RunnerDeps, 'runway' | 'text' | 'gemini' | 'cloudflare' | 'fal' | 'hf' | 'pollinations'> = {};
let fingerprint = '';
function rebuildProviders() {
  const fp = secrets.fingerprint();
  if (fp === fingerprint) return;
  fingerprint = fp;
  const runwayKey = secrets.get('RUNWAYML_API_SECRET');
  const anthropicKey = secrets.get('ANTHROPIC_API_KEY');
  const geminiKey = secrets.get('GEMINI_API_KEY');
  const cfAccount = secrets.get('CLOUDFLARE_ACCOUNT_ID');
  const cfToken = secrets.get('CLOUDFLARE_API_TOKEN');
  const falKey = secrets.get('FAL_KEY');
  const hfToken = secrets.get('HF_TOKEN');
  const pollinationsKey = secrets.get('POLLINATIONS_KEY');
  providers = {
    runway: runwayKey ? RunwayAdapter.create(runwayKey) : undefined,
    text: anthropicKey ? TextAdapter.create(anthropicKey, config.anthropicModel) : undefined,
    gemini: geminiKey ? GeminiAdapter.create(geminiKey, config.geminiModel, config.geminiFallbacks) : undefined,
    cloudflare: cfAccount && cfToken ? new CloudflareAI(cfAccount, cfToken) : undefined,
    fal: falKey ? FalAdapter.create(falKey) : undefined,
    // GPU grátis: funciona sem token (cota anônima do IP); com token, cota da conta
    hf: { open: (space: string) => new GradioSpace(space, hfToken) },
    pollinations: pollinationsKey ? new PollinationsAdapter(pollinationsKey) : undefined,
  };
  log('providers.updated', { runway: !!providers.runway, anthropic: !!providers.text, gemini: !!providers.gemini, cloudflare: !!providers.cloudflare, fal: !!providers.fal, hf_token: !!hfToken, pollinations: !!providers.pollinations });
}

let stopping = false;
const running = new Set<Promise<unknown>>();

async function main() {
  await mkdir(config.tmpDir, { recursive: true });
  const ffmpegOk = await hasFfmpeg();
  const local = await detectLocal(config);
  const motion = ffmpegOk && (await detectMotion(config));
  const capabilities = () => ({
    ffmpeg: ffmpegOk,
    runway: !!providers.runway,
    anthropic: !!providers.text,
    gemini: !!providers.gemini,
    cloudflare: !!providers.cloudflare,
    fal: !!providers.fal,
    hf: !!providers.hf,
    pollinations: !!providers.pollinations,
    motion,
    local: ffmpegOk && (local.transcribe || local.tts),
    local_transcribe: local.transcribe,
    local_tts: local.tts,
    local_voices: local.voices,
  });
  await secrets.refresh();
  rebuildProviders();
  log('worker.start', { id: config.workerId, version: config.version, caps: capabilities() });

  const heartbeat = async () => {
    try {
      await secrets.refresh();
      rebuildProviders();
    } catch (e) {
      log('secrets.error', { error: String(e) });
    }
    const { error } = await db.rpc('worker_heartbeat', { p_worker: config.workerId, p_version: config.version, p_capabilities: capabilities() });
    if (error) log('heartbeat.error', { error: error.message });
  };
  await heartbeat();
  const hb = setInterval(heartbeat, 30_000);
  const maint = setInterval(() => runMaintenance(db, storage, log).catch((e) => log('maintenance.error', { error: String(e) })), 10 * 60_000);

  while (!stopping) {
    const kinds = supportedKinds(capabilities());
    const free = config.concurrency - running.size;
    if (free > 0 && kinds.length) {
      const { data, error } = await db.rpc('worker_claim_jobs', { p_worker: config.workerId, p_limit: free, p_kinds: kinds });
      if (error) log('claim.error', { error: error.message });
      for (const job of (data ?? []) as JobRow[]) {
        const p = processJob(job, { db, config, storage, ...providers, log })
          .catch((e) => log('job.crash', { id: job.id, error: String(e) }))
          .finally(() => running.delete(p));
        running.add(p);
      }
      if (data?.length) continue;
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
  clearInterval(hb);
  clearInterval(maint);
  await Promise.allSettled([...running]);
  log('worker.stop');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('worker.signal', { sig });
    stopping = true;
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}

main().catch((e) => {
  log('worker.fatal', { error: String(e) });
  process.exit(1);
});
