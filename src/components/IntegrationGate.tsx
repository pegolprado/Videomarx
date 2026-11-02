import { Plug } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { integrationStatus } from '@shared/transform';
import { useCapabilities } from '@/lib/hooks';
import { Notice } from './ui';

/** Mostra claramente quando uma funcionalidade depende de integração pendente. */
export function IntegrationGate({ provider, feature, children }: { provider: string; feature: string; children?: ReactNode }) {
  const caps = useCapabilities();
  const st = integrationStatus(caps.data, provider);
  if (caps.isLoading) return null;
  if (st.ok) return <>{children}</>;
  return (
    <Notice tone="warning" title={`${feature}: integração pendente`}>
      <p>
        {st.reason}. Esta função fica bloqueada até a integração estar ativa — nada é cobrado.{' '}
        <Link to="/integracoes" className="inline-flex items-center gap-1 font-medium text-accent underline">
          <Plug className="size-3.5" /> Ver integrações
        </Link>
      </p>
    </Notice>
  );
}

export function useIntegration(provider: string) {
  const caps = useCapabilities();
  return integrationStatus(caps.data, provider);
}

/** Motor de texto: Gemini (grátis) quando disponível; senão Claude. */
export function useTextEngine(): { engine: 'gemini' | 'anthropic'; ok: boolean; reason?: string; label: string } {
  const gemini = useIntegration('gemini');
  const claude = useIntegration('anthropic');
  if (gemini.ok) return { engine: 'gemini', ok: true, label: 'Gemini, grátis' };
  if (claude.ok) return { engine: 'anthropic', ok: true, label: 'Claude' };
  return { engine: 'gemini', ok: false, reason: `Nenhum motor de texto ativo (Gemini: ${gemini.reason?.toLowerCase()})`, label: 'Gemini' };
}
