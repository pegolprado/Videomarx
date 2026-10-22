import { Check } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { formatCredits } from '@shared/format';
import { useAuth } from '@/app/auth';
import { Badge, Card, Notice, PageHeader } from '@/components/ui';
import { useCredits, usePrices, useProfile } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import type { LedgerEntry, Plan } from '@/lib/types';

const KIND: Record<LedgerEntry['kind'], string> = { grant: 'Concessão', reserve: 'Reserva', refund: 'Devolução', adjust: 'Ajuste', purchase: 'Compra' };
const UNIT: Record<string, string> = { second: 'por segundo', image: 'por imagem', request: 'por pedido', chars50: 'a cada 50 caracteres' };

export default function Credits() {
  const credits = useCredits();
  const profile = useProfile();
  const prices = usePrices();
  const { session } = useAuth();
  const ledger = useQuery({
    queryKey: ['ledger', session?.user.id, 100],
    queryFn: async () => {
      const { data, error } = await supabase.from('credit_ledger').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data as LedgerEntry[];
    },
  });
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { data, error } = await supabase.from('plans').select('*').order('sort');
      if (error) throw error;
      return data as Plan[];
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Créditos e planos" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card><p className="text-sm text-muted">Disponível</p><p className="font-display text-3xl font-semibold">{formatCredits(credits.data?.available)}</p></Card>
        <Card><p className="text-sm text-muted">Reservado em tarefas</p><p className="font-display text-3xl font-semibold">{formatCredits(credits.data?.reserved)}</p></Card>
      </div>
      <Notice title="Como a cobrança funciona">
        Antes de cada geração você vê a estimativa. Os créditos ficam reservados durante o processamento e, no fim, é cobrado o custo real informado pelo provedor — nunca acima do estimado. Tarefas que falham são devolvidas conforme a política vigente.
      </Notice>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Planos</h2>
        <Notice tone="warning">Pagamentos ainda não estão habilitados: serão ativados somente depois que o processamento real estiver validado. Para mudar de plano ou receber créditos, fale com o administrador.</Notice>
        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {(plans.data ?? []).map((p) => (
            <Card key={p.id} className={profile.data?.plan_id === p.id ? 'border-accent ring-2 ring-accent/30' : ''}>
              <div className="flex items-center justify-between"><p className="font-display text-lg font-semibold">{p.name}</p>{profile.data?.plan_id === p.id && <Badge tone="accent">Seu plano</Badge>}</div>
              <p className="text-sm text-muted">{p.description}</p>
              <ul className="mt-3 space-y-1 text-sm">
                <li className="flex gap-2"><Check className="size-4 text-success" /> Até {p.max_projects} projetos</li>
                <li className="flex gap-2"><Check className="size-4 text-success" /> Até {p.max_characters} personagens</li>
                <li className="flex gap-2"><Check className="size-4 text-success" /> Trechos de até {p.max_video_seconds} s</li>
                <li className="flex gap-2"><Check className="size-4 text-success" /> Arquivos de até {p.max_upload_mb} MB</li>
                <li className="flex gap-2"><Check className="size-4 text-success" /> Até {p.daily_credit_limit} créditos/dia</li>
              </ul>
              <p className="mt-3 text-xs text-muted">{p.price_brl_cents ? `R$ ${(p.price_brl_cents / 100).toFixed(2)}/mês` : 'Preço a definir'}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Tabela de preços</h2>
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Operação</th><th className="px-3 py-2">Créditos</th><th className="px-3 py-2">Mínimo</th><th className="px-3 py-2">Limites</th></tr></thead>
            <tbody className="divide-y divide-line">
              {(prices.data ?? []).map((p) => (
                <tr key={p.key} className={p.active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">{p.label}</td>
                  <td className="px-3 py-2">{Number(p.credits_per_unit)} {UNIT[p.unit]}</td>
                  <td className="px-3 py-2">{p.min_credits}</td>
                  <td className="px-3 py-2 text-xs text-muted">{p.min_seconds || p.max_seconds ? `${p.min_seconds ?? 0}–${p.max_seconds ?? '∞'} s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Extrato</h2>
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface text-sm">
          {(ledger.data ?? []).map((l) => (
            <li key={l.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
              <span><Badge>{KIND[l.kind]}</Badge> <span className="text-muted">{l.note}</span></span>
              <span className="flex gap-3"><span className="text-xs text-muted">{new Date(l.created_at).toLocaleString('pt-BR')}</span><span className={l.delta < 0 ? 'text-danger' : 'text-success'}>{l.delta > 0 ? '+' : ''}{l.delta}</span></span>
            </li>
          ))}
          {!ledger.data?.length && <li className="px-4 py-3 text-muted">Sem movimentações.</li>}
        </ul>
      </section>
    </div>
  );
}
