/**
 * fal.ai (SDK oficial @fal-ai/client), pago por uso e barato:
 *  - fal-ai/wan/v2.2-a14b/image-to-video/turbo  → vídeo com movimento a partir de imagem
 *  - fal-ai/wan/v2.2-14b/animate/replace        → troca a pessoa do vídeo pelo personagem (mesmo cenário)
 *  - fal-ai/wan/v2.2-14b/animate/move           → personagem repete os movimentos do vídeo
 *  - veed/fabric-1.0                            → imagem + áudio → personagem falando
 * Parâmetros conferidos nos tipos do próprio SDK.
 *
 * Como na Runway: o id do pedido é salvo no estado da tarefa antes de esperar,
 * então uma retomada consulta o mesmo pedido em vez de criar (e pagar) outro.
 */
import { ApiError, createFalClient } from '@fal-ai/client';
import { CanceledError, JobError, TransientError } from '../errors.ts';
import type { JobContext } from '../types.ts';

export type FalEndpoint =
  | 'fal-ai/wan/v2.2-a14b/image-to-video/turbo'
  | 'fal-ai/wan/v2.2-14b/animate/replace'
  | 'fal-ai/wan/v2.2-14b/animate/move'
  | 'veed/fabric-1.0';

/** Subconjunto da fila do SDK usado aqui (facilita testes). */
export interface FalQueueLike {
  submit(endpoint: string, opts: { input: Record<string, unknown> }): Promise<{ request_id: string }>;
  status(endpoint: string, opts: { requestId: string; logs?: boolean }): Promise<{ status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'; queue_position?: number }>;
  result(endpoint: string, opts: { requestId: string }): Promise<{ data: unknown }>;
  cancel(endpoint: string, opts: { requestId: string }): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FalAdapter {
  constructor(
    private readonly queue: FalQueueLike,
    private readonly pollMs = 5000,
    private readonly timeoutMs = 45 * 60_000,
  ) {}

  static create(key: string): FalAdapter {
    const client = createFalClient({ credentials: key });
    return new FalAdapter(client.queue as unknown as FalQueueLike);
  }

  /** Executa (ou retoma) um pedido e devolve a URL do vídeo gerado. */
  async run(ctx: JobContext, stage: string, endpoint: FalEndpoint, input: Record<string, unknown>, opts: { label: string; range?: [number, number] }): Promise<string> {
    const key = `${stage}_fal`;
    const [from, to] = opts.range ?? [0.1, 0.95];
    let requestId = ctx.job.state[key] as string | undefined;
    if (!requestId) {
      if (await ctx.isCancelRequested()) throw new CanceledError();
      const res = await wrap(() => this.queue.submit(endpoint, { input }));
      requestId = res.request_id;
      ctx.job.state[key] = requestId;
      await ctx.progress(from, { [key]: requestId }, requestId, `${opts.label}: enviado à fal.ai`);
    }
    const started = Date.now();
    let tick = 0;
    for (;;) {
      const st = await wrap(() => this.queue.status(endpoint, { requestId: requestId!, logs: false }));
      if (st.status === 'COMPLETED') break;
      if (await ctx.isCancelRequested()) {
        await wrap(() => this.queue.cancel(endpoint, { requestId: requestId! })).catch(() => {});
        throw new CanceledError();
      }
      if (Date.now() - started > this.timeoutMs) throw new JobError('provider_timeout', `${opts.label}: a fal.ai não terminou dentro do tempo limite.`);
      // sem porcentagem real do provedor: avança devagar até 90% da faixa
      tick++;
      await ctx.progress(from + (to - from) * Math.min(0.9, tick / 60));
      await sleep(this.pollMs);
    }
    const result = await wrap(() => this.queue.result(endpoint, { requestId: requestId! }));
    const url = (result.data as { video?: { url?: string } } | undefined)?.video?.url;
    if (!url) throw new JobError('provider_empty', `${opts.label}: a fal.ai não devolveu o vídeo.`);
    await ctx.progress(to, undefined, undefined, `${opts.label}: concluído`);
    return url;
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapFalError(e);
  }
}

export function mapFalError(e: unknown): Error {
  if (e instanceof JobError || e instanceof TransientError || e instanceof CanceledError) return e;
  if (e instanceof ApiError) {
    const s = e.status;
    if (s === 401 || s === 403) return new JobError('provider_auth', 'A chave da fal.ai é inválida, sem permissão ou sem saldo. Confira em fal.ai → Billing e avise o administrador.');
    if (s === 402) return new JobError('provider_billing', 'A conta da fal.ai está sem saldo. Adicione créditos em fal.ai → Billing.');
    if (s === 422 || s === 400) return new JobError('provider_rejected', `A fal.ai recusou o pedido: ${detail(e)}`);
    if (s === 429 || s >= 500) return new TransientError(`fal.ai indisponível no momento: ${e.message}`);
    return new JobError('provider_error', `Erro da fal.ai: ${detail(e)}`);
  }
  return new TransientError(`Falha de conexão com a fal.ai: ${(e as Error).message}`);
}

function detail(e: ApiError<unknown>): string {
  const body = e.body as { detail?: unknown } | undefined;
  if (body?.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail).slice(0, 300);
  return e.message;
}
