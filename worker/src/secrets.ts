/**
 * Chaves de API: variáveis de ambiente do servidor OU o cofre do banco
 * (gravado pelo admin no painel). O cofre tem prioridade e é relido a cada
 * minuto, então colar uma chave no painel ativa a integração sem reiniciar.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const SECRET_NAMES = ['RUNWAYML_API_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export class SecretStore {
  private values: Partial<Record<SecretName, string>> = {};
  constructor(private readonly db: SupabaseClient) {}

  async refresh(): Promise<void> {
    const fromEnv: Partial<Record<SecretName, string>> = {};
    for (const n of SECRET_NAMES) if (process.env[n]) fromEnv[n] = process.env[n];
    const { data, error } = await this.db.from('provider_secrets').select('name,value');
    // sem a tabela (banco ainda não atualizado) ou erro de rede: mantém o que já tinha
    if (error) {
      this.values = { ...fromEnv, ...this.values };
      return;
    }
    const fromDb: Partial<Record<SecretName, string>> = {};
    for (const r of (data ?? []) as { name: SecretName; value: string }[]) fromDb[r.name] = r.value;
    this.values = { ...fromEnv, ...fromDb };
  }

  get(name: SecretName): string | undefined {
    return this.values[name] || undefined;
  }

  /** muda quando alguma chave muda (para recriar os adaptadores) */
  fingerprint(): string {
    return SECRET_NAMES.map((n) => `${n}:${(this.values[n] ?? '').length}:${(this.values[n] ?? '').slice(-6)}`).join('|');
  }
}
