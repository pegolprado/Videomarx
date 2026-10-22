import { useSignedUrl } from '@/lib/hooks';
import type { Asset } from '@/lib/types';

export function MediaPreview({ asset, className }: { asset: Asset; className?: string }) {
  const url = useSignedUrl(asset.probe_status === 'invalid' ? null : asset.path);
  const poster = useSignedUrl(asset.thumbnail_path);
  if (!url) return <div className="aspect-video animate-pulse rounded-xl bg-surface-2" />;
  if (asset.kind === 'audio') return <audio controls src={url} className="w-full" preload="metadata" />;
  if (asset.kind === 'image') return <img src={url} alt={asset.name} className={className ?? 'max-h-[60vh] w-full rounded-xl object-contain'} />;
  return <video controls playsInline src={url} poster={poster ?? undefined} preload="metadata" className={className ?? 'max-h-[60vh] w-full rounded-xl bg-black'} />;
}
