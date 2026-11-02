/**
 * Imagens com Cloudflare Workers AI (FLUX.1 schnell, licença Apache 2.0),
 * dentro da cota gratuita diária da conta Cloudflare.
 */
import { JobError, TransientError } from '../errors.ts';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface CfResponse {
  success?: boolean;
  result?: { image?: string };
  errors?: { code?: number; message?: string }[];
}

export class CloudflareAI {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  /** Gera uma imagem a partir do texto e devolve os bytes (JPEG). */
  async flux(prompt: string, steps = 6): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: Math.min(Math.max(Math.round(steps), 1), 8) }),
      });
    } catch (e) {
      throw new TransientError(`Falha de conexão com a Cloudflare: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as CfResponse | null;
    const msg = body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
    if (!res.ok || !body?.success) {
      if (res.status === 401 || res.status === 403) throw new JobError('provider_auth', 'O token ou o ID da conta Cloudflare estão incorretos ou sem permissão de Workers AI. Avise o administrador.');
      if (res.status === 429 || /neuron|allocation|quota|limit exceeded/i.test(msg)) {
        throw new JobError('free_quota', 'A cota gratuita diária de imagens da Cloudflare acabou. Ela renova à meia-noite UTC (21h no horário de Brasília).');
      }
      if (res.status >= 500) throw new TransientError(`Cloudflare indisponível no momento: ${msg}`);
      throw new JobError('provider_rejected', `A Cloudflare recusou o pedido: ${msg}`);
    }
    const b64 = body.result?.image;
    if (!b64) throw new JobError('provider_empty', 'A Cloudflare não devolveu nenhuma imagem.');
    return Buffer.from(b64, 'base64');
  }
}
