/**
 * Modos de "Transformar vídeo" e o que de fato os executa.
 *
 * Nada aqui promete resultado: cada modo só é habilitado quando existe uma
 * integração conectada capaz de executá-lo (ver availableModes).
 */
import type { Capabilities } from './capabilities';

/** motores que executam transformações: hf = GPU grátis do Hugging Face */
export type TransformEngine = 'fal' | 'hf' | 'runway';

export type TransformModeId = 'face_swap' | 'head' | 'full_body' | 'appearance' | 'stylized' | 'cinematic';

export interface TransformMode {
  id: TransformModeId;
  letter: string;
  title: string;
  summary: string;
  /** como o pipeline funciona hoje — mostrado ao usuário */
  how: string;
  /** integrações capazes de executar o modo, em ordem de preferência; vazio = nenhuma */
  providers: TransformEngine[];
  /** como funciona com a fal.ai (quando suportado) */
  howFal?: string;
  /** como funciona na GPU grátis do Hugging Face (quando suportado) */
  howHf?: string;
  pipeline: string[];
  limits: string;
}

export const TRANSFORM_MODES: TransformMode[] = [
  {
    id: 'face_swap',
    letter: 'A',
    title: 'Substituição facial',
    summary: 'Troca apenas o rosto da pessoa selecionada, mantendo o resto da cena.',
    how: 'Requer um provedor dedicado de troca de rosto com API e licença comercial. Nenhum está conectado. Para trocar a pessoa inteira mantendo o cenário, use o Modo C com a fal.ai.',
    providers: [],
    pipeline: [],
    limits: 'Integração pendente.',
  },
  {
    id: 'head',
    letter: 'B',
    title: 'Cabeça e rosto',
    summary: 'Modifica cabeça, cabelo e rosto preservando corpo e movimentos.',
    how: 'Requer um provedor de edição localizada de cabeça. Nenhum está conectado. Para trocar a pessoa inteira mantendo o cenário, use o Modo C com a fal.ai.',
    providers: [],
    pipeline: [],
    limits: 'Integração pendente.',
  },
  {
    id: 'full_body',
    letter: 'C',
    title: 'Personagem de corpo inteiro',
    summary: 'O personagem executa a atuação do vídeo: expressões, gestos e movimentos do corpo.',
    how: 'Runway Act-Two: a imagem principal do personagem é animada usando o seu vídeo como referência de atuação (controle corporal ligado). O resultado usa o cenário da imagem do personagem.',
    howFal: 'fal.ai — Wan 2.2 Animate Replace: a pessoa do seu vídeo é substituída pelo personagem no MESMO cenário, mantendo movimentos, gestos, expressões e iluminação.',
    howHf: 'GRÁTIS — Wan 2.2 Animate na GPU gratuita do Hugging Face (modo "Character Swap"): troca a pessoa pelo personagem no mesmo cenário. Cota diária pequena (cerca de 1 a 3 trechos curtos por dia), fila pública e resolução baixa.',
    providers: ['fal', 'hf', 'runway'],
    pipeline: ['runway.act_two'],
    limits: 'Trecho de 3 a 30 s. O rosto precisa estar visível e dentro do quadro.',
  },
  {
    id: 'appearance',
    letter: 'D',
    title: 'Transformação de aparência',
    summary: 'Muda roupas, cores e estilo visual sem alterar a ação original.',
    how: 'O primeiro quadro é editado com o personagem como referência (Runway Gen-4 Image) e usado como guia para o Runway Aleph 2 transformar o vídeo inteiro mantendo o movimento.',
    providers: ['runway'],
    pipeline: ['runway.gen4_image', 'runway.aleph2'],
    limits: 'Trechos curtos (limite configurado pelo administrador).',
  },
  {
    id: 'stylized',
    letter: 'E',
    title: 'Personagem estilizado',
    summary: 'Transforma a pessoa em 3D, cartoon, anime ou outro estilo.',
    how: 'Mesmo pipeline do modo D, com o estilo do personagem aplicado ao vídeo pelo Runway Aleph 2.',
    providers: ['runway'],
    pipeline: ['runway.gen4_image', 'runway.aleph2'],
    limits: 'Trechos curtos (limite configurado pelo administrador).',
  },
  {
    id: 'cinematic',
    letter: 'F',
    title: 'Recriação cinematográfica',
    summary: 'Usa o vídeo como referência de movimento para criar uma cena nova com o personagem.',
    how: 'Gera uma imagem do personagem no cenário descrito (Runway Gen-4 Image) e a anima com a atuação do seu vídeo (Runway Act-Two).',
    howFal: 'fal.ai — Wan 2.2 Animate Move: o personagem, no cenário da imagem dele, repete os movimentos e expressões do seu vídeo.',
    howHf: 'GRÁTIS — Wan 2.2 Animate na GPU gratuita do Hugging Face (modo de movimento): o personagem repete os movimentos do vídeo. Cota diária pequena e fila pública.',
    providers: ['fal', 'hf', 'runway'],
    pipeline: ['runway.gen4_image', 'runway.act_two'],
    limits: 'Trecho de 3 a 30 s.',
  },
];

export interface ModeAvailability {
  mode: TransformMode;
  available: boolean;
  /** motores configurados capazes de executar o modo */
  engines: TransformEngine[];
  reason?: string;
}

export function availableModes(caps: Capabilities | undefined): ModeAvailability[] {
  return TRANSFORM_MODES.map((mode) => {
    if (!mode.providers.length) return { mode, available: false, engines: [], reason: 'Integração pendente' };
    const statuses = mode.providers.map((p) => ({ p, st: integrationStatus(caps, p) }));
    const engines = statuses.filter((x) => x.st.ok).map((x) => x.p);
    return engines.length ? { mode, available: true, engines } : { mode, available: false, engines, reason: statuses[0].st.reason };
  });
}

export function integrationStatus(caps: Capabilities | undefined, id: string): { ok: boolean; reason?: string } {
  if (!caps) return { ok: false, reason: 'Verificando integrações…' };
  if (!caps.worker_online) return { ok: false, reason: 'Servidor de processamento offline' };
  const i = caps.integrations[id];
  if (!i) return { ok: false, reason: 'Integração desconhecida' };
  if (!i.enabled) return { ok: false, reason: 'Desabilitada pelo administrador' };
  if (!i.configured) return { ok: false, reason: 'Chave de API não configurada no servidor' };
  return { ok: true };
}

/** Avisos de qualidade antes de processar (o usuário confirma o que vê na prévia). */
export interface SourceCheck {
  multiplePeople: boolean;
  partiallyHidden: boolean;
  fastMotion: boolean;
  faceNotVisible: boolean;
}

export function qualityWarnings(check: SourceCheck, mode: TransformModeId): string[] {
  const w: string[] = [];
  if (check.multiplePeople) w.push('Há mais de uma pessoa: a primeira versão funciona melhor com uma única pessoa claramente visível.');
  if (check.partiallyHidden) w.push('Pessoa parcialmente escondida ou saindo do quadro: a qualidade pode diminuir.');
  if (check.fastMotion) w.push('Movimentos muito rápidos podem gerar tremulação e membros deformados.');
  if (check.faceNotVisible && (mode === 'full_body' || mode === 'cinematic'))
    w.push('O Act-Two exige um rosto reconhecível visível durante o trecho; a tarefa pode falhar.');
  return w;
}
