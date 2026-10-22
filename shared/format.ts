export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatCredits(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toLocaleString('pt-BR')} crédito${n === 1 ? '' : 's'}`;
}

/** Tamanho aproximado de um MP4 a partir da taxa de bits alvo. */
export function estimateFileSizeBytes(seconds: number, resolution: 720 | 1080, quality: 'economy' | 'high'): number {
  const videoKbps = resolution === 1080 ? (quality === 'high' ? 8000 : 4000) : quality === 'high' ? 5000 : 2500;
  const audioKbps = 128;
  return Math.round(((videoKbps + audioKbps) * 1000 * seconds) / 8);
}
