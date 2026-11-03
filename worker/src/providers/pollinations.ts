/**
 * Pollinations (gen.pollinations.ai) — pago por uso, barato, com várias formas de pagamento.
 * Vídeo: GET /video/{prompt}?model=…  com "Prefer: respond-async" → 202 { id };
 * consulta GET /v1/jobs/{id} até "succeeded" e baixa GET /v1/jobs/{id}/result.
 * Pedidos idênticos reaproveitam a mesma geração e a mesma cobrança (documentação oficial),
 * e o id fica salvo no estado da tarefa: uma retomada não paga de novo.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CanceledError, JobError, TransientError } from '../errors.ts';
import type { JobContext } from '../types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const POLLINATIONS_BASE = 'https://gen.pollinations.ai';

export interface PollinationsVideoInput {
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  /** URL pública da imagem inicial */
  image?: string;
  seed?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function videoUrl(input: PollinationsVideoInput): string {
  const q = new URLSearchParams({ model: input.model });
  if (input.duration) q.set('duration', String(input.duration));
  if (input.aspectRatio) q.set('aspectRatio', input.aspectRatio);
  if (input.image) q.set('image', input.image);
  if (input.seed) q.set('seed', String(input.seed));
  return `${POLLINATIONS_BASE}/video/${encodeURIComponent(input.prompt)}?${q}`;
}

export async function pollinationsError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const msg = body?.error?.message || `HTTP ${res.status}`;
  const s = res.status;
  if (s === 401) return new JobError('provider_auth', 'A chave da Pollinations é inválida. Confira em enter.pollinations.ai → Keys e no Admin.');
  if (s === 402) return new JobError('provider_billing', 'A conta da Pollinations está sem saldo pago. Os modelos de vídeo não aceitam o saldo grátis (Quest): compre um pacote em enter.pollinations.ai.');
  if (s === 403) return new JobError('provider_auth', `A Pollinations negou acesso a este modelo (${msg}). Confira as permissões da chave e se há saldo pago.`);
  if (s === 400 || s === 422) return new JobError('provider_rejected', `A Pollinations recusou o pedido: ${msg}`);
  if (s === 429 || s >= 500) return new TransientError(`Pollinations indisponível no momento: ${msg}`);
  return new JobError('provider_error', `Erro da Pollinations: ${msg}`);
}

export class PollinationsAdapter {
  constructor(
    private readonly key: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly pollMs = 5000,
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, headers: { Authorization: `Bearer ${this.key}`, ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      throw new TransientError(`Falha de conexão com a Pollinations: ${(e as Error).message}`);
    }
  }

  private async save(res: Response, dest: string) {
    if (!res.body) throw new JobError('provider_empty', 'A Pollinations não devolveu o vídeo.');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
  }

  /** Gera (ou retoma) o vídeo e grava em dest. */
  async video(ctx: JobContext, stage: string, input: PollinationsVideoInput, dest: string, range: [number, number] = [0.05, 0.9]): Promise<void> {
    const key = `${stage}_pollinations`;
    const [from, to] = range;
    let id = ctx.job.state[key] as string | undefined;
    if (!id) {
      if (await ctx.isCancelRequested()) throw new CanceledError();
      const res = await this.req(videoUrl(input), { headers: { Prefer: 'respond-async' } });
      if (res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('video/')) {
        // resultado já pronto (cache)
        await this.save(res, dest);
        await ctx.progress(to, undefined, undefined, 'Vídeo pronto (Pollinations)');
        return;
      }
      if (res.status !== 202 && !res.ok) throw await pollinationsError(res);
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      if (!body.id) throw new TransientError('A Pollinations não devolveu o número do pedido.');
      id = body.id;
      ctx.job.state[key] = id;
      await ctx.progress(from, { [key]: id }, id, 'Enviado à Pollinations');
    }
    const started = Date.now();
    let tick = 0;
    for (;;) {
      const res = await this.req(`${POLLINATIONS_BASE}/v1/jobs/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        // registro expirado (24 h): esquece o id para gerar de novo na próxima tentativa
        delete ctx.job.state[key];
        await ctx.progress(null, { [key]: null });
        throw new TransientError('O pedido na Pollinations expirou. A tarefa tenta de novo.');
      }
      if (!res.ok) throw await pollinationsError(res);
      const st = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } | string };
      if (st.status === 'succeeded') break;
      if (st.status === 'failed') {
        const msg = typeof st.error === 'string' ? st.error : st.error?.message;
        throw new JobError('provider_failed', `A Pollinations não conseguiu gerar o vídeo${msg ? `: ${msg}` : '.'}`);
      }
      if (await ctx.isCancelRequested()) throw new CanceledError();
      if (Date.now() - started > this.timeoutMs) throw new JobError('provider_timeout', 'A Pollinations não terminou dentro do tempo limite.');
      tick++;
      await ctx.progress(from + (to - from) * Math.min(0.9, tick / 60));
      await sleep(this.pollMs);
    }
    const out = await this.req(`${POLLINATIONS_BASE}/v1/jobs/${encodeURIComponent(id)}/result`);
    if (!out.ok) throw await pollinationsError(out);
    await this.save(out, dest);
    await ctx.progress(to, undefined, undefined, 'Vídeo pronto (Pollinations)');
  }
}
