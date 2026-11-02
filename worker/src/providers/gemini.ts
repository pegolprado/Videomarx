/**
 * Textos com Google Gemini (SDK oficial @google/genai), pensado para o plano
 * gratuito: saída JSON validada pelo mesmo esquema zod usado com o Claude.
 */
import { ApiError, GoogleGenAI } from '@google/genai';
import * as z from 'zod/v4';
import { JobError, TransientError } from '../errors.ts';
import type { TextGenerator, TextResult } from './anthropic.ts';

type ModelsLike = Pick<GoogleGenAI['models'], 'generateContent'>;

export class GeminiAdapter implements TextGenerator {
  constructor(
    private readonly models: ModelsLike,
    readonly model: string,
  ) {}

  static create(apiKey: string, model: string): GeminiAdapter {
    return new GeminiAdapter(new GoogleGenAI({ apiKey }).models, model);
  }

  async generate<S extends z.ZodType>(system: string, user: string, schema: S): Promise<TextResult<z.infer<S>>> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    let res;
    try {
      res = await this.models.generateContent({
        model: this.model,
        contents: user,
        config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: jsonSchema, maxOutputTokens: 16000 },
      });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429) throw new TransientError('Limite gratuito do Gemini atingido no momento (por minuto ou por dia). A tarefa tenta de novo sozinha; se persistir, o limite diário renova no dia seguinte.');
        if (e.status === 401 || e.status === 403) throw new JobError('provider_auth', 'A chave do Gemini é inválida ou não tem permissão. Avise o administrador.');
        if (e.status >= 500) throw new TransientError(`Gemini indisponível no momento: ${e.message}`);
        throw new JobError('provider_rejected', `O Gemini recusou o pedido: ${e.message}`);
      }
      throw new TransientError(`Falha de conexão com o Gemini: ${(e as Error).message}`);
    }
    const usage = {
      input_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.model,
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
