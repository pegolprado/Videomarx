/**
 * Modelos animados: HTML gerado e, quando há Chromium disponível
 * (MOTION_BROWSER ou /usr/bin/chromium), renderização real com o HyperFrames.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMotionHtml, planMotion, validateMotion } from '../../shared/motion.ts';
import type { MotionParams } from '../../shared/jobs.ts';
import { ffmpeg, probe } from '../src/ffmpeg.ts';
import { detectMotion, renderMotion } from '../src/providers/motion.ts';

const browser = process.env.MOTION_BROWSER || '/usr/bin/chromium';
const base: MotionParams = { template: 'kinetic', aspect: '9:16', palette: 'neon', title: 'Promoção <de> Verão', lines: ['Tudo com até 50% de desconto', 'Entrega grátis'], cta: 'Compre já!', seconds_per_item: 2 };

describe('composição', () => {
  it('planeja título, itens e chamada final', () => {
    const plan = planMotion(base, []);
    expect(plan.scenes.map((s) => s.kind)).toEqual(['title', 'item', 'item', 'cta']);
    expect(plan.duration).toBeCloseTo(2.6 + 4 + 2.6, 2);
    expect([plan.width, plan.height]).toEqual([720, 1280]);
  });

  it('repete imagens quando há mais frases e escapa HTML', () => {
    const { html, plan } = buildMotionHtml({ ...base, template: 'showcase', lines: ['a', 'b', 'c'] }, ['assets/img0.jpg']);
    expect(plan.scenes.filter((s) => s.image === 'assets/img0.jpg')).toHaveLength(4);
    expect(html).toContain('Promoção</span> <span class="w" id="s0w1">&lt;de&gt;');
    expect(html).not.toContain('<de>');
    expect(html).toContain('window.__timelines["main"] = tl');
    expect(html).not.toMatch(/Math\.random|Date\.now|repeat:\s*-1/);
  });

  it('valida o pedido', () => {
    expect(validateMotion({ ...base, template: 'showcase' }, 0)).toMatch(/imagem/);
    expect(validateMotion({ ...base, title: '', lines: [] }, 0)).toMatch(/título/);
    expect(validateMotion(base, 0)).toBeNull();
  });
});

const hasBrowser = existsSync(browser);
describe.skipIf(!hasBrowser)('renderização real (HyperFrames + Chromium)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'videoai-motion-'));
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', join(dir, 'a.jpg')]);
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detecta o motor', async () => {
    expect(await detectMotion({ motionBrowser: browser })).toBe(true);
  });

  for (const template of ['kinetic', 'showcase', 'launch'] as const) {
    it(`renderiza o modelo ${template}`, async () => {
      const proj = join(dir, template);
      mkdirSync(join(proj, 'assets'), { recursive: true });
      copyFileSync(join(dir, 'a.jpg'), join(proj, 'assets', 'img0.jpg'));
      const aspect = template === 'launch' ? '16:9' : '9:16';
      const { html, plan } = buildMotionHtml({ ...base, template, aspect, lines: ['Frase um', 'Frase dois'] }, ['assets/img0.jpg']);
      const out = join(dir, `${template}.mp4`);
      await renderMotion({ dir: proj, html, output: out, browser });
      const info = await probe(out);
      expect(info.kind).toBe('video');
      expect(info.duration).toBeGreaterThan(plan.duration - 0.3);
      expect([info.width, info.height]).toEqual(aspect === '16:9' ? [1280, 720] : [720, 1280]);
      if (process.env.MOTION_KEEP) copyFileSync(out, join(process.env.MOTION_KEEP, `${template}.mp4`));
    }, 240_000);
  }
});
