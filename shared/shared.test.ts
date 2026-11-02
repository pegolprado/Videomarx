import { describe, expect, it } from 'vitest';
import { availableModes, integrationStatus, qualityWarnings, TRANSFORM_MODES } from './transform';
import { characterDescriptor, characterImagePrompt, clampPrompt, scenePrompt, splitNarration, splitScriptLocally, styledImagePrompt } from './prompt';
import { estimateCues, formatSrtTime, parseSrt, toSrt } from './srt';
import { atempoChain, buildExportArgs, concatFilter, fitFilter, slideDurations, slideshowFilter, speechSegments, syncedSlideDurations, targetSize } from './ffmpeg';
import { ratioFor } from './ratios';
import { estimateFileSizeBytes, formatDuration } from './format';
import type { Capabilities } from './capabilities';
import { piperVoiceLabel } from './voices';

const caps = (over: Partial<Capabilities['integrations'][string]> = {}, online = true): Capabilities => ({
  worker_online: online,
  integrations: {
    runway: { label: 'Runway', description: '', enabled: true, configured: true, ...over },
    ffmpeg: { label: 'FFmpeg', description: '', enabled: true, configured: true },
  },
});

describe('modos de transformação', () => {
  it('A e B ficam indisponíveis: nenhuma integração os executa', () => {
    const m = availableModes(caps());
    expect(m.find((x) => x.mode.id === 'face_swap')?.available).toBe(false);
    expect(m.find((x) => x.mode.id === 'head')?.available).toBe(false);
    expect(m.find((x) => x.mode.id === 'full_body')?.available).toBe(true);
  });
  it('nada fica disponível sem chave configurada, com integração desligada ou worker offline', () => {
    expect(availableModes(caps({ configured: false })).every((x) => !x.available)).toBe(true);
    expect(availableModes(caps({ enabled: false })).every((x) => !x.available)).toBe(true);
    expect(availableModes(caps({}, false)).every((x) => !x.available)).toBe(true);
    expect(integrationStatus(undefined, 'runway').ok).toBe(false);
  });
  it('todo modo tem letra única', () => {
    expect(new Set(TRANSFORM_MODES.map((m) => m.letter)).size).toBe(TRANSFORM_MODES.length);
  });
  it('avisos de qualidade', () => {
    const w = qualityWarnings({ multiplePeople: true, partiallyHidden: false, fastMotion: true, faceNotVisible: true }, 'full_body');
    expect(w).toHaveLength(3);
    expect(qualityWarnings({ multiplePeople: false, partiallyHidden: false, fastMotion: false, faceNotVisible: true }, 'stylized')).toHaveLength(0);
  });
});

describe('prompts', () => {
  const luna = {
    name: 'Luna',
    kind: 'anime',
    description: 'jovem exploradora espacial',
    appearance: { hair: 'curto prateado', eyes: 'violeta', outfit: 'traje espacial branco' },
    custom_instructions: 'sempre com um broche de estrela',
  };
  it('descrição persistente inclui estilo e aparência', () => {
    const d = characterDescriptor(luna);
    expect(d).toContain('anime style');
    expect(d).toContain('hair: curto prateado');
    expect(d).toContain('broche de estrela');
  });
  it('usa a tag de referência quando há imagem', () => {
    expect(characterImagePrompt(luna, 'front', '', true)).toMatch(/^@char/);
    expect(characterImagePrompt(luna, 'front', '', false)).not.toContain('@char');
  });
  it('respeita o limite de 1000 caracteres sem cortar palavra', () => {
    const p = clampPrompt('palavra '.repeat(400));
    expect(p.length).toBeLessThanOrEqual(1000);
    expect(p.endsWith('palavra')).toBe(true);
    const s = scenePrompt({ description: 'x '.repeat(900), camera: 'tracking' }, luna);
    expect(s.length).toBeLessThanOrEqual(1000);
  });
  it('organiza a cena', () => {
    const s = scenePrompt({ description: 'caminha pela rua à noite', camera: 'acompanha', lighting: 'neon', motion: 'low' }, luna, true);
    expect(s).toContain('The character from the image');
    expect(s).toContain('Camera: acompanha');
    expect(s).toContain('subtle');
  });
  it('divide roteiro em cenas curtas', () => {
    const scenes = splitScriptLocally('Primeira cena curta.\n\nSegunda. ' + 'Frase longa de teste. '.repeat(20), 120);
    expect(scenes[0]).toBe('Primeira cena curta.');
    expect(scenes.length).toBeGreaterThan(3);
    expect(scenes.every((s) => s.length <= 120)).toBe(true);
  });
});

describe('legendas', () => {
  it('formata tempo SRT', () => {
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });
  it('estima legendas cobrindo toda a duração e faz ida e volta', () => {
    const cues = estimateCues('Olá, eu sou a Luna. Hoje vou mostrar um truque incrível para você aprender rapidinho.', 10);
    expect(cues[0].start).toBe(0);
    expect(cues[cues.length - 1].end).toBe(10);
    expect(cues.every((c) => c.text.length <= 42)).toBe(true);
    const parsed = parseSrt(toSrt(cues));
    expect(parsed).toHaveLength(cues.length);
    expect(parsed[1].text).toBe(cues[1].text);
  });
  it('ignora blocos inválidos', () => {
    expect(parseSrt('lixo\n\n1\n00:00:02,000 --> 00:00:01,000\nx')).toHaveLength(0);
  });
});

describe('ffmpeg', () => {
  it('tamanhos de destino', () => {
    expect(targetSize('9:16', 1080)).toEqual({ w: 1080, h: 1920 });
    expect(targetSize('16:9', 720)).toEqual({ w: 1280, h: 720 });
    expect(targetSize('1:1', 720)).toEqual({ w: 720, h: 720 });
    expect(fitFilter('9:16', 720, 'crop')).toContain('crop=720:1280');
    expect(fitFilter('16:9', 720, 'pad')).toContain('pad=1280:720');
  });
  it('atempo encadeado fora de 0.5–2', () => {
    expect(atempoChain(4)).toBe('atempo=2.0,atempo=2.0000');
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5000');
  });
  it('exportação com corte, velocidade, legenda e metadado sintético', () => {
    const plan = buildExportArgs(
      '/in.mp4',
      '/out.mp4',
      { aspect: '9:16', resolution: 1080, fit: 'crop', quality: 'economy', trim_start: 2, trim_end: 8, speed: 2, fade_audio: true },
      { duration: 10, hasAudio: true },
      { subtitlePath: '/tmp/a:b.srt', syntheticNote: 'IA' },
    );
    expect(plan.durationOut).toBe(3);
    expect(plan.args).toContain('-ss');
    expect(plan.args.join(' ')).toContain("subtitles='/tmp/a\\:b.srt'");
    expect(plan.args.join(' ')).toContain('atempo=2');
    expect(plan.args).toContain('comment=IA');
    const muted = buildExportArgs('/in.mp4', '/o.mp4', { aspect: '1:1', resolution: 720, fit: 'pad', quality: 'high' }, { duration: 5, hasAudio: false });
    expect(muted.args).toContain('-an');
  });
  it('detecta trechos com fala a partir do silencedetect', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: 2.0',
      '[silencedetect @ 0x1] silence_end: 4.0 | silence_duration: 2.0',
      '[silencedetect @ 0x1] silence_start: 8.5',
    ].join('\n');
    expect(speechSegments(log, 10, 0.1, 0.3)).toEqual([
      { start: 0, end: 2.1 },
      { start: 3.9, end: 8.6 },
    ]);
  });
  it('concatenação com transição desconta a sobreposição', () => {
    const r = concatFilter([{ duration: 4, hasAudio: true }, { duration: 4, hasAudio: false }, { duration: 4, hasAudio: true }], '9:16', 720, 'fade', 0.5);
    expect(r.duration).toBe(11);
    expect(r.filter).toContain('xfade');
    expect(r.filter).toContain('anullsrc');
    expect(concatFilter([{ duration: 3, hasAudio: true }, { duration: 2, hasAudio: true }], '1:1', 720, 'none').filter).toContain('concat=n=2');
  });
});

describe('formatos', () => {
  it('ratios por modelo', () => {
    expect(ratioFor('gen4.5', '1:1', true)).toBeNull();
    expect(ratioFor('gen4.5', '1:1', false)).toBe('960:960');
    expect(ratioFor('veo3.1', '9:16', true)).toBe('1080:1920');
  });
  it('formatação', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(estimateFileSizeBytes(10, 1080, 'economy')).toBe(5_160_000);
  });
});

describe('vozes do motor próprio', () => {
  it('nome amigável', () => {
    expect(piperVoiceLabel('pt_BR-faber-medium')).toBe('Faber (pt-BR, média)');
    expect(piperVoiceLabel('estranho')).toBe('estranho');
  });
});

describe('vídeo animado', () => {
  it('divide a narração entre as imagens', () => {
    const d = slideDurations(3, { audioSeconds: 12, transition: 0.6 });
    expect(d.reduce((a, b) => a + b, 0) - 0.6 * 2).toBeCloseTo(12, 2);
    expect(slideDurations(2, { secondsPerImage: 100, transition: 0.6 })).toEqual([20, 20]);
    expect(slideDurations(0, { transition: 0.6 })).toEqual([]);
  });
  it('alterna movimentos e une com fade', () => {
    const r = slideshowFilter([4, 4, 4], '9:16', 720);
    expect(r.duration).toBeCloseTo(10.8, 3);
    expect(r.filter).toContain('zoompan');
    expect(r.filter.match(/xfade/g)).toHaveLength(2);
    expect(r.filter).toContain('s=720x1280');
    expect(slideshowFilter([3], '1:1', 720).filter).toContain('[s0]null[vout]');
  });
});

describe('vídeo automático', () => {
  it('imagem troca quando a narração da próxima cena começa', () => {
    const d = syncedSlideDurations([3, 5, 2], 0.6);
    expect(d).toEqual([3.6, 5.6, 2]);
    // início de cada cena no vídeo = soma dos áudios anteriores
    expect(d[0] - 0.6).toBeCloseTo(3, 5);
    expect(d.reduce((a, b) => a + b, 0) - 0.6 * 2).toBeCloseTo(10, 5);
  });
  it('estilo e personagem entram em todas as imagens', () => {
    const p = styledImagePrompt('a cat on a roof', 'anime', { name: 'Luna', kind: 'anime', description: 'girl', appearance: {} });
    expect(p).toContain('anime illustration');
    expect(p).toContain('a cat on a roof');
    expect(p).toContain('no text');
  });
  it('divide por parágrafo, linha ou frase', () => {
    const t = 'Primeira linha. Segunda frase!\nTerceira linha\n\nNovo parágrafo.';
    expect(splitNarration(t, 'paragraph')).toHaveLength(2);
    expect(splitNarration(t, 'line')).toEqual(['Primeira linha. Segunda frase!', 'Terceira linha', 'Novo parágrafo.']);
    expect(splitNarration(t, 'sentence')).toHaveLength(4);
  });
});
