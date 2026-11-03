import { clsx } from 'clsx';
import { Ban, CheckCircle2, Clock, Download, Loader2, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { KIND_LABEL, STATUS_LABEL, ACTIVE_STATUSES } from '@shared/jobs';
import { formatCredits } from '@shared/format';
import { cancelJob, deleteAsset, signedUrl } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useAssets } from '@/lib/hooks';
import type { Job } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import { AssetThumb } from './Assets';
import { MediaPreview } from './MediaPreview';
import { Badge, Button, Progress } from './ui';

export function StatusBadge({ status }: { status: Job['status'] }) {
  const tone = status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : status === 'canceled' ? 'neutral' : 'accent';
  const Icon = status === 'succeeded' ? CheckCircle2 : status === 'failed' ? XCircle : status === 'canceled' ? Ban : status === 'processing' ? Loader2 : Clock;
  return (
    <Badge tone={tone}>
      <Icon className={clsx('size-3', status === 'processing' && 'animate-spin')} /> {STATUS_LABEL[status]}
    </Badge>
  );
}

export function JobCard({ job, showOutputs = true, onRetry }: { job: Job; showOutputs?: boolean; onRetry?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const outputs = useAssets({ ids: job.status === 'succeeded' && showOutputs ? job.output_asset_ids : [] });
  const active = ACTIVE_STATUSES.includes(job.status);

  async function cancel() {
    setBusy(true);
    try {
      await cancelJob(job.id);
      toast.success(job.status === 'processing' ? 'Cancelamento solicitado.' : 'Tarefa cancelada e créditos devolvidos.');
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['credits'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{KIND_LABEL[job.kind]}</p>
          <p className="text-xs text-muted">
            {new Date(job.created_at).toLocaleString('pt-BR')} · {job.model ?? job.provider}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>
      {active && (
        <div className="flex flex-col gap-1">
          <Progress value={job.status === 'processing' ? Number(job.progress) : 0.02} />
          <p className="text-xs text-muted">
            {job.status === 'waiting' ? `Nova tentativa em breve (${job.attempts}/${job.max_attempts}). ${job.error_message ?? ''}` : job.cancel_requested ? 'Cancelando…' : 'O tempo depende do provedor; você pode sair desta página.'}
          </p>
        </div>
      )}
      {job.status === 'failed' && <p className="text-sm text-danger">{job.error_message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {job.charged_credits != null ? `Cobrado: ${formatCredits(job.charged_credits)}` : `Reservado: ${formatCredits(job.estimated_credits)}`}
          {job.charged_credits != null && job.estimated_credits !== job.charged_credits && ` (estimado ${job.estimated_credits})`}
        </span>
        <div className="flex gap-2">
          {active && (
            <Button size="sm" variant="ghost" onClick={cancel} loading={busy} disabled={job.cancel_requested}>
              Cancelar
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'canceled') && onRetry && (
            <Button size="sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" /> Repetir
            </Button>
          )}
        </div>
      </div>
      {showOutputs && outputs.data && outputs.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {outputs.data.map((a) => (
            <div key={a.id} className="flex flex-col gap-2">
              {a.kind === 'video' || a.kind === 'audio' ? <MediaPreview asset={a} /> : <AssetThumb asset={a} />}
              <p className="truncate text-xs text-muted" title={a.name}>
                {a.kind === 'subtitle' ? 'Legenda (.srt) — ' : a.kind === 'video' ? 'Vídeo — ' : a.kind === 'audio' ? 'Áudio — ' : 'Imagem — '}
                {a.name}
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    window.location.href = await signedUrl(a.path, a.name.replace(/[^\w\-. ]+/g, '_') + '.' + a.path.split('.').pop());
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                <Download className="size-3.5" /> Baixar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Excluir "${a.name}" definitivamente?`)) return;
                  try {
                    await deleteAsset(a);
                    toast.success('Arquivo excluído.');
                    qc.invalidateQueries({ queryKey: ['assets'] });
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                <Trash2 className="size-3.5" /> Excluir
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
