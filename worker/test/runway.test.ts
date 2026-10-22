import { describe, expect, it, vi } from 'vitest';
import RunwayML from '@runwayml/sdk';
import { RunwayAdapter, mapRunwayError, spentCredits } from '../src/providers/runway.ts';
import { CanceledError, JobError, TransientError } from '../src/errors.ts';
import type { JobContext } from '../src/types.ts';

function fakeCtx(state: Record<string, unknown> = {}, estimated = 100, cancel = false) {
  const progress = vi.fn(async (_p: number | null, s?: Record<string, unknown>) => {
    if (s) Object.assign(ctx.job.state, s);
  });
  const ctx = {
    job: { id: 'j1', estimated_credits: estimated, state },
    settings: { creditValueUsd: 0.01, markup: 1, runwayUsdPerCredit: 0.01, abortIfProviderEstimateExceeds: true },
    progress,
    isCancelRequested: vi.fn(async () => cancel),
  } as unknown as JobContext;
  return ctx;
}

function fakeClient(sequence: unknown[]) {
  const retrieve = vi.fn(async () => sequence.shift());
  const del = vi.fn(async () => undefined);
  return { tasks: { retrieve, delete: del } } as unknown as RunwayML & { tasks: { retrieve: typeof retrieve; delete: typeof del } };
}

describe('RunwayAdapter', () => {
  it('cria, acompanha e soma o custo real', async () => {
    const client = fakeClient([{ status: 'PENDING', id: 't1' }, { status: 'RUNNING', id: 't1', progress: 0.5 }, { status: 'SUCCEEDED', id: 't1', output: ['https://x/out.mp4'], cost: { credits: 25 } }]);
    const adapter = new RunwayAdapter(client, 1);
    const ctx = fakeCtx();
    const create = vi.fn(async () => ({ id: 't1', estimatedCost: { credits: 30 } }));
    const out = await adapter.runTask(ctx, 'video', create, { label: 'Vídeo' });
    expect(out).toEqual(['https://x/out.mp4']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.job.state.video_task).toBe('t1');
    expect(adapter.usd(ctx)).toBe(0.25);
  });

  it('retoma a tarefa salva sem criar outra (sem cobrança dupla)', async () => {
    const client = fakeClient([{ status: 'SUCCEEDED', id: 'old', output: ['u'], cost: { credits: 10 } }]);
    const adapter = new RunwayAdapter(client, 1);
    const create = vi.fn();
    await adapter.runTask(fakeCtx({ video_task: 'old' }), 'video', create, { label: 'Vídeo' });
    expect(create).not.toHaveBeenCalled();
    expect(client.tasks.retrieve).toHaveBeenCalledWith('old');
  });

  it('cancela no provedor se a estimativa passar da reserva', async () => {
    const client = fakeClient([]);
    const adapter = new RunwayAdapter(client, 1);
    const err = await adapter
      .runTask(fakeCtx({}, 20), 'video', async () => ({ id: 't2', estimatedCost: { credits: 50 } }), { label: 'Vídeo' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err.code).toBe('price_mismatch');
    expect(client.tasks.delete).toHaveBeenCalledWith('t2');
  });

  it('considera estágios anteriores na checagem de preço', async () => {
    const client = fakeClient([]);
    const adapter = new RunwayAdapter(client, 1);
    const err = await adapter
      .runTask(fakeCtx({ image_credits: 15 }, 30), 'act_two', async () => ({ id: 't3', estimatedCost: { credits: 20 } }), { label: 'x' })
      .catch((e) => e);
    expect(err.code).toBe('price_mismatch');
  });

  it('falha do provedor vira mensagem compreensível e registra custo', async () => {
    const client = fakeClient([{ status: 'FAILED', id: 't', failure: 'blocked', failureCode: 'SAFETY.INPUT.TEXT', cost: { credits: 0 } }]);
    const ctx = fakeCtx({ x_task: 't' });
    const err = await new RunwayAdapter(client, 1).runTask(ctx, 'x', vi.fn(), { label: 'Vídeo' }).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err.message).toMatch(/moderação/);
    expect(ctx.job.state.x_credits).toBe(0);
  });

  it('cancelamento pedido pelo usuário apaga a tarefa no provedor', async () => {
    const client = fakeClient([{ status: 'RUNNING', id: 't', progress: 0.1 }]);
    const ctx = fakeCtx({ x_task: 't' });
    (ctx.isCancelRequested as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(new RunwayAdapter(client, 1).runTask(ctx, 'x', vi.fn(), { label: 'x' })).rejects.toBeInstanceOf(CanceledError);
    expect(client.tasks.delete).toHaveBeenCalledWith('t');
  });

  it('classifica erros do SDK', () => {
    expect(mapRunwayError(new RunwayML.APIConnectionError({ message: 'x' }))).toBeInstanceOf(TransientError);
    expect(mapRunwayError(new RunwayML.RateLimitError(429, undefined, 'x', new Headers()))).toBeInstanceOf(TransientError);
    const auth = mapRunwayError(new RunwayML.AuthenticationError(401, undefined, 'x', new Headers()));
    expect(auth).toBeInstanceOf(JobError);
    expect((auth as JobError).code).toBe('provider_auth');
    expect(spentCredits({ a_credits: 5, b_credits: '7', a_task: 'x' })).toBe(12);
  });
});
