/**
 * Modelos animados com HyperFrames (código aberto, Apache 2.0): gera a
 * composição HTML (GSAP) que o worker renderiza em MP4 no nosso servidor.
 * Tudo é função do tempo da linha do tempo (sem relógio, rede ou aleatório),
 * como exige o HyperFrames, então o mesmo pedido gera sempre o mesmo vídeo.
 */
import type { Aspect, MotionPalette, MotionParams, MotionTemplate } from './jobs';

export const MOTION_TEMPLATES: { id: MotionTemplate; label: string; description: string }[] = [
  { id: 'kinetic', label: 'Texto dinâmico', description: 'Frases grandes entrando palavra por palavra, ótimo para reels e frases de impacto.' },
  { id: 'showcase', label: 'Vitrine de imagens', description: 'Suas imagens com zoom suave e legenda animada em cada uma.' },
  { id: 'launch', label: 'Lançamento', description: 'Título, cartões de destaque deslizando e chamada final, estilo anúncio de produto.' },
];

export const MOTION_PALETTES: Record<MotionPalette, { label: string; bg: string; bg2: string; ink: string; accent: string; muted: string }> = {
  noite: { label: 'Noite', bg: '#0b1020', bg2: '#1e1b4b', ink: '#ffffff', accent: '#a78bfa', muted: '#c7d2fe' },
  sol: { label: 'Sol', bg: '#fff7ed', bg2: '#fed7aa', ink: '#1c1917', accent: '#ea580c', muted: '#57534e' },
  oceano: { label: 'Oceano', bg: '#082f49', bg2: '#0e7490', ink: '#ffffff', accent: '#22d3ee', muted: '#bae6fd' },
  neon: { label: 'Neon', bg: '#050505', bg2: '#111827', ink: '#ffffff', accent: '#22ff88', muted: '#d1d5db' },
  papel: { label: 'Papel', bg: '#f5f5f4', bg2: '#e7e5e4', ink: '#111111', accent: '#dc2626', muted: '#44403c' },
};

export const MOTION_SIZES: Record<Aspect, [number, number]> = {
  '9:16': [720, 1280],
  '16:9': [1280, 720],
  '1:1': [960, 960],
};

export const MOTION_LIMITS = { maxLines: 12, maxLineChars: 140, maxTitle: 80, maxImages: 20, minSeconds: 1.5, maxSeconds: 8, maxTotal: 90 };

const TITLE_SECONDS = 2.6;
const CTA_SECONDS = 2.6;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const r2 = (n: number) => Math.round(n * 1000) / 1000;

export interface MotionPlan {
  width: number;
  height: number;
  duration: number;
  /** cenas na ordem: título, itens, chamada final */
  scenes: { kind: 'title' | 'item' | 'cta'; start: number; duration: number; text: string; image?: string }[];
}

/** Normaliza o pedido e calcula as cenas e a duração total. */
export function planMotion(p: MotionParams, images: string[]): MotionPlan {
  const [width, height] = MOTION_SIZES[p.aspect] ?? MOTION_SIZES['9:16'];
  const per = Math.min(MOTION_LIMITS.maxSeconds, Math.max(MOTION_LIMITS.minSeconds, Number(p.seconds_per_item) || 3));
  const lines = (p.lines ?? []).map((l) => l.trim()).filter(Boolean).slice(0, MOTION_LIMITS.maxLines).map((l) => l.slice(0, MOTION_LIMITS.maxLineChars));
  const imgs = images.slice(0, MOTION_LIMITS.maxImages);
  const count = Math.max(lines.length, imgs.length);
  const scenes: MotionPlan['scenes'] = [];
  let t = 0;
  const title = (p.title ?? '').trim().slice(0, MOTION_LIMITS.maxTitle);
  if (title) {
    scenes.push({ kind: 'title', start: 0, duration: TITLE_SECONDS, text: title, image: imgs[0] });
    t += TITLE_SECONDS;
  }
  for (let i = 0; i < count; i++) {
    scenes.push({ kind: 'item', start: r2(t), duration: per, text: lines[i] ?? '', image: imgs.length ? imgs[i % imgs.length] : undefined });
    t += per;
  }
  const cta = (p.cta ?? '').trim().slice(0, MOTION_LIMITS.maxLineChars);
  if (cta) {
    scenes.push({ kind: 'cta', start: r2(t), duration: CTA_SECONDS, text: cta });
    t += CTA_SECONDS;
  }
  return { width, height, duration: r2(Math.min(t, MOTION_LIMITS.maxTotal)), scenes: scenes.filter((s) => s.start < MOTION_LIMITS.maxTotal) };
}

export function validateMotion(p: MotionParams, imageCount: number): string | null {
  if (!MOTION_TEMPLATES.some((t) => t.id === p.template)) return 'Escolha um modelo.';
  if (!MOTION_PALETTES[p.palette]) return 'Escolha uma paleta de cores.';
  const lines = (p.lines ?? []).filter((l) => l.trim());
  if (!p.title?.trim() && !lines.length && !imageCount) return 'Escreva um título, frases ou escolha imagens.';
  if (p.template === 'showcase' && !imageCount) return 'O modelo Vitrine precisa de pelo menos uma imagem.';
  return null;
}

/** Gera o index.html da composição (GSAP local em assets/gsap.min.js). */
export function buildMotionHtml(p: MotionParams, images: string[]): { html: string; plan: MotionPlan } {
  const plan = planMotion(p, images);
  const pal = MOTION_PALETTES[p.palette] ?? MOTION_PALETTES.noite;
  const { width: W, height: H } = plan;
  const vertical = H > W;
  const base = Math.min(W, H);
  const big = Math.round(base * (vertical ? 0.1 : 0.085));
  const mid = Math.round(base * 0.062);
  const small = Math.round(base * 0.04);
  const tw: string[] = [];
  const els: string[] = [];

  plan.scenes.forEach((s, i) => {
    const id = `s${i}`;
    const end = r2(s.start + s.duration);
    const out = r2(end - 0.45);
    const words = escapeHtml(s.text).split(/\s+/).filter(Boolean);
    const wordSpans = words.map((w, k) => `<span class="w" id="${id}w${k}">${w}</span>`).join(' ');
    const bgImg = s.image ? `<img class="bgimg" id="${id}img" src="${escapeHtml(s.image)}" alt="" />` : '';
    const shade = s.image ? `<div class="shade"></div>` : '';

    if (s.kind === 'title') {
      els.push(`<div class="clip scene" id="${id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0">${bgImg}${shade}
        <div class="center"><div class="bar" id="${id}bar"></div><h1 class="title" id="${id}t">${wordSpans}</h1></div></div>`);
      tw.push(`tl.fromTo("#${id}bar",{scaleX:0},{scaleX:1,duration:0.5,ease:"power3.out"},${r2(s.start + 0.1)});`);
      tw.push(`tl.fromTo("#${id} .w",{opacity:0,y:${Math.round(big * 0.6)},rotation:4},{opacity:1,y:0,rotation:0,duration:0.55,stagger:0.08,ease:"back.out(1.6)"},${r2(s.start + 0.2)});`);
      if (s.image) tw.push(`tl.fromTo("#${id}img",{scale:1.15},{scale:1,duration:${s.duration},ease:"none"},${s.start});`);
      tw.push(`tl.to("#${id} .center",{opacity:0,y:-30,duration:0.35,ease:"power2.in"},${out});`);
      return;
    }
    if (s.kind === 'cta') {
      els.push(`<div class="clip scene" id="${id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0">
        <div class="center"><div class="cta" id="${id}c">${escapeHtml(s.text)}</div></div></div>`);
      tw.push(`tl.fromTo("#${id}c",{opacity:0,scale:0.6},{opacity:1,scale:1,duration:0.5,ease:"back.out(2)"},${r2(s.start + 0.15)});`);
      tw.push(`tl.to("#${id}c",{scale:1.06,duration:0.45,yoyo:true,repeat:3,ease:"sine.inOut"},${r2(s.start + 0.7)});`);
      return;
    }

    // itens
    if (p.template === 'kinetic') {
      els.push(`<div class="clip scene" id="${id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0">${bgImg}${shade}
        <div class="center"><p class="kin" id="${id}t">${wordSpans}</p></div></div>`);
      const step = Math.min(0.12, (s.duration * 0.45) / Math.max(1, words.length));
      tw.push(`tl.fromTo("#${id} .w",{opacity:0,y:${Math.round(mid)},scale:0.7},{opacity:1,y:0,scale:1,duration:0.4,stagger:${r2(step)},ease:"power3.out"},${r2(s.start + 0.1)});`);
      if (words.length) tw.push(`tl.to("#${id}w${Math.floor(words.length / 2)}",{color:"${pal.accent}",duration:0.25},${r2(s.start + 0.3 + step * words.length)});`);
      if (s.image) tw.push(`tl.fromTo("#${id}img",{scale:1},{scale:1.12,duration:${s.duration},ease:"none"},${s.start});`);
      tw.push(`tl.to("#${id} .center",{opacity:0,scale:1.08,duration:0.35,ease:"power2.in"},${out});`);
    } else if (p.template === 'showcase') {
      const dir = i % 2 ? -1 : 1;
      els.push(`<div class="clip scene" id="${id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0">${bgImg}
        ${s.text ? `<div class="caption" id="${id}cap"><span>${escapeHtml(s.text)}</span></div>` : ''}</div>`);
      if (s.image) tw.push(`tl.fromTo("#${id}img",{scale:1.04,x:${-dir * 20}},{scale:1.16,x:${dir * 20},duration:${s.duration},ease:"none"},${s.start});`);
      if (s.image) tw.push(`tl.fromTo("#${id}img",{opacity:0},{opacity:1,duration:0.35},${s.start});`);
      if (s.text) tw.push(`tl.fromTo("#${id}cap",{y:120,opacity:0},{y:0,opacity:1,duration:0.5,ease:"power3.out"},${r2(s.start + 0.3)});`);
      if (s.text) tw.push(`tl.to("#${id}cap",{y:60,opacity:0,duration:0.3,ease:"power2.in"},${out});`);
    } else {
      // launch: cartão deslizando com número e imagem
      const n = String(plan.scenes.filter((x, k) => x.kind === 'item' && k <= i).length).padStart(2, '0');
      els.push(`<div class="clip scene" id="${id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0">
        <div class="card" id="${id}card">${s.image ? `<img class="cardimg" id="${id}img" src="${escapeHtml(s.image)}" alt="" />` : ''}
          <div class="cardtext"><div class="num">${n}</div><p class="feat">${escapeHtml(s.text)}</p></div></div></div>`);
      tw.push(`tl.fromTo("#${id}card",{x:${W},rotation:6},{x:0,rotation:0,duration:0.6,ease:"power4.out"},${r2(s.start + 0.05)});`);
      if (s.image) tw.push(`tl.fromTo("#${id}img",{scale:1.2},{scale:1,duration:${s.duration},ease:"power1.out"},${s.start});`);
      tw.push(`tl.to("#${id}card",{x:${-W},rotation:-6,duration:0.45,ease:"power3.in"},${r2(end - 0.5)});`);
    }
  });

  const cardFlex = vertical ? 'column' : 'row';
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="assets/gsap.min.js"></script>
<style>
:root { --bg: ${pal.bg}; --bg2: ${pal.bg2}; --ink: ${pal.ink}; --accent: ${pal.accent}; --muted: ${pal.muted}; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--bg); }
#root { position: relative; width: ${W}px; height: ${H}px; font-family: Inter, sans-serif; color: var(--ink);
  background: radial-gradient(circle at 30% 20%, var(--bg2), var(--bg) 70%); overflow: hidden; }
.scene { position: absolute; inset: 0; overflow: hidden; }
.bgimg { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
.shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.25), rgba(0,0,0,0.65)); }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: ${Math.round(base * 0.08)}px; text-align: center; }
.title { font-size: ${big}px; font-weight: 900; line-height: 1.05; letter-spacing: -0.02em; }
.bar { width: ${Math.round(base * 0.18)}px; height: ${Math.round(base * 0.014)}px; background: var(--accent); border-radius: 99px; margin-bottom: ${Math.round(base * 0.04)}px; transform-origin: left center; }
.kin { font-size: ${Math.round(big * 1.2)}px; font-weight: 900; line-height: 1.1; letter-spacing: -0.02em; }
.w { display: inline-block; }
.caption { position: absolute; left: ${Math.round(base * 0.06)}px; right: ${Math.round(base * 0.06)}px; bottom: ${Math.round(H * 0.1)}px; text-align: center; }
.caption span { display: inline-block; background: var(--accent); color: var(--bg); font-weight: 700; font-size: ${mid}px; line-height: 1.2; padding: ${Math.round(base * 0.02)}px ${Math.round(base * 0.035)}px; border-radius: ${Math.round(base * 0.02)}px; }
.card { position: absolute; left: ${Math.round(base * 0.07)}px; right: ${Math.round(base * 0.07)}px; top: 50%; margin-top: -${Math.round((vertical ? H * 0.32 : H * 0.3))}px; height: ${Math.round(vertical ? H * 0.64 : H * 0.6)}px;
  display: flex; flex-direction: ${cardFlex}; gap: ${Math.round(base * 0.04)}px; align-items: center; background: rgba(255,255,255,0.08); border: 2px solid var(--accent); border-radius: ${Math.round(base * 0.04)}px; padding: ${Math.round(base * 0.05)}px; }
.cardimg { flex: 1 1 0; min-height: 0; min-width: 0; width: 100%; height: 100%; object-fit: cover; border-radius: ${Math.round(base * 0.03)}px; }
.cardtext { flex: 1 1 0; display: flex; flex-direction: column; justify-content: center; }
.num { font-size: ${small}px; font-weight: 900; color: var(--accent); letter-spacing: 0.12em; margin-bottom: ${Math.round(base * 0.02)}px; }
.feat { font-size: ${mid}px; font-weight: 700; line-height: 1.2; }
.cta { font-size: ${mid}px; font-weight: 900; background: var(--accent); color: var(--bg); padding: ${Math.round(base * 0.035)}px ${Math.round(base * 0.06)}px; border-radius: 999px; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${plan.duration}" data-width="${W}" data-height="${H}">
${els.join('\n')}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tw.join('\n')}
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
  return { html, plan };
}
