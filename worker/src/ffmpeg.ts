import { spawn } from 'node:child_process';
import { JobError } from './errors.ts';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], timeoutMs = 30 * 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new JobError('ffmpeg_failed', `Falha no processamento de mídia (${cmd} ${code}): ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

export const ffmpeg = (args: string[]) => run('ffmpeg', ['-hide_banner', '-nostdin', ...args]);

export interface ProbeInfo {
  kind: 'video' | 'audio' | 'image' | 'unknown';
  format: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  sizeBytes: number | null;
}

const IMAGE_FORMATS = ['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2'];

export async function probe(path: string): Promise<ProbeInfo> {
  let out: RunResult;
  try {
    out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], 60_000);
  } catch {
    throw new JobError('invalid_file', 'Arquivo inválido ou corrompido: não foi possível ler o conteúdo.');
  }
  return parseProbe(out.stdout);
}

export function parseProbe(json: string): ProbeInfo {
  const data = JSON.parse(json) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } }[];
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = data.format?.format_name ?? '';
  const durationRaw = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
  const [n, d] = (video?.avg_frame_rate ?? '0/0').split('/').map(Number);
  const fps = d ? Math.round((n / d) * 1000) / 1000 : null;
  const isImage = !!video && (IMAGE_FORMATS.includes(format) || (!duration && !audio));
  return {
    kind: isImage ? 'image' : video ? 'video' : audio ? 'audio' : 'unknown',
    format,
    duration: isImage ? null : duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: isImage ? null : fps,
    hasAudio: !!audio,
    videoCodec: video?.codec_name ?? null,
    sizeBytes: data.format?.size ? Number(data.format.size) : null,
  };
}

/** Quadro em JPEG num instante (miniaturas e prévias). */
export async function frameAt(input: string, output: string, seconds: number, width = 480): Promise<void> {
  await ffmpeg(['-y', '-ss', Math.max(0, seconds).toFixed(3), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', output]);
}

/**
 * Prepara um trecho para envio ao provedor: corta, limita a 720p e
 * converte para H.264/AAC (arquivo pequeno e compatível).
 */
export async function prepareClip(input: string, output: string, start: number, duration: number, hasAudio: boolean): Promise<void> {
  const args = ['-y', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart'];
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push(output);
  await ffmpeg(args);
}
