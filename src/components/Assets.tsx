import { clsx } from 'clsx';
import { AlertTriangle, AudioLines, Bot, Check, FileText, Film, Image as ImageIcon, Loader2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatDuration } from '@shared/format';
import { useUserId } from '@/app/auth';
import { ACCEPT, uploadAsset } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePlan, useSettings, useSignedUrl } from '@/lib/hooks';
import type { Asset, AssetKind } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Progress } from './ui';

const KIND_ICON: Record<AssetKind, typeof Film> = { video: Film, image: ImageIcon, audio: AudioLines, subtitle: FileText, other: FileText };

export function AssetThumb({ asset, className }: { asset: Asset; className?: string }) {
  const url = useSignedUrl(asset.thumbnail_path ?? (asset.kind === 'image' && asset.probe_status === 'ok' ? asset.path : null));
  const Icon = KIND_ICON[asset.kind];
  return (
    <div className={clsx('relative grid aspect-video place-items-center overflow-hidden rounded-xl bg-surface-2', className)}>
      {url ? <img src={url} alt="" className="size-full object-cover" loading="lazy" /> : <Icon className="size-8 text-muted" />}
      {asset.probe_status === 'pending' && (
        <span className="absolute inset-0 grid place-items-center bg-black/50 text-xs text-white">
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" /> Analisando…
          </span>
        </span>
      )}
      {asset.probe_status === 'invalid' && (
        <span className="absolute inset-0 grid place-items-center bg-danger/70 p-2 text-center text-xs text-white">
          <span className="flex items-center gap-1">
            <AlertTriangle className="size-3.5" /> Inválido
          </span>
        </span>
      )}
      {asset.duration_s != null && asset.kind !== 'image' && (
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white">{formatDuration(Number(asset.duration_s))}</span>
      )}
      {asset.metadata?.synthetic && (
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white" title="Conteúdo gerado ou alterado por IA">
          <Bot className="size-3" /> IA
        </span>
      )}
    </div>
  );
}

export function AssetGrid({ assets, selected, onSelect, multi }: { assets: Asset[]; selected?: string[]; onSelect?: (a: Asset) => void; multi?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {assets.map((a) => {
        const isSel = selected?.includes(a.id);
        const disabled = a.probe_status !== 'ok';
        return (
          <button
            key={a.id}
            type="button"
            disabled={disabled && !!onSelect}
            onClick={() => onSelect?.(a)}
            className={clsx(
              'group relative flex flex-col gap-1.5 rounded-2xl border p-2 text-left transition',
              isSel ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-accent/50',
              disabled && onSelect && 'opacity-60',
            )}
          >
            <AssetThumb asset={a} />
            <span className="truncate px-1 text-xs">{a.name}</span>
            {isSel && (
              <span className="absolute right-3 top-3 grid size-6 place-items-center rounded-full bg-accent text-white">
                {multi ? (selected!.indexOf(a.id) + 1) : <Check className="size-4" />}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Envio de arquivo com validação, confirmação de direitos e progresso. */
export function UploadBox({
  kind,
  category = 'original',
  characterId,
  projectId,
  onUploaded,
  compact,
}: {
  kind: AssetKind;
  category?: 'original' | 'reference' | 'temp';
  characterId?: string | null;
  projectId?: string | null;
  onUploaded?: (a: Asset) => void;
  compact?: boolean;
}) {
  const userId = useUserId();
  const plan = usePlan();
  const settings = useSettings();
  const input = useRef<HTMLInputElement>(null);
  const [rights, setRights] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const qc = useQueryClient();
  const maxMb = Math.min(plan.data?.max_upload_mb ?? 100, Number(settings.data?.max_upload_mb ?? 200));
  const needsRights = kind === 'video';

  async function onFile(file: File | undefined) {
    if (!file) return;
    setProgress(0);
    try {
      const a = await uploadAsset(file, { userId, category, characterId, projectId, rightsConfirmed: rights, maxMb }, setProgress);
      toast.success('Arquivo enviado. A análise automática começou.');
      qc.invalidateQueries({ queryKey: ['assets'] });
      onUploaded?.(a);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div
      className={clsx('flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-surface-2/40', compact ? 'p-3' : 'p-5')}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (needsRights && !rights) return toast.error('Confirme primeiro que você tem direitos sobre o vídeo.');
        onFile(e.dataTransfer.files[0]);
      }}
    >
      {needsRights && (
        <Checkbox checked={rights} onChange={setRights}>
          Confirmo que este vídeo é meu ou que tenho autorização para usá-lo e modificá-lo, incluindo o direito de imagem das pessoas que aparecem nele.
        </Checkbox>
      )}
      <input ref={input} type="file" hidden accept={ACCEPT[kind]} onChange={(e) => onFile(e.target.files?.[0])} />
      {progress != null ? (
        <div className="flex flex-col gap-1.5">
          <Progress value={progress} />
          <span className="text-xs text-muted">Enviando… {Math.round(progress * 100)}%</span>
        </div>
      ) : (
        <Button onClick={() => input.current?.click()} disabled={needsRights && !rights}>
          <Upload className="size-4" /> Enviar {kind === 'video' ? 'vídeo' : kind === 'image' ? 'imagem' : kind === 'audio' ? 'áudio' : 'legenda (.srt)'}
        </Button>
      )}
      <p className="text-xs text-muted">
        Até {maxMb} MB. {kind === 'video' ? 'MP4, MOV, WebM ou MKV. Prefira vídeos curtos com uma pessoa claramente visível.' : ''}
        {kind === 'image' ? 'PNG, JPG ou WebP.' : ''}
        {kind === 'audio' ? 'MP3, WAV, M4A ou OGG. Use apenas músicas e efeitos licenciados.' : ''}
      </p>
    </div>
  );
}
