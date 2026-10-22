/**
 * Textos com Claude (SDK oficial @anthropic-ai/sdk): roteiros, ganchos,
 * legendas, divisão em cenas e instruções para os modelos visuais.
 * Saída sempre estruturada (validada por esquema zod).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { JobError, TransientError } from '../errors.ts';

/** USD por milhão de tokens (entrada, saída). Conferir em anthropic.com/pricing. */
const PRICING: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export interface TextResult<T> {
  data: T;
  usd: number;
  usage: { input_tokens: number; output_tokens: number; model: string };
}

export class TextAdapter {
  constructor(
    private readonly client: Anthropic,
    readonly model: string,
  ) {}

  static create(apiKey: string, model: string): TextAdapter {
    return new TextAdapter(new Anthropic({ apiKey, maxRetries: 2 }), model);
  }

  async generate<S extends z.ZodType>(system: string, user: string, schema: S): Promise<TextResult<z.infer<S>>> {
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
        throw new TransientError(`Serviço de texto indisponível: ${(e as Error).message}`);
      }
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new JobError('provider_auth', 'A chave da Anthropic é inválida. Avise o administrador.');
      }
      if (e instanceof Anthropic.APIError) throw new JobError('provider_error', `Erro no serviço de texto: ${e.message}`);
      throw e;
    }
    const usage = {
      input_tokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0),
      output_tokens: msg.usage.output_tokens ?? 0,
      model: msg.model,
    };
    const usd = costUsd(msg.model, usage.input_tokens, usage.output_tokens);
    if (msg.stop_reason === 'refusal') {
      throw new JobError('refused', 'O pedido foi recusado pelas políticas de uso do modelo. Reformule o tema.');
    }
    if (msg.stop_reason === 'max_tokens' || !msg.parsed_output) {
      throw new JobError('invalid_output', 'O modelo não retornou uma resposta completa. Tente novamente com um pedido menor.');
    }
    return { data: msg.parsed_output as z.infer<S>, usd, usage };
  }
}

export function costUsd(model: string, input: number, output: number): number {
  const [i, o] = PRICING[model] ?? PRICING['claude-opus-5-5'];
  return Math.round(((input * i + output * o) / 1_000_000) * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Esquemas das respostas
// ---------------------------------------------------------------------------

export const SocialPackSchema = z.object({
  ideas: z.array(z.object({ title: z.string(), hook: z.string(), summary: z.string() })),
  script: z.object({
    title: z.string(),
    hook: z.string(),
    development: z.string(),
    climax: z.string(),
    conclusion: z.string(),
    cta: z.string(),
    lines: z.array(z.object({ speaker: z.string(), text: z.string(), approx_seconds: z.number() })),
  }),
  scenes: z.array(
    z.object({
      description_pt: z.string(),
      visual_prompt_en: z.string(),
      camera: z.string(),
      duration_seconds: z.number(),
    }),
  ),
  caption: z.string(),
  titles: z.array(z.string()),
  description: z.string(),
  hashtags: z.array(z.string()),
  cover_suggestion: z.string(),
  variations: z.array(z.object({ label: z.string(), hook: z.string(), script: z.string() })),
});

export const SplitScriptSchema = z.object({
  scenes: z.array(
    z.object({
      title: z.string(),
      narration: z.string(),
      visual_prompt_en: z.string(),
      camera: z.string(),
      duration_seconds: z.number(),
    }),
  ),
});

export const ScenePromptSchema = z.object({
  prompt_en: z.string(),
  notes_pt: z.string(),
});
