/** Execução de uma tarefa: contexto, tratamento de falhas e liquidação. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CanceledError, JobError, TransientError } from './errors.ts';
import { HANDLERS } from './handlers/index.ts';
import type { Config } from './config.ts';
import type { Storage } from './storage.ts';
import type { RunwayAdapter } from './providers/runway.ts';
import { spentCredits } from './providers/runway.ts';
import type { TextGenerator } from './providers/anthropic.ts';
import type { CloudflareAI } from './providers/cloudflare.ts';
import type { AssetRow, CharacterRow, JobContext, JobRow, Settings } from './types.ts';

export interface RunnerDeps {
  db: SupabaseClient;
  config: Config;
  storage: Storage;
  runway?: RunwayAdapter;
  text?: TextGenerator;
  gemini?: TextGenerator;
  cloudflare?: CloudflareAI;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from('app_settings').select('key,value');
  if (error) throw new TransientError(`Falha ao ler configurações: ${error.message}`);
  const m = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  return {
    creditValueUsd: Number(m.get('credit_value_usd') ?? 0.01),
    markup: Number(m.get('provider_markup') ?? 1),
    runwayUsdPerCredit: Number(m.get('runway_usd_per_credit') ?? 0.01),
    abortIfProviderEstimateExceeds: m.get('abort_if_provider_estimate_exceeds') !== false,
  };
}

/** Espera exponencial para falhas temporárias: 15 s, 30 s, 60 s… (máx. 10 min). */
export function backoffSeconds(attempt: number): number {
  return Math.min(600, 15 * 2 ** Math.max(0, attempt - 1));
}

export async function processJob(job: JobRow, deps: RunnerDeps): Promise<'succeeded' | 'failed' | 'canceled' | 'requeued'> {
  const { db, config } = deps;
  const log = deps.log ?? (() => {});
  const workDir = join(config.tmpDir, job.id);
  await mkdir(workDir, { recursive: true });
  const finish = async (status: 'succeeded' | 'failed' | 'canceled', extra: { usd?: number | null; cost?: Record<string, unknown>; outputs?: string[]; result?: Record<string, unknown>; code?: string; message?: string }) => {
    const { error } = await db.rpc('worker_finish', {
      p_job_id: job.id,
      p_worker: config.workerId,
      p_status: status,
      p_actual_usd: extra.usd ?? null,
      p_provider_cost: extra.cost ?? null,
      p_output_asset_ids: extra.outputs ?? null,
      p_result: extra.result ?? null,
      p_error_code: extra.code ?? null,
      p_error_message: extra.message ?? null,
    });
    if (error) throw new Error(`worker_finish: ${error.message}`);
  };

  /** custo já incorrido no provedor (para política de reembolso em falhas) */
  const incurredUsd = (settings?: Settings) => {
    const credits = spentCredits(job.state);
    return credits > 0 && settings ? Math.round(credits * settings.runwayUsdPerCredit * 10_000) / 10_000 : null;
  };

  let settings: Settings | undefined;
  try {
    if (job.cancel_requested) throw new CanceledError();
    settings = await loadSettings(db);
    const inputs = await loadAssets(db, job.input_asset_ids);
    const ctx: JobContext = {
      job,
      db,
      config,
      settings,
      storage: deps.storage,
      runway: deps.runway,
      text: deps.text,
      gemini: deps.gemini,
      cloudflare: deps.cloudflare,
      workDir,
      inputs,
      async progress(p, state, taskId, event) {
        const { error } = await db.rpc('worker_progress', {
          p_job_id: job.id,
          p_worker: config.workerId,
          p_progress: p,
          p_state: state ?? null,
          p_task_id: taskId ?? null,
          p_event: event ?? null,
        });
        if (error) throw new TransientError(`Falha ao registrar progresso: ${error.message}`);
        if (state) Object.assign(job.state, state);
      },
      async isCancelRequested() {
        const { data } = await db.from('jobs').select('cancel_requested').eq('id', job.id).single();
        return !!data?.cancel_requested;
      },
      async createAsset(row) {
        const { data, error } = await db
          .from('assets')
          .insert({ ...row, user_id: job.user_id, job_id: job.id, project_id: row.project_id ?? job.project_id })
          .select('*')
          .single();
        if (error) throw new TransientError(`Falha ao registrar arquivo: ${error.message}`);
        return data as AssetRow;
      },
      async loadCharacter(id) {
        const { data, error } = await db.from('characters').select('*').eq('id', id).single();
        if (error || !data) throw new JobError('not_found', 'Personagem não encontrado.');
        return data as CharacterRow;
      },
      async loadAsset(id) {
        const { data, error } = await db.from('assets').select('*').eq('id', id).single();
        if (error || !data) throw new JobError('not_found', 'Arquivo não encontrado.');
        return data as AssetRow;
      },
    };
    const handler = HANDLERS[job.kind];
    if (!handler) throw new JobError('unsupported', 'Tipo de tarefa não suportado por este servidor.');
    log('job.start', { id: job.id, kind: job.kind, attempt: job.attempts });
    const res = await handler(ctx);
    await finish('succeeded', { usd: res.actualUsd, cost: res.providerCost, outputs: res.outputs, result: res.result });
    log('job.done', { id: job.id, usd: res.actualUsd });
    return 'succeeded';
  } catch (e) {
    if (e instanceof CanceledError) {
      await finish('canceled', { usd: incurredUsd(settings), code: 'canceled', message: 'Cancelada pelo usuário' });
      return 'canceled';
    }
    if (e instanceof TransientError) {
      log('job.retry', { id: job.id, error: e.message });
      const { error } = await db.rpc('worker_requeue', {
        p_job_id: job.id,
        p_worker: config.workerId,
        p_delay_seconds: backoffSeconds(job.attempts),
        p_error: e.message,
      });
      if (error) throw new Error(`worker_requeue: ${error.message}`);
      return 'requeued';
    }
    const code = e instanceof JobError ? e.code : 'internal';
    const message = e instanceof JobError ? e.message : 'Erro interno no processamento. A equipe foi notificada pelos registros.';
    log('job.failed', { id: job.id, code, error: (e as Error).message, stack: e instanceof JobError ? undefined : (e as Error).stack });
    await finish('failed', { usd: incurredUsd(settings), code, message, cost: { runway_credits: spentCredits(job.state) } });
    return 'failed';
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function loadAssets(db: SupabaseClient, ids: string[]): Promise<AssetRow[]> {
  if (!ids.length) return [];
  const { data, error } = await db.from('assets').select('*').in('id', ids);
  if (error) throw new TransientError(`Falha ao carregar arquivos: ${error.message}`);
  return (data ?? []) as AssetRow[];
}
