import { describe, expect, it, vi } from 'vitest';
import { backoffSeconds, processJob } from '../src/runner.ts';
import type { Config } from '../src/config.ts';
import type { JobRow } from '../src/types.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function fakeDb() {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: async () => ({ data: [], error: null }),
    single: async () => ({ data: { cancel_requested: false }, error: null }),
    then: (r: (v: unknown) => void) => r({ data: [{ key: 'credit_value_usd', value: 0.01 }], error: null }),
  };
  return { rpc, from: () => chain } as unknown as SupabaseClient & { rpc: typeof rpc };
}

const config = { workerId: 'w1', tmpDir: '/tmp/videoai-runner-test' } as Config;
const job = (over: Partial<JobRow> = {}): JobRow => ({
  id: 'j1', user_id: 'u1', project_id: null, kind: 'ai.text', status: 'processing', provider: 'anthropic', model: null,
  params: { task: 'scene_prompt', input: { cena: 'x' } }, input_asset_ids: [], estimated_credits: 10, state: {}, attempts: 1,
  max_attempts: 3, cancel_requested: false, provider_task_ids: [], ...over,
});

describe('processJob', () => {
  it('integração não configurada: falha clara (com reembolso pelo banco)', async () => {
    const db = fakeDb();
    expect(await processJob(job(), { db, config, storage: {} as never })).toBe('failed');
    const [name, args] = db.rpc.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(name).toBe('worker_finish');
    expect(args.p_status).toBe('failed');
    expect(args.p_error_code).toBe('not_configured');
  });

  it('falha temporária volta para a fila com espera crescente', async () => {
    const db = fakeDb();
    const text = { generate: vi.fn(async () => { const { TransientError } = await import('../src/errors.ts'); throw new TransientError('HTTP 529'); }) };
    expect(await processJob(job({ attempts: 2 }), { db, config, storage: {} as never, text: text as never })).toBe('requeued');
    const [name, args] = db.rpc.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(name).toBe('worker_requeue');
    expect(args.p_delay_seconds).toBe(120);
  });

  it('cancelamento pedido antes de começar', async () => {
    const db = fakeDb();
    expect(await processJob(job({ cancel_requested: true }), { db, config, storage: {} as never })).toBe('canceled');
  });

  it('sucesso registra custo real e resultado', async () => {
    const db = fakeDb();
    const text = { generate: vi.fn(async () => ({ data: { prompt_en: 'a', notes_pt: 'b' }, usd: 0.03, usage: { input_tokens: 1, output_tokens: 1, model: 'm' } })) };
    expect(await processJob(job(), { db, config, storage: {} as never, text: text as never })).toBe('succeeded');
    const [, args] = db.rpc.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(args).toMatchObject({ p_status: 'succeeded', p_actual_usd: 0.03, p_result: { prompt_en: 'a', notes_pt: 'b' } });
  });

  it('espera exponencial limitada', () => {
    expect([1, 2, 3, 10].map(backoffSeconds)).toEqual([30, 120, 480, 900]);
  });
});
