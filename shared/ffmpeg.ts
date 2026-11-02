/**
 * Construção de filtros/argumentos do FFmpeg (funções puras, testadas).
 * Execução fica no worker.
 */
import type { Aspect, ExportParams, SlideMotion } from './jobs';

export function targetSize(aspect: Aspect, resolution: 720 | 1080): { w: number; h: number } {
  const short = resolution;
  const long = Math.round((short * 16) / 9 / 2) * 2;
  if (aspect === '9:16') return { w: short, h: long };
  if (aspect === '16:9') return { w: long, h: short };
  return { w: short, h: short };
}

/** Ajusta para o formato de destino recortando (crop) ou com barras (pad). */
export function fitFilter(aspect: Aspect, resolution: 720 | 1080, fit: 'crop' | 'pad'): string {
  const { w, h } = targetSize(aspect, resolution);
  if (fit === 'crop') {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function escapeDrawtext(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%');
}

export interface ExportPlan {
  args: string[];
  durationOut: number;
}

/**
 * Argumentos completos de exportação para MP4 (H.264 + AAC), com aviso de
 * conteúdo sintético nos metadados.
 */
export function buildExportArgs(
  input: string,
  output: string,
  p: ExportParams,
  source: { duration: number; hasAudio: boolean },
  opts: { subtitlePath?: string; fontFile?: string; syntheticNote?: string } = {},
): ExportPlan {
  const start = Math.max(0, p.trim_start ?? 0);
  const end = Math.min(source.duration, p.trim_end ?? source.duration);
  const clip = Math.max(0.1, end - start);
  const speed = p.speed && p.speed > 0 ? Math.min(Math.max(p.speed, 0.25), 4) : 1;
  const durationOut = clip / speed;

  const v: string[] = [fitFilter(p.aspect, p.resolution, p.fit)];
  if (speed !== 1) v.push(`setpts=PTS/${speed}`);
  if (p.color) {
    const b = p.color.brightness ?? 0;
    const c = p.color.contrast ?? 1;
    const s = p.color.saturation ?? 1;
    if (b !== 0 || c !== 1 || s !== 1) v.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
  }
  if (opts.subtitlePath) {
    v.push(`subtitles='${escapeFilterPath(opts.subtitlePath)}':force_style='FontSize=14,Outline=2,MarginV=40'`);
  }
  if (p.text_overlay?.text && opts.fontFile) {
    const y = p.text_overlay.position === 'top' ? 'h*0.08' : p.text_overlay.position === 'center' ? '(h-text_h)/2' : 'h*0.85';
    v.push(
      `drawtext=fontfile='${escapeFilterPath(opts.fontFile)}':text='${escapeDrawtext(p.text_overlay.text)}':fontcolor=white:fontsize=h/22:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${y}`,
    );
  }
  v.push('format=yuv420p');

  const a: string[] = [];
  if (source.hasAudio && !p.mute) {
    if (speed !== 1) a.push(atempoChain(speed));
    if (p.volume != null && p.volume !== 1) a.push(`volume=${Math.min(Math.max(p.volume, 0), 3)}`);
    if (p.fade_audio) {
      const f = Math.min(1, durationOut / 4);
      a.push(`afade=t=in:d=${f.toFixed(2)}`, `afade=t=out:st=${Math.max(0, durationOut - f).toFixed(2)}:d=${f.toFixed(2)}`);
    }
  }

  const crf = p.quality === 'high' ? '19' : '26';
  const args = ['-y', '-ss', start.toFixed(3), '-t', clip.toFixed(3), '-i', input, '-vf', v.join(',')];
  if (source.hasAudio && !p.mute) {
    if (a.length) args.push('-af', a.join(','));
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push('-c:v', 'libx264', '-preset', p.quality === 'high' ? 'slow' : 'veryfast', '-crf', crf, '-movflags', '+faststart');
  if (opts.syntheticNote) args.push('-metadata', `comment=${opts.syntheticNote}`);
  args.push(output);
  return { args, durationOut };
}

/** atempo aceita 0.5–2.0 por estágio; encadeia para outros valores. */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s > 2) {
    parts.push('atempo=2.0');
    s /= 2;
  }
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

/**
 * Lê a saída do filtro silencedetect e devolve os trechos COM fala a manter.
 */
export function speechSegments(
  silencedetectLog: string,
  duration: number,
  padding = 0.15,
  minKeep = 0.3,
): { start: number; end: number }[] {
  const silences: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of silencedetectLog.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open != null) {
      silences.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open != null) silences.push({ start: open, end: duration });

  const keep: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const sil of silences) {
    const segEnd = Math.min(duration, sil.start + padding);
    if (segEnd - cursor >= minKeep) keep.push({ start: cursor, end: segEnd });
    cursor = Math.max(cursor, sil.end - padding);
  }
  if (duration - cursor >= minKeep) keep.push({ start: cursor, end: duration });
  // une trechos que se sobrepõem por causa da margem
  const merged: { start: number; end: number }[] = [];
  for (const k of keep) {
    const last = merged[merged.length - 1];
    if (last && k.start <= last.end) last.end = Math.max(last.end, k.end);
    else merged.push({ ...k });
  }
  return merged.map((k) => ({ start: round3(k.start), end: round3(k.end) }));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** Filtro para manter só os trechos (vídeo + áudio). */
export function selectSegmentsFilter(segments: { start: number; end: number }[], hasAudio: boolean): string {
  const expr = segments.map((s) => `between(t,${s.start},${s.end})`).join('+');
  const v = `[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[v]`;
  return hasAudio ? `${v};[0:a]aselect='${expr}',asetpts=N/SR/TB[a]` : v;
}

/** Concatenação com normalização e transição opcional (xfade/acrossfade). */
export function concatFilter(
  clips: { duration: number; hasAudio: boolean }[],
  aspect: Aspect,
  resolution: 720 | 1080,
  transition: 'none' | 'fade',
  td = 0.5,
): { filter: string; duration: number } {
  const fit = fitFilter(aspect, resolution, 'pad');
  const parts: string[] = [];
  clips.forEach((c, i) => {
    parts.push(`[${i}:v]${fit},fps=30,format=yuv420p[v${i}]`);
    parts.push(
      c.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${c.duration.toFixed(3)}[a${i}]`,
    );
  });
  if (clips.length === 1) {
    parts.push('[v0]null[vout]', '[a0]anull[aout]');
    return { filter: parts.join(';'), duration: clips[0].duration };
  }
  if (transition === 'none') {
    parts.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
    return { filter: parts.join(';'), duration: clips.reduce((n, c) => n + c.duration, 0) };
  }
  const t = Math.min(td, ...clips.map((c) => c.duration / 2));
  let offset = 0;
  let vPrev = 'v0';
  let aPrev = 'a0';
  for (let i = 1; i < clips.length; i++) {
    offset += clips[i - 1].duration - t;
    const vOut = i === clips.length - 1 ? 'vout' : `vx${i}`;
    const aOut = i === clips.length - 1 ? 'aout' : `ax${i}`;
    parts.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
    parts.push(`[${aPrev}][a${i}]acrossfade=d=${t.toFixed(3)}[${aOut}]`);
    vPrev = vOut;
    aPrev = aOut;
  }
  const duration = clips.reduce((n, c) => n + c.duration, 0) - t * (clips.length - 1);
  return { filter: parts.join(';'), duration };
}

const AUTO_MOTIONS: SlideMotion[] = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'];

/**
 * Duração de cada imagem: com narração, as imagens dividem a duração do
 * áudio (descontando a sobreposição das transições); sem narração, valor fixo.
 */
export function slideDurations(count: number, opts: { audioSeconds?: number | null; secondsPerImage?: number; transition: number }): number[] {
  if (count < 1) return [];
  const t = count > 1 ? opts.transition : 0;
  const each = opts.audioSeconds && opts.audioSeconds > 0
    ? (opts.audioSeconds + t * (count - 1)) / count
    : Math.min(Math.max(opts.secondsPerImage ?? 4, 1.5), 20);
  return Array.from({ length: count }, () => Math.max(Math.round(each * 1000) / 1000, t + 0.5));
}

/**
 * Filtro do vídeo animado: cada imagem vira um clipe com movimento de câmera
 * (zoompan sobre a imagem ampliada, para ficar suave) e os clipes são unidos
 * com fade. Entradas: imagens nos índices 0..n-1. Saída: [vout].
 */
export function slideshowFilter(
  durations: number[],
  aspect: Aspect,
  resolution: 720 | 1080,
  motion: SlideMotion | 'auto' = 'auto',
  transition: 'fade' | 'none' = 'fade',
  td = 0.6,
  fps = 30,
): { filter: string; duration: number } {
  const { w, h } = targetSize(aspect, resolution);
  const W = w * 2;
  const H = h * 2;
  const parts: string[] = [];
  durations.forEach((d, i) => {
    const frames = Math.max(1, Math.round(d * fps));
    const m = motion === 'auto' ? AUTO_MOTIONS[i % AUTO_MOTIONS.length] : motion;
    const step = (0.25 / frames).toFixed(6);
    const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    const zp =
      m === 'zoom_in' ? `z='min(1+${step}*on,1.25)':${center}`
      : m === 'zoom_out' ? `z='max(1.25-${step}*on,1)':${center}`
      : m === 'pan_right' ? `z='1.2':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`
      : `z='1.2':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`;
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=${zp}:d=${frames}:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p,trim=duration=${d.toFixed(3)}[s${i}]`);
  });
  const n = durations.length;
  const total = durations.reduce((a, b) => a + b, 0);
  if (n === 1) {
    parts.push('[s0]null[vout]');
    return { filter: parts.join(';'), duration: total };
  }
  if (transition === 'none') {
    parts.push(`${durations.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=1:a=0[vout]`);
    return { filter: parts.join(';'), duration: total };
  }
  let offset = 0;
  let prev = 's0';
  for (let i = 1; i < n; i++) {
    offset += durations[i - 1] - td;
    const out = i === n - 1 ? 'vout' : `x${i}`;
    parts.push(`[${prev}][s${i}]xfade=transition=fade:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`);
    prev = out;
  }
  return { filter: parts.join(';'), duration: total - td * (n - 1) };
}
