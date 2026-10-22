/**
 * Integração real com o FFmpeg: gera vídeos de teste (lavfi) e executa os
 * mesmos argumentos usados em produção.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportArgs, concatFilter, selectSegmentsFilter, speechSegments } from '../../shared/ffmpeg.ts';
import { estimateCues, toSrt } from '../../shared/srt.ts';
import { ffmpeg, frameAt, prepareClip, probe, parseProbe } from '../src/ffmpeg.ts';

let dir: string;
const p = (f: string) => join(dir, f);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'videoai-ff-'));
  // 6 s, 640x360 com áudio: tom (0–2 s), silêncio (2–4 s), tom (4–6 s)
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0,0.5*sin(440*2*PI*t))':s=48000:d=6",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('a.mp4')]);
  // 3 s vertical sem áudio
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('b.mp4')]);
  writeFileSync(p('img.png'), Buffer.alloc(0));
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', p('img.png')]);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ffprobe', () => {
  it('identifica vídeo, áudio, imagem e arquivo inválido', async () => {
    const a = await probe(p('a.mp4'));
    expect(a).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: true });
    expect(a.duration).toBeCloseTo(6, 0);
    const b = await probe(p('b.mp4'));
    expect(b.hasAudio).toBe(false);
    expect((await probe(p('img.png'))).kind).toBe('image');
    writeFileSync(p('lixo.mp4'), 'não é vídeo');
    await expect(probe(p('lixo.mp4'))).rejects.toThrow(/inválido/);
  });
  it('ignora capa embutida (attached_pic) em arquivos de áudio', () => {
    const info = parseProbe(JSON.stringify({ format: { format_name: 'mp3', duration: '3.0' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', disposition: { attached_pic: 1 } }] }));
    expect(info.kind).toBe('audio');
  });
});

describe('exportação', () => {
  it('corta, converte para 9:16, incorpora legenda e texto', async () => {
    writeFileSync(p('leg.srt'), toSrt(estimateCues('Olá! Este é um teste de legenda incorporada.', 4)));
    const plan = buildExportArgs(p('a.mp4'), p('out.mp4'), {
      aspect: '9:16', resolution: 720, fit: 'crop', quality: 'economy', trim_start: 1, trim_end: 5, fade_audio: true,
      text_overlay: { text: 'Título: 100% teste', position: 'top' }, color: { saturation: 1.2 },
    }, { duration: 6, hasAudio: true }, { subtitlePath: p('leg.srt'), fontFile: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', syntheticNote: 'IA' });
    await ffmpeg(plan.args);
    const out = await probe(p('out.mp4'));
    expect(out).toMatchObject({ width: 720, height: 1280, hasAudio: true, videoCodec: 'h264' });
    expect(out.duration).toBeCloseTo(4, 0);
  }, 60_000);
  it('acelera 2x e exporta quadrado sem áudio', async () => {
    const plan = buildExportArgs(p('a.mp4'), p('fast.mp4'), { aspect: '1:1', resolution: 720, fit: 'pad', quality: 'high', speed: 2, mute: true }, { duration: 6, hasAudio: true });
    await ffmpeg(plan.args);
    const out = await probe(p('fast.mp4'));
    expect(out).toMatchObject({ width: 720, height: 720, hasAudio: false });
    expect(out.duration).toBeCloseTo(3, 0);
  }, 60_000);
});

describe('montagem e corte automático', () => {
  it('une clipes de formatos diferentes com transição', async () => {
    const plan = concatFilter([{ duration: 6, hasAudio: true }, { duration: 3, hasAudio: false }], '16:9', 720, 'fade', 0.5);
    await ffmpeg(['-y', '-i', p('a.mp4'), '-i', p('b.mp4'), '-filter_complex', plan.filter, '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', plan.duration.toFixed(3), p('seq.mp4')]);
    const out = await probe(p('seq.mp4'));
    expect(out).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    expect(out.duration).toBeCloseTo(8.5, 0);
  }, 60_000);
  it('remove a pausa de 2 s', async () => {
    const { stderr } = await ffmpeg(['-i', p('a.mp4'), '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-']);
    const segs = speechSegments(stderr, 6, 0.1);
    expect(segs).toHaveLength(2);
    writeFileSync(p('sel.txt'), selectSegmentsFilter(segs, true));
    await ffmpeg(['-y', '-i', p('a.mp4'), '-filter_complex_script', p('sel.txt'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', p('cut.mp4')]);
    const out = await probe(p('cut.mp4'));
    expect(out.duration!).toBeGreaterThan(3.8);
    expect(out.duration!).toBeLessThan(4.8);
  }, 60_000);
  it('prepara trecho para o provedor e extrai quadro', async () => {
    await prepareClip(p('a.mp4'), p('clip.mp4'), 1, 3, true);
    const clip = await probe(p('clip.mp4'));
    expect(clip.duration).toBeCloseTo(3, 0);
    await frameAt(p('clip.mp4'), p('f.jpg'), 0, 320);
    expect((await probe(p('f.jpg'))).width).toBe(320);
  }, 60_000);
});
