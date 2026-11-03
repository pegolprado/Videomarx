import { AlertTriangle, Coins } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { JobKind } from '@shared/jobs';
import { formatCredits } from '@shared/format';
import { createJob, estimateJob } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useCredits } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import type { Estimate, Job } from '@/lib/types';
import { Button, Notice } from './ui';

const UNIT: Record<string, string> = { second: 's', image: 'imagem', request: 'pedido', chars50: '× 50 caracteres' };

/**
 * Mostra a estimativa calculada pelo banco e só cria a tarefa após a
 * confirmação explícita do usuário (nenhuma tarefa paga roda sem custo visível).
 */
export function CostConfirm({
  kind,
  params,
  inputs = [],
  projectId,
  disabled,
  label = 'Gerar',
  onCreated,
  extraWarning,
}: {
  kind: JobKind;
  params: Record<string, unknown>;
  inputs?: string[];
  projectId?: string | null;
  disabled?: boolean | string;
  label?: string;
  onCreated?: (job: Job) => void;
  extraWarning?: string;
}) {
  const [est, setEst] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const credits = useCredits();
  const qc = useQueryClient();
  const key = useMemo(() => JSON.stringify([kind, params, inputs]), [kind, params, inputs]);
  // uma chave por combinação de parâmetros: clique duplo não cria duas tarefas
  const idem = useMemo(() => crypto.randomUUID(), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (disabled) {
      setEst(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      estimateJob(kind, params, inputs)
        .then((e) => alive && setEst(e))
        .catch((e) => alive && setEst({ credits: 0, provider: null, items: [], errors: [errorMessage(e)], credit_value_usd: 0.01 }))
        .finally(() => alive && setLoading(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = credits.data?.available ?? 0;
  const insufficient = !!est && est.credits > available;
  const blocked = !!disabled || !est || est.errors.length > 0 || insufficient || loading;

  async function submit() {
    if (!est) return;
    setBusy(true);
    try {
      const job = await createJob({ kind, params, inputs, projectId, confirmedCredits: est.credits, idempotencyKey: idem });
      toast.success('Tarefa enviada. Você pode sair desta página e acompanhar em Tarefas.');
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      onCreated?.(job);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface-2/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Coins className="size-4 text-warning" />
          <span className="text-muted">Custo estimado:</span>
          <span className="font-semibold">{loading ? '…' : est ? formatCredits(est.credits) : '—'}</span>
          {est && est.credits > 0 && <span className="text-xs text-muted">≈ US$ {(est.credits * Number(est.credit_value_usd ?? 0.01)).toFixed(2)}</span>}
          {est && est.credits === 0 && !est.errors.length && <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">grátis</span>}
        </div>
        <span className="text-xs text-muted">Saldo: {formatCredits(available)}</span>
      </div>
      {est && est.items.length > 1 && (
        <ul className="space-y-0.5 text-xs text-muted">
          {est.items.map((i) => (
            <li key={i.key} className="flex justify-between gap-2">
              <span>
                {i.label} — {i.units} {UNIT[i.unit] ?? i.unit}
              </span>
              <span>{formatCredits(i.credits)}</span>
            </li>
          ))}
        </ul>
      )}
      {typeof disabled === 'string' && <p className="text-sm text-muted">{disabled}</p>}
      {est?.errors.map((e) => (
        <Notice key={e} tone="danger">
          {e}
        </Notice>
      ))}
      {insufficient && <Notice tone="warning">Créditos insuficientes para esta tarefa.</Notice>}
      {extraWarning && (
        <p className="flex items-start gap-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {extraWarning}
        </p>
      )}
      <p className="text-xs text-muted">
        Você só paga o custo real do provedor, até o valor estimado. Se a tarefa falhar, os créditos são devolvidos conforme a política vigente.
      </p>
      <Button variant="primary" size="lg" onClick={submit} loading={busy} disabled={blocked}>
        {label} {est && !est.errors.length ? `· ${formatCredits(est.credits)}` : ''}
      </Button>
    </div>
  );
}
