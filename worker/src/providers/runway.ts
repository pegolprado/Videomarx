/**
 * Adaptador Runway (SDK oficial @runwayml/sdk).
 *
 * Garantias:
 *  - cada tarefa criada no provedor tem o id salvo no estado da tarefa ANTES de
 *    esperar o resultado; se o worker cair, a retomada consulta a mesma tarefa
 *    em vez de criar outra (sem cobrança duplicada);
 *  - se a estimativa da Runway passar da reserva do usuário, a tarefa é
 *    cancelada no provedor e o usuário é reembolsado;
 *  - o custo real informado pela Runway (cost.credits) é somado por estágio.
 */
import RunwayML from '@runwayml/sdk';
import { CanceledError, JobError, TransientError } from '../errors.ts';
import type { JobContext } from '../types.ts';

type CreateResponse = { id: string; estimatedCost?: { credits: number } };
type TaskStatus =
  | { status: 'PENDING' | 'THROTTLED'; id: string }
  | { status: 'RUNNING'; id: string; progress: number }
  | { status: 'SUCCEEDED'; id: string; output: string[]; cost: { credits: number } }
  | { status: 'FAILED'; id: string; failure: string; failureCode?: string; cost: { credits: number } }
  | { status: 'CANCELLED'; id: string; cost: { credits: number } };

/** Subconjunto do cliente usado aqui (facilita testes). */
export interface RunwayClientLike {
  tasks: {
    retrieve(id: string): PromiseLike<unknown>;
    delete(id: string): PromiseLike<unknown>;
  };
}

export interface RunTaskOptions {
  /** faixa de progresso total ocupada por este estágio */
  range?: [number, number];
  label: string;
}

const FAILURE_HINTS: Record<string, string> = {
  SAFETY: 'O conteúdo foi recusado pela moderação do provedor.',
  'SAFETY.INPUT': 'O conteúdo enviado foi recusado pela moderação do provedor.',
  'SAFETY.OUTPUT': 'O resultado foi bloqueado pela moderação do provedor.',
  'INPUT_PREPROCESSING.SAFETY': 'O conteúdo enviado foi recusado pela moderação do provedor.',
  'INPUT_PREPROCESSING.INTERNAL': 'O provedor não conseguiu processar o arquivo enviado.',
  'ASSET.INVALID': 'O provedor considerou o arquivo inválido (formato, tamanho ou duração).',
  'INTERNAL.BAD_OUTPUT': 'O provedor gerou um resultado inválido. Tente novamente.',
  INTERNAL: 'Falha interna do provedor. Tente novamente.',
};

export class RunwayAdapter {
  constructor(
    readonly client: RunwayML & RunwayClientLike,
    private readonly pollMs = 6000,
    private readonly timeoutMs = 45 * 60_000,
  ) {}

  static create(apiKey: string): RunwayAdapter {
    return new RunwayAdapter(new RunwayML({ apiKey, maxRetries: 2 }));
  }

  /** Executa (ou retoma) um estágio e devolve as URLs de saída. */
  async runTask(ctx: JobContext, stage: string, create: () => Promise<CreateResponse>, opts: RunTaskOptions): Promise<string[]> {
    const key = `${stage}_task`;
    let id = ctx.job.state[key] as string | undefined;
    const [from, to] = opts.range ?? [0.1, 0.95];

    if (!id) {
      if (await ctx.isCancelRequested()) throw new CanceledError();
      const resp = await wrap(create);
      id = resp.id;
      ctx.job.state[key] = id;
      await ctx.progress(from, { [key]: id }, id, `${opts.label}: enviado à Runway`);
      if (resp.estimatedCost && ctx.settings.abortIfProviderEstimateExceeds) {
        const projected = platformCredits(ctx, spentCredits(ctx.job.state) + resp.estimatedCost.credits);
        if (projected > ctx.job.estimated_credits) {
          await wrap(() => this.client.tasks.delete(id!));
          throw new JobError(
            'price_mismatch',
            `O preço atual do provedor (${projected} créditos) ficou acima da estimativa confirmada (${ctx.job.estimated_credits}). Nada foi cobrado; o administrador precisa atualizar a tabela de preços.`,
          );
        }
      }
    }

    const started = Date.now();
    for (;;) {
      const task = (await wrap(() => this.client.tasks.retrieve(id!))) as TaskStatus;
      switch (task.status) {
        case 'SUCCEEDED':
          ctx.job.state[`${stage}_credits`] = task.cost?.credits ?? 0;
          await ctx.progress(to, { [`${stage}_credits`]: task.cost?.credits ?? 0 }, undefined, `${opts.label}: concluído`);
          if (!task.output?.length) throw new JobError('provider_empty', 'O provedor não retornou nenhum arquivo.');
          return task.output;
        case 'FAILED': {
          ctx.job.state[`${stage}_credits`] = task.cost?.credits ?? 0;
          await ctx.progress(null, { [`${stage}_credits`]: task.cost?.credits ?? 0 });
          const hint = failureHint(task.failureCode);
          throw new JobError(`runway_${task.failureCode ?? 'failed'}`, [`${opts.label} falhou na Runway.`, hint, `Detalhe: ${task.failure}`].filter(Boolean).join(' '));
        }
        case 'CANCELLED':
          ctx.job.state[`${stage}_credits`] = task.cost?.credits ?? 0;
          throw new CanceledError();
        case 'RUNNING':
          await ctx.progress(from + (to - from) * Math.min(Math.max(task.progress ?? 0, 0), 1));
          break;
        default:
          await ctx.progress(null);
      }
      if (await ctx.isCancelRequested()) {
        await wrap(() => this.client.tasks.delete(id!));
        throw new CanceledError();
      }
      if (Date.now() - started > this.timeoutMs) {
        throw new JobError('provider_timeout', `${opts.label}: o provedor não respondeu dentro do tempo limite.`);
      }
      await sleep(this.pollMs);
    }
  }

  /** Custo real acumulado em USD (créditos Runway × preço do crédito). */
  usd(ctx: JobContext): number {
    return Math.round(spentCredits(ctx.job.state) * ctx.settings.runwayUsdPerCredit * 10_000) / 10_000;
  }
}

/** Procura a dica do código mais específico ao mais geral (ex.: SAFETY.INPUT.TEXT → SAFETY.INPUT → SAFETY). */
export function failureHint(code: string | undefined): string {
  if (!code) return '';
  const parts = code.split('.');
  for (let n = parts.length; n > 0; n--) {
    const hint = FAILURE_HINTS[parts.slice(0, n).join('.')];
    if (hint) return hint;
  }
  return '';
}

export function spentCredits(state: Record<string, unknown>): number {
  return Object.entries(state)
    .filter(([k]) => k.endsWith('_credits'))
    .reduce((n, [, v]) => n + (Number(v) || 0), 0);
}

function platformCredits(ctx: JobContext, runwayCredits: number): number {
  const s = ctx.settings;
  return Math.ceil((runwayCredits * s.runwayUsdPerCredit * s.markup) / s.creditValueUsd);
}

async function wrap<T>(fn: () => PromiseLike<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapRunwayError(e);
  }
}

export function mapRunwayError(e: unknown): Error {
  if (e instanceof JobError || e instanceof TransientError || e instanceof CanceledError) return e;
  if (e instanceof RunwayML.APIConnectionError || e instanceof RunwayML.RateLimitError || e instanceof RunwayML.InternalServerError) {
    return new TransientError(`Runway indisponível no momento: ${(e as Error).message}`);
  }
  if (e instanceof RunwayML.AuthenticationError || e instanceof RunwayML.PermissionDeniedError) {
    return new JobError('provider_auth', 'A chave da Runway é inválida ou não tem permissão. Avise o administrador.');
  }
  if (e instanceof RunwayML.NotFoundError) {
    return new JobError('provider_task_missing', 'A tarefa não existe mais no provedor.');
  }
  if (e instanceof RunwayML.BadRequestError || e instanceof RunwayML.UnprocessableEntityError) {
    return new JobError('provider_rejected', `A Runway recusou a solicitação: ${(e as Error).message}`);
  }
  if (e instanceof RunwayML.APIError) {
    return new JobError('provider_error', `Erro da Runway: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
