import { ArrowDown, ArrowUp, Clapperboard, Image as ImageIcon, Mic, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { Aspect, JobKind, SlideMotion } from '@shared/jobs';
import { splitScriptLocally } from '@shared/prompt';
import { piperVoiceLabel } from '@shared/voices';
import { AssetThumb } from '@/components/Assets';
import { CharacterSelect } from '@/components/CharacterSelect';
import { JobCard } from '@/components/JobCard';
import { MediaPreview } from '@/components/MediaPreview';
import { useIntegration, useTextEngine } from '@/components/IntegrationGate';
import { Badge, Button, Card, Checkbox, Field, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { createJob, estimateJob } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useAssets, useCapabilities, useJobs } from '@/lib/hooks';
import type { Job } from '@/lib/types';

interface Scene {
  id: string;
  text: string;
  imagePrompt: string;
  imageJobId?: string;
  imageAssetId?: string;
}

interface State {
  script: string;
  aspect: Aspect;
  characterId: string;
  scenes: Scene[];
  narrate: boolean;
  voice: string;
  narrationJobId?: string;
  audioAssetId?: string;
  subtitleAssetId?: string;
  burnSubtitles: boolean;
  motion: SlideMotion | 'auto';
  transition: 'fade' | 'none';
  splitJobId?: string;
  videoJobIds: string[];
}

const KEY = 'videoGratis.v1';
const EMPTY: State = { script: '', aspect: '9:16', characterId: '', scenes: [], narrate: true, voice: '', burnSubtitles: true, motion: 'auto', transition: 'fade', videoJobIds: [] };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<State>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

const newScene = (text: string, imagePrompt = text): Scene => ({ id: crypto.randomUUID(), text, imagePrompt });

/** Cria uma tarefa gratuita mostrando o custo calculado pelo banco (0 nas opções grátis). */
async function runFree(kind: JobKind, params: Record<string, unknown>, inputs: string[] = []): Promise<Job> {
  const est = await estimateJob(kind, params, inputs);
  if (est.errors.length) throw new Error(est.errors[0]);
  if (est.credits > 0 && !confirm(`Esta etapa custa ${est.credits} créditos. Continuar?`)) throw new Error('Cancelado.');
  return createJob({ kind, params, inputs, confirmedCredits: est.credits });
}

export default function FreeVideo() {
  const [s, setS] = useState<State>(load);
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const set = (patch: Partial<State>) => setS((x) => ({ ...x, ...patch }));
  const caps = useCapabilities();
  const textEngine = useTextEngine();
  const cloudflare = useIntegration('cloudflare');
  const local = useIntegration('local');
  const voices = useMemo(() => caps.data?.local?.voices ?? [], [caps.data]);
  const ttsOk = local.ok && !!caps.data?.local?.tts;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* armazenamento indisponível */
    }
  }, [s]);
  useEffect(() => {
    if (!s.voice && voices.length) set({ voice: voices[0] });
  }, [voices, s.voice]);

  // acompanha as tarefas e aplica os resultados
  const jobIds = [s.splitJobId, s.narrationJobId, ...s.scenes.map((x) => x.imageJobId), ...s.videoJobIds].filter(Boolean) as string[];
  const jobs = useJobs({ ids: jobIds });
  const byId = useMemo(() => new Map((jobs.data ?? []).map((j) => [j.id, j])), [jobs.data]);
  const doneKey = (jobs.data ?? []).filter((j) => j.status === 'succeeded').map((j) => j.id).join(',');
  useEffect(() => {
    if (!doneKey) return;
    qc.invalidateQueries({ queryKey: ['assets'] });
    setS((x) => {
      let changed = false;
      const scenes = x.scenes.map((sc) => {
        const j = sc.imageJobId ? byId.get(sc.imageJobId) : undefined;
        if (j?.status === 'succeeded' && j.output_asset_ids[0] && sc.imageAssetId !== j.output_asset_ids[0]) {
          changed = true;
          return { ...sc, imageAssetId: j.output_asset_ids[0] };
        }
        return sc;
      });
      const patch: Partial<State> = { scenes };
      const nj = x.narrationJobId ? byId.get(x.narrationJobId) : undefined;
      if (nj?.status === 'succeeded' && nj.output_asset_ids[0] !== x.audioAssetId) {
        changed = true;
        patch.audioAssetId = nj.output_asset_ids[0];
        patch.subtitleAssetId = nj.output_asset_ids[1];
      }
      const sj = x.splitJobId ? byId.get(x.splitJobId) : undefined;
      if (sj?.status === 'succeeded' && sj.result) {
        const out = (sj.result as { scenes?: { narration: string; visual_prompt_en: string }[] }).scenes ?? [];
        if (out.length) {
          changed = true;
          patch.scenes = out.map((o) => newScene(o.narration, o.visual_prompt_en));
          patch.splitJobId = undefined;
        }
      }
      return changed ? { ...x, ...patch } : x;
    });
  }, [doneKey, byId, qc]);

  const imageIds = s.scenes.map((x) => x.imageAssetId).filter(Boolean) as string[];
  const images = useAssets({ ids: imageIds });
  const audio = useAssets({ ids: s.audioAssetId ? [s.audioAssetId] : [] });
  const allImages = s.scenes.length > 0 && s.scenes.every((x) => x.imageAssetId);
  const narrationText = s.scenes.map((x) => x.text.trim()).filter(Boolean).join(' ');

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      if ((e as Error).message !== 'Cancelado.') toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const genImage = (sc: Scene) =>
    runFree('ai.image', { engine: 'cloudflare', model: 'gen4_image', character_id: s.characterId || undefined, view: 'scene', prompt: sc.imagePrompt, aspect: s.aspect }).then((j) =>
      setS((x) => ({ ...x, scenes: x.scenes.map((y) => (y.id === sc.id ? { ...y, imageJobId: j.id, imageAssetId: undefined } : y)) })),
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Vídeo grátis"
        subtitle="Roteiro → imagens → narração → vídeo animado. Tudo com as opções gratuitas (Gemini, Cloudflare e o nosso servidor)."
        actions={<Button variant="ghost" onClick={() => confirm('Começar um vídeo novo? O atual sai desta tela (os arquivos continuam na Biblioteca).') && setS(EMPTY)}>Começar de novo</Button>}
      />
      <Notice>
        As imagens ganham movimento de câmera (zoom e deslizamento) e transições; não é vídeo com personagens se mexendo. Cada serviço grátis tem um limite diário: se acabar, a etapa pausa até o dia seguinte, sem cobrar nada.
      </Notice>

      <Card className="flex flex-col gap-4">
        <p className="flex items-center gap-2 font-display text-lg font-semibold"><Sparkles className="size-5" /> 1. Roteiro</p>
        <Textarea rows={6} placeholder="Escreva ou cole o texto que será narrado. Cada parágrafo vira uma cena." value={s.script} onChange={(e) => set({ script: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Formato">{(i) => <Select id={i} value={s.aspect} onChange={(e) => set({ aspect: e.target.value as Aspect })} options={[{ value: '9:16', label: 'Vertical 9:16 (Reels, TikTok, Shorts)' }, { value: '16:9', label: 'Horizontal 16:9' }, { value: '1:1', label: 'Quadrado 1:1' }]} />}</Field>
          <Field label="Personagem (opcional)">{(i) => <CharacterSelect id={i} allowNone value={s.characterId} onChange={(v) => set({ characterId: v })} />}</Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!s.script.trim()} onClick={() => set({ scenes: splitScriptLocally(s.script).map((t) => newScene(t)) })}>Dividir por parágrafos</Button>
          <Button
            variant="primary"
            disabled={!s.script.trim() || !textEngine.ok || !!busy}
            loading={busy === 'split'}
            onClick={() => act('split', async () => {
              const j = await runFree('ai.text', { task: 'split_script', engine: textEngine.engine, character_id: s.characterId || undefined, input: { roteiro: s.script, formato: s.aspect, duracao_por_cena: '4 a 8 s' } });
              set({ splitJobId: j.id });
            })}
          >
            <Wand2 className="size-4" /> Dividir com IA ({textEngine.label})
          </Button>
        </div>
        {!textEngine.ok && <p className="text-xs text-muted">Divisão com IA: {textEngine.reason}.</p>}
        {s.splitJobId && byId.get(s.splitJobId) && byId.get(s.splitJobId)!.status !== 'succeeded' && <JobCard job={byId.get(s.splitJobId)!} showOutputs={false} />}
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-display text-lg font-semibold"><ImageIcon className="size-5" /> 2. Imagens ({imageIds.length}/{s.scenes.length})</p>
          <Button
            variant="primary"
            disabled={!s.scenes.length || !cloudflare.ok || !!busy}
            loading={busy === 'all'}
            onClick={() => act('all', async () => {
              for (const sc of s.scenes.filter((x) => !x.imageAssetId && !x.imageJobId)) await genImage(sc);
            })}
          >
            Gerar todas as imagens (grátis)
          </Button>
        </div>
        {!cloudflare.ok && <Notice tone="warning" title="Imagens grátis: integração pendente">{cloudflare.reason}. Cole a chave da Cloudflare em Administração → Integrações.</Notice>}
        {!s.scenes.length && <p className="text-sm text-muted">Divida o roteiro em cenas no passo 1.</p>}
        {s.scenes.map((sc, idx) => {
          const job = sc.imageJobId ? byId.get(sc.imageJobId) : undefined;
          const img = images.data?.find((a) => a.id === sc.imageAssetId);
          return (
            <div key={sc.id} className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-[160px_1fr]">
              <div>{img ? <AssetThumb asset={img} /> : <div className="grid aspect-video place-items-center rounded-xl bg-surface-2 text-xs text-muted">{job ? (job.status === 'failed' ? 'Falhou' : 'Gerando…') : 'Sem imagem'}</div>}</div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge>Cena {idx + 1}</Badge>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" aria-label="Subir" disabled={idx === 0} onClick={() => set({ scenes: s.scenes.map((x, k) => (k === idx - 1 ? sc : k === idx ? s.scenes[idx - 1] : x)) })}><ArrowUp className="size-3.5" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Descer" disabled={idx === s.scenes.length - 1} onClick={() => set({ scenes: s.scenes.map((x, k) => (k === idx + 1 ? sc : k === idx ? s.scenes[idx + 1] : x)) })}><ArrowDown className="size-3.5" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => set({ scenes: s.scenes.filter((x) => x.id !== sc.id) })}><Trash2 className="size-3.5" /></Button>
                  </div>
                </div>
                <Textarea rows={2} value={sc.text} onChange={(e) => set({ scenes: s.scenes.map((x) => (x.id === sc.id ? { ...x, text: e.target.value } : x)) })} placeholder="Texto narrado nesta cena" />
                <Textarea rows={2} value={sc.imagePrompt} onChange={(e) => set({ scenes: s.scenes.map((x) => (x.id === sc.id ? { ...x, imagePrompt: e.target.value } : x)) })} placeholder="O que a imagem deve mostrar" />
                {job?.status === 'failed' && <p className="text-xs text-danger">{job.error_message}</p>}
                <Button size="sm" className="self-start" disabled={!cloudflare.ok || !!busy || !sc.imagePrompt.trim()} onClick={() => act(`img-${sc.id}`, () => genImage(sc))}>
                  {sc.imageAssetId || sc.imageJobId ? 'Gerar outra imagem' : 'Gerar imagem'}
                </Button>
              </div>
            </div>
          );
        })}
        <Button className="self-start" onClick={() => set({ scenes: [...s.scenes, newScene('')] })}><Plus className="size-4" /> Adicionar cena</Button>
      </Card>

      <Card className="flex flex-col gap-4">
        <p className="flex items-center gap-2 font-display text-lg font-semibold"><Mic className="size-5" /> 3. Narração</p>
        <Checkbox checked={s.narrate} onChange={(v) => set({ narrate: v })}>Narrar o texto das cenas com voz em português (grátis, no nosso servidor)</Checkbox>
        {s.narrate && (
          <>
            {!ttsOk && <Notice tone="warning" title="Voz grátis ainda não disponível">{local.ok ? 'Nenhuma voz instalada no servidor.' : local.reason}. Ela fica pronta depois da atualização automática do servidor.</Notice>}
            <Field label="Voz">{(i) => <Select id={i} value={s.voice} onChange={(e) => set({ voice: e.target.value })} options={voices.length ? voices.map((v) => ({ value: v, label: piperVoiceLabel(v) })) : [{ value: '', label: 'Nenhuma voz disponível' }]} />}</Field>
            <Button
              className="self-start"
              disabled={!ttsOk || !narrationText || !s.voice || !!busy}
              loading={busy === 'tts'}
              onClick={() => act('tts', async () => {
                const j = await runFree('local.tts', { text: narrationText.slice(0, 5000), voice: s.voice, speed: 1, make_subtitles: true });
                set({ narrationJobId: j.id, audioAssetId: undefined, subtitleAssetId: undefined });
              })}
            >
              {s.audioAssetId ? 'Gerar a narração de novo' : 'Gerar narração'}
            </Button>
            {s.narrationJobId && byId.get(s.narrationJobId) && byId.get(s.narrationJobId)!.status !== 'succeeded' && <JobCard job={byId.get(s.narrationJobId)!} showOutputs={false} />}
            {audio.data?.[0] && <MediaPreview asset={audio.data[0]} />}
          </>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <p className="flex items-center gap-2 font-display text-lg font-semibold"><Clapperboard className="size-5" /> 4. Montar o vídeo</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Movimento de câmera">
            {(i) => <Select id={i} value={s.motion} onChange={(e) => set({ motion: e.target.value as 'auto' })} options={[{ value: 'auto', label: 'Variado (recomendado)' }, { value: 'zoom_in', label: 'Aproximar' }, { value: 'zoom_out', label: 'Afastar' }, { value: 'pan_right', label: 'Deslizar para a direita' }, { value: 'pan_left', label: 'Deslizar para a esquerda' }]} />}
          </Field>
          <Field label="Transição">{(i) => <Select id={i} value={s.transition} onChange={(e) => set({ transition: e.target.value as 'fade' })} options={[{ value: 'fade', label: 'Fade suave' }, { value: 'none', label: 'Corte seco' }]} />}</Field>
        </div>
        {s.subtitleAssetId && <Checkbox checked={s.burnSubtitles} onChange={(v) => set({ burnSubtitles: v })}>Colocar a legenda na tela</Checkbox>}
        <Button
          variant="primary"
          size="lg"
          disabled={!allImages || (s.narrate && !s.audioAssetId) || !!busy}
          loading={busy === 'video'}
          onClick={() => act('video', async () => {
            const inputs = [...(s.scenes.map((x) => x.imageAssetId) as string[]), ...(s.narrate && s.audioAssetId ? [s.audioAssetId] : [])];
            const j = await runFree('media.slideshow', { aspect: s.aspect, resolution: 720, motion: s.motion, transition: s.transition, seconds_per_image: 4, subtitle_asset_id: s.narrate && s.burnSubtitles ? s.subtitleAssetId : undefined }, inputs);
            set({ videoJobIds: [j.id, ...s.videoJobIds] });
          })}
        >
          Montar vídeo (grátis)
        </Button>
        {!allImages && <p className="text-xs text-muted">Todas as cenas precisam de imagem.</p>}
        {allImages && s.narrate && !s.audioAssetId && <p className="text-xs text-muted">Gere a narração no passo 3 (ou desmarque a narração).</p>}
        {s.videoJobIds.map((id) => byId.get(id) && <JobCard key={id} job={byId.get(id)!} />)}
      </Card>
    </div>
  );
}
