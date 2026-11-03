/**
 * Renderização dos modelos animados com o HyperFrames (CLI oficial, Apache 2.0)
 * usando o Chromium do sistema. Roda no nosso servidor, sem custo por uso.
 */
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { JobError } from '../errors.ts';
import { run } from '../ffmpeg.ts';
import type { Config } from '../config.ts';

const require = createRequire(import.meta.url);

export function hyperframesCli(): string {
  return join(dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
}

export function gsapFile(): string {
  return join(dirname(require.resolve('gsap/package.json')), 'dist', 'gsap.min.js');
}

/** Disponível quando o pacote e o navegador existem neste servidor. */
export async function detectMotion(config: Pick<Config, 'motionBrowser'>): Promise<boolean> {
  try {
    await access(hyperframesCli());
    await access(gsapFile());
    await access(config.motionBrowser);
    return true;
  } catch {
    return false;
  }
}

/** Escreve o projeto (index.html + assets) e renderiza em MP4. */
export async function renderMotion(opts: { dir: string; html: string; output: string; browser: string; timeoutMs?: number }): Promise<void> {
  await mkdir(join(opts.dir, 'assets'), { recursive: true });
  await copyFile(gsapFile(), join(opts.dir, 'assets', 'gsap.min.js'));
  await writeFile(join(opts.dir, 'index.html'), opts.html);
  try {
    await run(
      process.execPath,
      [hyperframesCli(), 'render', opts.dir, '-o', opts.output, '--workers', '1', '--low-memory-mode', '--crf', '23', '--quiet', '--no-browser-gpu'],
      opts.timeoutMs ?? 20 * 60_000,
      {
        env: {
          ...process.env,
          HYPERFRAMES_BROWSER_PATH: opts.browser,
          HYPERFRAMES_NO_TELEMETRY: '1',
          HYPERFRAMES_SKIP_SKILLS: '1',
          HYPERFRAMES_NO_UPDATE_CHECK: '1',
          CI: '1',
        },
        cwd: opts.dir,
      },
    );
  } catch (e) {
    const msg = (e as Error).message ?? '';
    throw new JobError('render_failed', `Não foi possível montar o vídeo animado: ${msg.slice(-400)}`);
  }
}
