/**
 * Worker do VideoAI Studio.
 * Busca tarefas na fila (Supabase), executa com FFmpeg e provedores de IA e
 * registra progresso, custo real e resultado. Pode rodar em várias instâncias.
 */
import { mkdir } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config.ts';
import { run } from './ffmpeg.ts';
import { supportedKinds } from './handlers/index.ts';
import { runMaintenance } from './maintenance.ts';
import { TextAdapter } from './providers/anthropic.ts';
import { detectLocal } from './providers/local.ts';
import { RunwayAdapter } from './providers/runway.ts';
import { processJob } from './runner.ts';
import { Storage } from './storage.ts';
import type { JobRow } from './types.ts';

const config = loadConfig();
const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const storage = new Storage(db);
const runway = config.runwayKey ? RunwayAdapter.create(config.runwayKey) : undefined;
const text = config.anthropicKey ? TextAdapter.create(config.anthropicKey, config.anthropicModel) : undefined;

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'], 10_000);
    await run('ffprobe', ['-version'], 10_000);
    return true;
  } catch {
    return false;
  }
}

let stopping = false;
const running = new Set<Promise<unknown>>();

async function main() {
  await mkdir(config.tmpDir, { recursive: true });
  const ffmpegOk = await hasFfmpeg();
  const local = await detectLocal(config);
  const caps = {
    ffmpeg: ffmpegOk,
    runway: !!runway,
    anthropic: !!text,
    local: ffmpegOk && (local.transcribe || local.tts),
    local_transcribe: local.transcribe,
    local_tts: local.tts,
    local_voices: local.voices,
  };
  const kinds = supportedKinds(caps);
  log('worker.start', { id: config.workerId, version: config.version, caps, kinds });
  if (!kinds.length) log('worker.warning', { message: 'Nenhuma capacidade disponível: instale o FFmpeg e/ou configure as chaves de API.' });

  const heartbeat = async () => {
    const { error } = await db.rpc('worker_heartbeat', { p_worker: config.workerId, p_version: config.version, p_capabilities: caps });
    if (error) log('heartbeat.error', { error: error.message });
  };
  await heartbeat();
  const hb = setInterval(heartbeat, 30_000);
  const maint = setInterval(() => runMaintenance(db, storage, log).catch((e) => log('maintenance.error', { error: String(e) })), 10 * 60_000);

  while (!stopping) {
    const free = config.concurrency - running.size;
    if (free > 0 && kinds.length) {
      const { data, error } = await db.rpc('worker_claim_jobs', { p_worker: config.workerId, p_limit: free, p_kinds: kinds });
      if (error) log('claim.error', { error: error.message });
      for (const job of (data ?? []) as JobRow[]) {
        const p = processJob(job, { db, config, storage, runway, text, log })
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
  // encerra com elegância: termina o que está rodando (tarefas da Runway são retomadas por outro worker se passar do prazo)
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
