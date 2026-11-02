/**
 * Motor próprio: IA aberta rodando no nosso servidor, sem provedor pago.
 *  - Whisper (whisper.cpp, licença MIT; modelos da OpenAI, MIT): fala → legendas
 *  - Piper (MIT): texto → voz; cada voz tem a sua licença (ver docs/MOTOR_PROPRIO.md)
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../ffmpeg.ts';
import { JobError } from '../errors.ts';
import type { Config } from '../config.ts';

export interface LocalCapabilities {
  transcribe: boolean;
  tts: boolean;
  voices: string[];
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function detectLocal(config: Config): Promise<LocalCapabilities> {
  const transcribe = (await exists(config.whisperBin)) && (await exists(config.whisperModel));
  let voices: string[] = [];
  if (await exists(config.piperBin)) {
    const files = await readdir(config.voicesDir).catch(() => [] as string[]);
    voices = files
      .filter((f) => f.endsWith('.onnx') && files.includes(`${f}.json`))
      .map((f) => f.replace(/\.onnx$/, ''))
      .sort();
  }
  return { transcribe, tts: voices.length > 0, voices };
}

/** Transcreve um WAV 16 kHz mono e devolve o conteúdo .srt gerado pelo Whisper. */
export async function whisperSrt(config: Config, wav: string, outBase: string, opts: { language: string; maxLine: number }): Promise<string> {
  const args = ['-m', config.whisperModel, '-f', wav, '-l', opts.language, '-t', String(config.localThreads), '-osrt', '-of', outBase, '-np'];
  if (opts.maxLine > 0) args.push('-ml', String(opts.maxLine), '-sow');
  try {
    await run(config.whisperBin, args, 60 * 60_000);
  } catch (e) {
    throw new JobError('transcribe_failed', `Falha nas legendas automáticas: ${(e as Error).message}`);
  }
  return readFile(`${outBase}.srt`, 'utf8');
}

/** Sintetiza fala com o Piper (texto pela entrada padrão) e grava um WAV. */
export async function piperSpeak(config: Config, voice: string, text: string, outWav: string, speed = 1): Promise<void> {
  const model = join(config.voicesDir, `${voice}.onnx`);
  if (!/^[A-Za-z0-9_.-]+$/.test(voice) || !(await exists(model))) throw new JobError('invalid_params', 'Voz indisponível neste servidor.');
  const lengthScale = (1 / Math.min(Math.max(speed, 0.5), 2)).toFixed(3);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(config.piperBin, ['--model', model, '--output_file', outWav, '--length_scale', lengthScale], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), 20 * 60_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new JobError('tts_failed', `Falha ao gerar a voz: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new JobError('tts_failed', `Falha ao gerar a voz (código ${code}): ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`));
    });
    p.stdin.end(text);
  });
}

/** Converte qualquer áudio/vídeo para o formato que o Whisper espera. */
export async function toWhisperWav(input: string, output: string): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output]);
}
