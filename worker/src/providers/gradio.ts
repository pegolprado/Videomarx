/**
 * Cliente mínimo para Spaces do Hugging Face (Gradio) — a "GPU grátis".
 *
 * Usa o protocolo de fila do Gradio (o mesmo da página do Space e do gradio_client):
 *   GET  /config                       → componentes e endpoints
 *   POST {prefix}/upload               → envia arquivos
 *   POST {prefix}/queue/join           → entra na fila
 *   GET  {prefix}/queue/data?session_hash=…  (SSE) → posição, progresso e resultado
 *
 * Os Spaces são mantidos pela comunidade e mudam: em vez de fixar a ordem dos
 * parâmetros, o worker lê a configuração e preenche cada entrada pelo tipo e
 * pelo rótulo (imagem, vídeo, áudio, texto do prompt, duração…), deixando o
 * valor padrão do Space nas demais.
 *
 * Cota: Spaces "ZeroGPU" dão alguns minutos de GPU por dia. Com HF_TOKEN a cota
 * é a da conta do token; sem token, a cota anônima do IP do servidor.
 */
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CanceledError, JobError, TransientError } from '../errors.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GradioComponent {
  id: number;
  type: string;
  props?: {
    label?: string | null;
    value?: unknown;
    choices?: unknown[];
    minimum?: number;
    maximum?: number;
    visible?: boolean;
  };
}

export interface GradioDependency {
  api_name?: string | null | false;
  inputs: number[];
  outputs?: number[];
  show_api?: boolean;
}

export interface GradioConfig {
  components: GradioComponent[];
  dependencies: GradioDependency[];
  api_prefix?: string;
}

export interface FileData {
  path: string;
  orig_name?: string;
  meta: { _type: 'gradio.FileData' };
}

export interface SpaceEvent {
  stage: 'queue' | 'running' | 'progress';
  /** posição na fila (0 = próximo) */
  rank?: number;
  eta?: number;
  /** 0..1 dentro do processamento */
  fraction?: number;
  text?: string;
}

export interface PredictOptions {
  /** nome do endpoint (ex.: "generate_video"); null = detectar pelo tipo das entradas */
  api: string | null;
  /** tipos de componente que o endpoint precisa ter (ex.: ["image", "audio"]) */
  requiredTypes: string[];
  /** arquivos locais a enviar, por chave */
  files: Record<string, string>;
  /** devolve o valor de cada entrada; undefined = manter o padrão do Space */
  fill: (c: GradioComponent, uploaded: Record<string, FileData>) => unknown;
  onEvent?: (e: SpaceEvent) => Promise<void> | void;
  isCanceled?: () => Promise<boolean>;
  timeoutMs?: number;
}

/** "dono/nome" → https://dono-nome.hf.space (aceita também a URL completa). */
export function spaceBase(space: string): string {
  const s = space.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(s)) return s;
  const [owner, name] = s.split('/');
  if (!owner || !name) throw new JobError('invalid_space', `Space do Hugging Face inválido: "${space}". Use o formato dono/nome.`);
  return `https://${`${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.hf.space`;
}

const norm = (s: string | null | false | undefined) => (s ? String(s).replace(/^\/+/, '') : '');

/** Escolhe o endpoint: pelo nome; se não existir (ou não informado), o primeiro público com os tipos exigidos. */
export function pickDependency(cfg: GradioConfig, api: string | null, requiredTypes: string[]): number {
  const byId = new Map(cfg.components.map((c) => [c.id, c]));
  if (api) {
    const i = cfg.dependencies.findIndex((d) => norm(d.api_name) === norm(api));
    if (i >= 0) return i;
  }
  const i = cfg.dependencies.findIndex((d) => {
    if (!norm(d.api_name) || d.show_api === false) return false;
    const types = d.inputs.map((id) => byId.get(id)?.type);
    return requiredTypes.every((t) => types.includes(t));
  });
  if (i < 0) {
    throw new JobError('space_changed', `O Space mudou e não tem mais ${api ? `o endpoint "${api}"` : 'um endpoint compatível'}. O administrador pode indicar outro Space em Admin → Configurações.`);
  }
  return i;
}

/** valor de uma opção de Radio/Dropdown (strings ou pares [rótulo, valor]) */
export function choiceValue(choice: unknown): string {
  return Array.isArray(choice) ? String(choice[1] ?? choice[0]) : String(choice);
}

export function findChoice(c: GradioComponent, re: RegExp): string | undefined {
  const found = (c.props?.choices ?? []).find((ch) => re.test(Array.isArray(ch) ? `${ch[0]} ${ch[1]}` : String(ch)));
  return found === undefined ? undefined : choiceValue(found);
}

export function clampToSlider(c: GradioComponent, v: number): number {
  const min = c.props?.minimum ?? -Infinity;
  const max = c.props?.maximum ?? Infinity;
  return Math.min(max, Math.max(min, v));
}

/** Primeira URL de arquivo dentro da saída (vídeo, imagem, áudio, galeria…). */
export function extractFileUrl(data: unknown, fileUrl: (path: string) => string): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = walk(x);
        if (r) return r;
      }
      return null;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.url === 'string' && o.url) return o.url;
    if (typeof o.path === 'string' && o.path && !('video' in o)) return fileUrl(o.path);
    for (const k of ['video', 'value', 'image', 'audio']) {
      const r = walk(o[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(data);
}

/** Traduz mensagens do Space para algo útil ao usuário. */
export function mapSpaceError(message: string): Error {
  const m = message || 'erro desconhecido';
  if (/quota|exceeded your|gpu (time|duration)|zerogpu.*limit|usage limit/i.test(m)) {
    return new JobError(
      'free_quota',
      'A cota grátis diária de GPU do Hugging Face acabou. Ela renova cerca de 24 h depois do primeiro uso. Tente amanhã, use um trecho mais curto, ou cadastre um token do Hugging Face no Admin (cota da sua conta).',
    );
  }
  if (/no gpu|gpus? (are|is) (currently )?(busy|unavailable)|queue (is )?full|too many requests|sleeping|starting|building|connection|timed? ?out/i.test(m)) {
    return new TransientError(`GPU grátis ocupada no momento (${m.slice(0, 160)}). A tarefa tenta de novo sozinha.`);
  }
  return new JobError('provider_failed', `A GPU grátis (Hugging Face) recusou o pedido: ${m.slice(0, 300)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GradioSpace {
  readonly base: string;
  private cfg?: GradioConfig;

  constructor(
    space: string,
    private readonly token?: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.base = spaceBase(space);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, headers: this.headers(init.headers as Record<string, string> | undefined) });
    } catch (e) {
      throw new TransientError(`Falha de conexão com a GPU grátis (Hugging Face): ${(e as Error).message}`);
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new JobError('provider_auth', `O Hugging Face recusou o acesso ao Space (HTTP ${res.status}). Confira o token HF no Admin ou se o Space é público.`);
    }
    if (res.status === 404) {
      throw new JobError('space_unavailable', `O Space ${this.base} não existe mais ou mudou de endereço. O administrador pode indicar outro em Admin → Configurações.`);
    }
    if (res.status === 429 || res.status >= 500) throw mapSpaceError(`HTTP ${res.status} ${text}`);
    throw mapSpaceError(text || `HTTP ${res.status}`);
  }

  private prefix(): string {
    return this.cfg?.api_prefix ?? '/gradio_api';
  }

  fileUrl = (path: string) => `${this.base}${this.prefix()}/file=${path}`;

  async config(): Promise<GradioConfig> {
    if (this.cfg) return this.cfg;
    const res = await this.req(`${this.base}/config`);
    const cfg = (await res.json().catch(() => null)) as GradioConfig | null;
    if (!cfg?.dependencies || !cfg.components) throw new TransientError('O Space ainda está iniciando (configuração indisponível).');
    this.cfg = cfg;
    return cfg;
  }

  async upload(paths: string[]): Promise<FileData[]> {
    if (!paths.length) return [];
    const fd = new FormData();
    for (const p of paths) fd.append('files', new Blob([await readFile(p)]), basename(p));
    const res = await this.req(`${this.base}${this.prefix()}/upload`, { method: 'POST', body: fd });
    const list = (await res.json()) as string[];
    if (!Array.isArray(list) || list.length !== paths.length) throw new TransientError('O Space não confirmou o envio dos arquivos.');
    return list.map((path, i) => ({ path, orig_name: basename(paths[i]), meta: { _type: 'gradio.FileData' } }));
  }

  /** Executa o endpoint e devolve a URL do arquivo gerado. */
  async predict(opts: PredictOptions): Promise<string> {
    const cfg = await this.config();
    const fnIndex = pickDependency(cfg, opts.api, opts.requiredTypes);
    const dep = cfg.dependencies[fnIndex];
    const keys = Object.keys(opts.files);
    const uploadedList = await this.upload(keys.map((k) => opts.files[k]));
    const uploaded = Object.fromEntries(keys.map((k, i) => [k, uploadedList[i]]));
    const byId = new Map(cfg.components.map((c) => [c.id, c]));
    const data = dep.inputs.map((id) => {
      const c = byId.get(id) ?? { id, type: 'unknown' };
      const v = opts.fill(c, uploaded);
      if (v !== undefined) return v;
      return c.type === 'state' ? null : (c.props?.value ?? null);
    });
    const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const join = await this.req(`${this.base}${this.prefix()}/queue/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, fn_index: fnIndex, trigger_id: null, session_hash: session, event_data: null }),
    });
    const eventId = ((await join.json().catch(() => ({}))) as { event_id?: string }).event_id;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25 * 60_000);
    let canceled = false;
    const cancelWatch = setInterval(async () => {
      if (opts.isCanceled && (await opts.isCanceled().catch(() => false))) {
        canceled = true;
        await this.fetchFn(`${this.base}${this.prefix()}/cancel`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ event_id: eventId, session_hash: session, fn_index: fnIndex }),
        }).catch(() => {});
        ctrl.abort();
      }
    }, 5000);
    try {
      const stream = await this.req(`${this.base}${this.prefix()}/queue/data?session_hash=${session}`, { signal: ctrl.signal });
      if (!stream.body) throw new TransientError('O Space não abriu o canal de resultado.');
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (m.event_id && eventId && m.event_id !== eventId) continue;
          const out = await this.handleMessage(m, opts);
          if (out) return out;
        }
      }
      throw new TransientError('A GPU grátis encerrou a conexão antes do resultado. A tarefa tenta de novo sozinha.');
    } catch (e) {
      if (canceled) throw new CanceledError();
      if ((e as Error).name === 'AbortError') throw new TransientError('A GPU grátis não terminou dentro do tempo limite (fila longa). A tarefa tenta de novo mais tarde.');
      throw e;
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelWatch);
    }
  }

  private async handleMessage(m: Record<string, unknown>, opts: PredictOptions): Promise<string | null> {
    switch (m.msg) {
      case 'estimation':
        await opts.onEvent?.({ stage: 'queue', rank: Number(m.rank ?? 0), eta: m.rank_eta != null ? Number(m.rank_eta) : undefined });
        return null;
      case 'process_starts':
        await opts.onEvent?.({ stage: 'running' });
        return null;
      case 'progress': {
        const p = (m.progress_data as { index?: number; length?: number; progress?: number; desc?: string }[] | undefined)?.[0];
        if (p) {
          const fraction = p.progress ?? (p.length ? (p.index ?? 0) / p.length : undefined);
          await opts.onEvent?.({ stage: 'progress', fraction, text: p.desc ?? undefined });
        }
        return null;
      }
      case 'process_completed': {
        const output = (m.output ?? {}) as { data?: unknown; error?: string | null; title?: string | null };
        if (!m.success || output.error) throw mapSpaceError([output.title, output.error].filter(Boolean).join(' — ') || 'falha sem detalhes (Space ocupado ou sem cota)');
        const url = extractFileUrl(output.data, this.fileUrl);
        if (!url) throw new JobError('provider_empty', 'A GPU grátis terminou sem devolver o arquivo.');
        return url;
      }
      case 'queue_full':
        throw new TransientError('A fila da GPU grátis está cheia. A tarefa tenta de novo sozinha.');
      case 'unexpected_error':
        throw mapSpaceError(String(m.message ?? 'erro inesperado'));
      default:
        return null;
    }
  }

  /** Baixa o resultado (com o token, se houver). */
  async download(url: string, dest: string, attempts = 3): Promise<void> {
    for (let a = 1; ; a++) {
      try {
        const own = url.startsWith(this.base);
        const res = own ? await this.req(url) : await this.fetchFn(url);
        if (!res.ok || !res.body) throw new TransientError(`Falha ao baixar o resultado (HTTP ${res.status})`);
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
        return;
      } catch (e) {
        if (a >= attempts || e instanceof JobError) throw e;
        await sleep(2000 * a);
      }
    }
  }
}
