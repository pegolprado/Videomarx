/**
 * Montagem de instruções (prompts) para os modelos visuais.
 * Regras: português nas telas, mas instruções em inglês para os modelos
 * (os modelos da Runway respondem melhor em inglês); limite de caracteres
 * do provedor respeitado sem cortar palavras.
 */

export const RUNWAY_PROMPT_LIMIT = 1000;

export interface CharacterLike {
  name: string;
  kind: string;
  description: string;
  appearance: Record<string, string | undefined>;
  custom_instructions?: string;
}

const KIND_STYLE: Record<string, string> = {
  realistic: 'photorealistic fictional adult person',
  cinematic: 'cinematic film character, filmic lighting',
  '3d': 'high quality 3D animated character',
  cartoon: 'cartoon character, clean lines',
  anime: 'anime style character',
  creature: 'fantasy creature',
  mascot: 'brand mascot character',
  avatar: 'stylized digital avatar',
};

const APPEARANCE_ORDER: [string, string][] = [
  ['age', 'apparent age'],
  ['skin', 'skin tone'],
  ['body', 'body type'],
  ['hair', 'hair'],
  ['eyes', 'eyes'],
  ['face', 'facial features'],
  ['outfit', 'outfit'],
  ['shoes', 'shoes'],
  ['accessories', 'accessories'],
  ['style', 'art style'],
];

export function clampPrompt(text: string, limit = RUNWAY_PROMPT_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '');
}

/** Descrição persistente do personagem — reutilizada em todas as gerações. */
export function characterDescriptor(c: CharacterLike): string {
  const parts: string[] = [KIND_STYLE[c.kind] ?? 'original character'];
  if (c.description.trim()) parts.push(c.description.trim());
  for (const [key, label] of APPEARANCE_ORDER) {
    const v = c.appearance[key]?.trim();
    if (v) parts.push(`${label}: ${v}`);
  }
  if (c.custom_instructions?.trim()) parts.push(c.custom_instructions.trim());
  return parts.join('; ');
}

export const VIEW_PROMPTS: Record<string, string> = {
  portrait: 'head and shoulders portrait, looking at camera, neutral background',
  front: 'full body front view, standing straight, arms relaxed, plain studio background, character reference sheet',
  side: 'full body side profile view, standing, plain studio background, character reference sheet',
  full_body: 'full body shot, natural pose, plain studio background',
  expression: 'close-up portrait showing a clear facial expression',
  pose: 'full body dynamic pose',
  scene: 'character inside the described environment',
  cover: 'eye-catching vertical cover image, character centered, space for title text at the top',
  custom: '',
};

/** Instrução para gerar imagem do personagem (com tag de referência quando houver). */
export function characterImagePrompt(c: CharacterLike, view: string, extra: string, hasReference: boolean): string {
  const subject = hasReference ? '@char' : c.name;
  const viewText = VIEW_PROMPTS[view] ?? '';
  const base = hasReference
    ? `${subject}, keep exactly the same face, hair, body and outfit as the reference. ${viewText}. ${extra}`
    : `${characterDescriptor(c)}. ${viewText}. ${extra}`;
  return clampPrompt(base);
}

export interface SceneFields {
  description: string;
  setting?: string;
  action?: string;
  camera?: string;
  framing?: string;
  style?: string;
  lighting?: string;
  mood?: string;
  motion?: 'low' | 'medium' | 'high';
}

const MOTION_TEXT = { low: 'subtle, slow motion', medium: 'natural motion', high: 'energetic, dynamic motion' };

/**
 * Instrução de vídeo organizada (sem usar modelo de linguagem). Quando o
 * Claude está configurado, o site pode pedir uma versão refinada (scene_prompt).
 */
export function scenePrompt(fields: SceneFields, character?: CharacterLike, usesCharacterImage = false): string {
  const parts: string[] = [];
  if (character) {
    parts.push(usesCharacterImage ? `The character from the image` : characterDescriptor(character));
  }
  parts.push(fields.description);
  if (fields.action) parts.push(`Action: ${fields.action}`);
  if (fields.setting) parts.push(`Setting: ${fields.setting}`);
  if (fields.camera) parts.push(`Camera: ${fields.camera}`);
  if (fields.framing) parts.push(`Framing: ${fields.framing}`);
  if (fields.lighting) parts.push(`Lighting: ${fields.lighting}`);
  if (fields.mood) parts.push(`Mood: ${fields.mood}`);
  if (fields.style) parts.push(`Style: ${fields.style}`);
  if (fields.motion) parts.push(MOTION_TEXT[fields.motion]);
  parts.push('consistent character appearance across frames, stable details');
  return clampPrompt(parts.filter(Boolean).join('. '));
}

/**
 * Divisão simples de roteiro em cenas (sem IA): por parágrafos, ou por
 * frases agrupadas até ~maxChars. Usado como alternativa quando o Claude
 * não está configurado.
 */
export function splitScriptLocally(script: string, maxChars = 220): string[] {
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const scenes: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      scenes.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?…]+[.!?…]*/g) ?? [p];
    let cur = '';
    for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
      if (cur && (cur + ' ' + s).length > maxChars) {
        scenes.push(cur);
        cur = s;
      } else {
        cur = cur ? `${cur} ${s}` : s;
      }
    }
    if (cur) scenes.push(cur);
  }
  return scenes;
}

/**
 * Estilos visuais aplicados a TODAS as imagens de um vídeo (mesma "cara" do
 * início ao fim). Ideia inspirada no Pixelle-Video (Apache-2.0); textos nossos.
 */
export const VISUAL_STYLES: { id: string; label: string; prompt: string }[] = [
  { id: 'cinematic', label: 'Cinematográfico realista', prompt: 'cinematic photo, realistic, dramatic soft lighting, shallow depth of field, rich colors' },
  { id: 'cartoon3d', label: 'Animação 3D', prompt: '3D animated movie style, soft global illumination, expressive characters, vibrant colors' },
  { id: 'anime', label: 'Anime', prompt: 'anime illustration, clean line art, cel shading, vivid colors' },
  { id: 'watercolor', label: 'Aquarela', prompt: 'watercolor painting, soft washes, paper texture, gentle pastel palette' },
  { id: 'line', label: 'Desenho de linhas', prompt: 'minimalist black ink line drawing on white background, simple hand-drawn sketch' },
  { id: 'comic', label: 'Quadrinhos', prompt: 'comic book illustration, bold outlines, halftone shading, dynamic composition' },
  { id: 'minimal', label: 'Minimalista', prompt: 'minimalist flat illustration, geometric shapes, clean composition, soft colors' },
  { id: 'neon', label: 'Neon noturno', prompt: 'neon cyberpunk night scene, glowing lights, reflections, moody atmosphere' },
];

export function styledImagePrompt(scenePrompt: string, styleId?: string, character?: CharacterLike): string {
  const style = VISUAL_STYLES.find((s) => s.id === styleId);
  const parts = [scenePrompt.trim()];
  if (character) parts.unshift(characterDescriptor(character));
  if (style) parts.push(style.prompt);
  parts.push('no text, no watermark');
  return clampPrompt(parts.filter(Boolean).join('. '));
}

/** Divisão de roteiro fixo: por parágrafo, por linha ou por frase. */
export function splitNarration(script: string, mode: 'paragraph' | 'line' | 'sentence'): string[] {
  const clean = script.replace(/\r/g, '');
  if (mode === 'line') return clean.split('\n').map((l) => l.trim()).filter(Boolean);
  if (mode === 'sentence') {
    // quebra de linha também encerra a frase
    return clean
      .split(/\n+/)
      .flatMap((line) => line.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) ?? [])
      .map((x) => x.trim())
      .filter((x) => x.length > 1);
  }
  return clean.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
