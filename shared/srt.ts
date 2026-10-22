/** Legendas .srt: geração estimada a partir de um texto conhecido e leitura. */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`).join('\n');
}

export function parseSrt(text: string): Cue[] {
  const toSec = (t: string) => {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
  };
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const start = toSec(a);
    const end = toSec(b);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    cues.push({ start, end, text: lines.slice(timeIdx + 1).join('\n') });
  }
  return cues;
}

/**
 * Distribui o texto ao longo da duração, proporcional ao número de
 * caracteres de cada trecho. É uma ESTIMATIVA (sem reconhecimento de fala).
 */
export function estimateCues(text: string, durationSec: number, maxChars = 42): Cue[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || durationSec <= 0) return [];
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      chunks.push(cur);
      cur = w;
    } else {
      cur = next;
    }
    if (/[.!?…]$/.test(w) && cur.length > maxChars / 2) {
      chunks.push(cur);
      cur = '';
    }
  }
  if (cur) chunks.push(cur);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let t = 0;
  return chunks.map((c, i) => {
    const d = (c.length / total) * durationSec;
    const cue = { start: t, end: i === chunks.length - 1 ? durationSec : t + d, text: c };
    t += d;
    return cue;
  });
}
