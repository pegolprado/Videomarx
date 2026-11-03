/**
 * Textos com Google Gemini (SDK oficial @google/genai), pensado para o plano
 * gratuito: saída JSON validada pelo mesmo esquema zod usado com o Claude.
 *
 * O plano grátis às vezes responde "alta demanda" (503) ou "limite" (429).
 * Por isso cada pedido tenta de novo com espera curta e, se continuar, passa
 * para o próximo modelo gratuito da lista antes de desistir.
 */
import { ApiError, GoogleGenAI } from '@google/genai';
import * as z from 'zod/v4';
import { JobError, TransientError } from '../errors.ts';
import type { TextGenerator, TextResult } from './anthropic.ts';

type ModelsLike = Pick<GoogleGenAI['models'], 'generateContent'>;

/** Modelos gratuitos tentados depois do principal (os que não existirem são pulados). */
export const GEMINI_FALLBACKS = ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiAdapter implements TextGenerator {
  readonly models: string[];

  constructor(
    private readonly api: ModelsLike,
    model: string,
    fallbacks: string[] = GEMINI_FALLBACKS,
    /** esperas entre tentativas no mesmo modelo (ms) */
    private readonly retryDelays: number[] = [3000, 8000],
  ) {
    this.models = [model, ...fallbacks.filter((m) => m !== model)];
  }

  static create(apiKey: string, model: string, fallbacks?: string[]): GeminiAdapter {
    return new GeminiAdapter(new GoogleGenAI({ apiKey }).models, model, fallbacks);
  }

  async generate<S extends z.ZodType>(system: string, user: string, schema: S): Promise<TextResult<z.infer<S>>> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    let lastBusy = '';
    for (const model of this.models) {
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        let res;
        try {
          res = await this.api.generateContent({
            model,
            contents: user,
            config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: jsonSchema, maxOutputTokens: 16000 },
          });
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0;
          if (status === 401 || status === 403) throw new JobError('provider_auth', 'A chave do Gemini é inválida ou não tem permissão. Avise o administrador.');
          // modelo inexistente/indisponível para esta chave: tenta o próximo
          if (status === 404) break;
          if (status === 400) throw new JobError('provider_rejected', `O Gemini recusou o pedido: ${(e as Error).message}`);
          // 429, 5xx ou falha de rede: espera e tenta de novo; esgotado, passa ao próximo modelo
          lastBusy = status === 429 ? 'limite gratuito atingido' : status >= 500 ? 'alta demanda no Google' : 'falha de conexão';
          if (attempt < this.retryDelays.length) await sleep(this.retryDelays[attempt]);
          continue;
        }
        return this.parse(res, schema, model);
      }
    }
    throw new TransientError(`Gemini indisponível no momento (${lastBusy || 'nenhum modelo gratuito respondeu'}). A tarefa tenta de novo sozinha em alguns minutos.`);
  }

  private parse<S extends z.ZodType>(res: { text?: string; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }, schema: S, model: string): TextResult<z.infer<S>> {
    const usage = {
      input_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      model,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text ?? '');
    } catch {
      throw new JobError('invalid_output', 'O Gemini não devolveu uma resposta completa. Tente novamente com um pedido menor.');
    }
    const check = schema.safeParse(parsed);
    if (!check.success) throw new JobError('invalid_output', 'O Gemini devolveu uma resposta fora do formato esperado. Tente novamente.');
    // plano gratuito: sem custo por uso
    return { data: check.data as z.infer<S>, usd: 0, usage };
  }
}
