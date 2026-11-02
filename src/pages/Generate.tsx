import { ArrowDown, ArrowUp, Film, Plus, Save, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { Aspect } from '@shared/jobs';
import { scenePrompt, splitScriptLocally, type SceneFields } from '@shared/prompt';
import { VIDEO_MODELS, ratioFor } from '@shared/ratios';
import { AssetGrid } from '@/components/Assets';
import { CharacterSelect } from '@/components/CharacterSelect';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration, useTextEngine } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useAssets, useCharacters, useJobs } from '@/lib/hooks';
import { createProject, saveProject, useProjectRow } from '@/lib/projects';
import { errorMessage } from '@/lib/errors';
import type { Job } from '@/lib/types';

interface Scene extends SceneFields {
  id: string;
  duration: number;
  prompt_override?: string;
  job_ids: string[];
  asset_id?: string;
}

const newScene = (description = ''): Scene => ({ id: crypto.randomUUID(), description, duration: 5, motion: 'medium', job_ids: [] });

export default function Generate() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(params.get('projeto'));
  const project = useProjectRow(projectId);
  const [name, setName] = useState('Novo vídeo');
  const [characterId, setCharacterId] = useState('');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [model, setModel] = useState<string>('gen4.5');
  const [useCharImage, setUseCharImage] = useState(true);
  const [scenes, setScenes] = useState<Scene[]>([newScene()]);
  const [script, setScript] = useState('');
  const [splitJob, setSplitJob] = useState<string | null>(null);
  const [concat, setConcat] = useState({ transition: 'fade' as 'none' | 'fade', music_asset_id: '', music_volume: 0.3 });
  const [concatJobs, setConcatJobs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const chars = useCharacters();
  const character = chars.data?.find((c) => c.id === characterId);
  const runway = useIntegration('runway');
  const textEngine = useTextEngine();
  const spec = VIDEO_MODELS.find((m) => m.id === model)!;
  const usesImage = useCharImage && !!character?.primary_image_id;
  const ratio = ratioFor(model, aspect, !usesImage);
  const split = useJobs({ ids: splitJob ? [splitJob] : [] });
  const concatJobsQ = useJobs({ ids: concatJobs });
  const music = useAssets({ kind: 'audio' });

  useEffect(() => {
    const p = project.data;
    if (!p) return;
    const d = p.data as { scenes?: Scene[]; model?: string; use_character_image?: boolean; concat_jobs?: string[] };
    setName(p.name);
    setAspect(p.aspect);
    setCharacterId(p.character_id ?? '');
    if (d.scenes?.length) setScenes(d.scenes);
    if (d.model) setModel(d.model);
    if (d.use_character_image != null) setUseCharImage(d.use_character_image);
    if (d.concat_jobs) setConcatJobs(d.concat_jobs);
  }, [project.data]);

  // resultado da divisão de roteiro com IA
  useEffect(() => {
    const j = split.data?.[0];
    if (j?.status !== 'succeeded' || !j.result) return;
    const out = (j.result as { scenes?: { title: string; narration: string; visual_prompt_en: string; camera: string; duration_seconds: number }[] }).scenes ?? [];
    if (out.length) {
      setScenes(out.map((s) => ({ ...newScene(s.narration), action: s.title, camera: s.camera, prompt_override: s.visual_prompt_en, duration: nearestDuration(s.duration_seconds) })));
      toast.success(`Roteiro dividido em ${out.length} cenas.`);
    }
    setSplitJob(null);
  }, [split.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function nearestDuration(d: number) {
    return spec.durations.reduce((best, x) => (Math.abs(x - d) < Math.abs(best - d) ? x : best), spec.durations[0]);
  }

  useEffect(() => {
    // ajusta durações ao trocar de modelo
    setScenes((ss) => ss.map((s) => ((spec.durations as readonly number[]).includes(s.duration) ? s : { ...s, duration: nearestDuration(s.duration) })));
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id: string, patch: Partial<Scene>) => setScenes((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => setScenes((ss) => {
    const n = [...ss];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });

  async function persist(extra: Partial<{ concat_jobs: string[] }> = {}, list = scenes) {
    setSaving(true);
    try {
      const data = { scenes: list, model, use_character_image: useCharImage, concat_jobs: extra.concat_jobs ?? concatJobs };
      if (projectId) await saveProject(projectId, { name, aspect, character_id: characterId || null, data });
      else {
        const p = await createProject({ name, type: 'generate', aspect, character_id: characterId || null, data });
        setProjectId(p.id);
        setParams({ projeto: p.id }, { replace: true });
      }
      qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const chosen = scenes.map((s) => s.asset_id).filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Gerar vídeo com IA"
        subtitle="Descreva cenas em linguagem natural, gere cada uma, revise e monte a sequência final."
        actions={<Button onClick={() => persist()} loading={saving}><Save className="size-4" /> Salvar projeto</Button>}
      />
      <IntegrationGate provider="runway" feature="Geração de vídeo" />

      <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Nome do projeto">{(i) => <Input id={i} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Personagem">{(i) => <CharacterSelect id={i} allowNone value={characterId} onChange={setCharacterId} />}</Field>
        <Field label="Proporção">
          {(i) => <Select id={i} value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} options={[{ value: '9:16', label: 'Vertical 9:16' }, { value: '16:9', label: 'Horizontal 16:9' }, { value: '1:1', label: 'Quadrado 1:1' }]} />}
        </Field>
        <Field label="Modelo" hint={`Durações: ${spec.durations.join(', ')} s`}>
          {(i) => <Select id={i} value={model} onChange={(e) => setModel(e.target.value)} options={VIDEO_MODELS.map((m) => ({ value: m.id, label: m.label }))} />}
        </Field>
        {character && (
          <div className="sm:col-span-2 lg:col-span-4">
            <Checkbox checked={useCharImage} onChange={setUseCharImage}>
              Usar a imagem principal de {character.name} como quadro inicial (melhora a consistência do personagem)
              {!character.primary_image_id && ' — o personagem ainda não tem imagem principal'}
            </Checkbox>
          </div>
        )}
        {!ratio && <div className="sm:col-span-2 lg:col-span-4"><Notice tone="warning">{spec.label} não gera vídeos {aspect}{usesImage ? '' : ' a partir de texto'}. Escolha outra proporção, outro modelo ou use uma imagem inicial.</Notice></div>}
        {spec.needsImage && !usesImage && <div className="sm:col-span-2 lg:col-span-4"><Notice tone="warning">{spec.label} só funciona a partir de uma imagem: escolha um personagem com imagem principal.</Notice></div>}
      </Card>

      <Card className="flex flex-col gap-3">
        <p className="flex items-center gap-2 font-medium"><Sparkles className="size-4" /> Dividir um roteiro longo em cenas</p>
        <Textarea rows={4} placeholder="Cole o roteiro aqui…" value={script} onChange={(e) => setScript(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { const parts = splitScriptLocally(script); if (parts.length) { setScenes(parts.map((p) => newScene(p))); toast.success(`${parts.length} cenas criadas.`); } }} disabled={!script.trim()}>
            Dividir por parágrafos (grátis)
          </Button>
        </div>
        {textEngine.ok ? (
          <CostConfirm
            kind="ai.text"
            params={{ task: 'split_script', engine: textEngine.engine, character_id: characterId || undefined, input: { roteiro: script, formato: aspect, duracao_por_cena: spec.durations.join('/') + ' s' } }}
            disabled={!script.trim() ? 'Cole um roteiro.' : false}
            label={`Dividir com IA (${textEngine.label})`}
            onCreated={(j: Job) => setSplitJob(j.id)}
          />
        ) : (
          <p className="text-xs text-muted">Divisão inteligente com IA: {textEngine.reason?.toLowerCase()}.</p>
        )}
        {split.data?.map((j) => j.status !== 'succeeded' && <JobCard key={j.id} job={j} showOutputs={false} />)}
      </Card>

      {scenes.map((s, idx) => (
        <SceneCard
          key={s.id}
          scene={s}
          index={idx}
          total={scenes.length}
          prompt={s.prompt_override || scenePrompt(s, character, usesImage)}
          canGenerate={runway.ok && !!ratio && !(spec.needsImage && !usesImage)}
          blockReason={!runway.ok ? runway.reason : !ratio ? 'Proporção indisponível para este modelo.' : spec.needsImage && !usesImage ? 'Este modelo exige imagem inicial.' : undefined}
          jobParams={{ model, aspect, duration: s.duration, character_id: characterId || undefined, use_character_image: usesImage, scene_index: idx, prompt: s.prompt_override || scenePrompt(s, character, usesImage) }}
          durations={spec.durations as readonly number[]}
          projectId={projectId}
          onChange={(p) => update(s.id, p)}
          onMove={(d) => move(idx, d)}
          onRemove={() => setScenes((ss) => ss.filter((x) => x.id !== s.id))}
          onJob={(j) => {
            const list = scenes.map((x) => (x.id === s.id ? { ...x, job_ids: [j.id, ...x.job_ids] } : x));
            setScenes(list);
            persist({}, list);
          }}
        />
      ))}
      <Button onClick={() => setScenes((ss) => [...ss, newScene()])}><Plus className="size-4" /> Adicionar cena</Button>

      <Card className="flex flex-col gap-3">
        <p className="flex items-center gap-2 font-medium"><Film className="size-4" /> Montar sequência final</p>
        <p className="text-sm text-muted">{chosen.length} de {scenes.length} cenas com take escolhido. A montagem usa os takes escolhidos na ordem das cenas.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Transição">{(i) => <Select id={i} value={concat.transition} onChange={(e) => setConcat({ ...concat, transition: e.target.value as 'fade' })} options={[{ value: 'fade', label: 'Fade' }, { value: 'none', label: 'Corte seco' }]} />}</Field>
          <Field label="Música (licenciada)">{(i) => <Select id={i} value={concat.music_asset_id} onChange={(e) => setConcat({ ...concat, music_asset_id: e.target.value })} options={[{ value: '', label: 'Sem música' }, ...(music.data ?? []).filter((a) => a.probe_status === 'ok').map((a) => ({ value: a.id, label: a.name }))]} />}</Field>
          <Field label={`Volume da música: ${Math.round(concat.music_volume * 100)}%`}>{(i) => <input id={i} type="range" min={0} max={1} step={0.05} value={concat.music_volume} onChange={(e) => setConcat({ ...concat, music_volume: Number(e.target.value) })} />}</Field>
        </div>
        <CostConfirm
          kind="media.concat"
          params={{ aspect, resolution: 720, transition: concat.transition, music_asset_id: concat.music_asset_id || undefined, music_volume: concat.music_volume }}
          inputs={chosen}
          projectId={projectId}
          disabled={chosen.length < 1 ? 'Escolha o take de pelo menos uma cena.' : false}
          label="Montar sequência"
          onCreated={(j) => { const list = [j.id, ...concatJobs]; setConcatJobs(list); persist({ concat_jobs: list }); }}
        />
        {concatJobsQ.data?.map((j) => <JobCard key={j.id} job={j} />)}
      </Card>
    </div>
  );
}

function SceneCard({
  scene, index, total, prompt, canGenerate, blockReason, jobParams, durations, projectId, onChange, onMove, onRemove, onJob,
}: {
  scene: Scene; index: number; total: number; prompt: string; canGenerate: boolean; blockReason?: string; jobParams: Record<string, unknown>;
  durations: readonly number[]; projectId: string | null; onChange: (p: Partial<Scene>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onJob: (j: Job) => void;
}) {
  const jobs = useJobs({ ids: scene.job_ids });
  const outIds = useMemo(() => (jobs.data ?? []).flatMap((j) => j.output_asset_ids), [jobs.data]);
  const takes = useAssets({ ids: outIds });
  const [advanced, setAdvanced] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="font-display font-semibold">Cena {index + 1}</p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Subir"><ArrowUp className="size-4" /></Button>
          <Button size="sm" variant="ghost" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Descer"><ArrowDown className="size-4" /></Button>
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remover"><Trash2 className="size-4" /></Button>
        </div>
      </div>
      <Field label="Descrição da cena">
        {(i) => <Textarea id={i} placeholder="Meu personagem caminha por uma rua movimentada à noite, iluminação cinematográfica, câmera acompanhando…" value={scene.description} onChange={(e) => onChange({ description: e.target.value, prompt_override: undefined })} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Duração">{(i) => <Select id={i} value={String(scene.duration)} onChange={(e) => onChange({ duration: Number(e.target.value) })} options={durations.map((d) => ({ value: String(d), label: `${d} s` }))} />}</Field>
        <Field label="Movimento de câmera">{(i) => <Input id={i} placeholder="ex.: travelling acompanhando" value={scene.camera ?? ''} onChange={(e) => onChange({ camera: e.target.value, prompt_override: undefined })} />}</Field>
        <Field label="Intensidade do movimento">{(i) => <Select id={i} value={scene.motion ?? 'medium'} onChange={(e) => onChange({ motion: e.target.value as 'low', prompt_override: undefined })} options={[{ value: 'low', label: 'Baixa' }, { value: 'medium', label: 'Média' }, { value: 'high', label: 'Alta' }]} />}</Field>
      </div>
      <button className="self-start text-sm text-accent" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Menos opções' : 'Cenário, ação, enquadramento, estilo, luz e atmosfera'}</button>
      {advanced && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(['setting', 'action', 'framing', 'style', 'lighting', 'mood'] as const).map((k) => (
            <Field key={k} label={{ setting: 'Cenário', action: 'Ação', framing: 'Enquadramento', style: 'Estilo visual', lighting: 'Iluminação', mood: 'Atmosfera' }[k]}>
              {(i) => <Input id={i} value={scene[k] ?? ''} onChange={(e) => onChange({ [k]: e.target.value, prompt_override: undefined })} />}
            </Field>
          ))}
        </div>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Instrução enviada ao modelo ({prompt.length}/1000)</summary>
        <Textarea className="mt-2 text-xs" rows={4} value={prompt} onChange={(e) => onChange({ prompt_override: e.target.value })} />
      </details>
      <CostConfirm
        kind="ai.video"
        params={{ ...jobParams, seed: attempt || undefined }}
        projectId={projectId}
        disabled={!scene.description.trim() && !scene.prompt_override ? 'Descreva a cena.' : !canGenerate ? blockReason : false}
        label={scene.job_ids.length ? 'Regenerar esta cena' : 'Gerar cena'}
        onCreated={(j) => { onJob(j); setAttempt(Math.floor(Math.random() * 1e9)); }}
      />
      {jobs.data?.filter((j) => j.status !== 'succeeded').map((j) => <JobCard key={j.id} job={j} showOutputs={false} />)}
      {!!takes.data?.length && (
        <div>
          <p className="mb-2 text-sm">Takes ({takes.data.length}) — escolha um para a montagem: {scene.asset_id && <Badge tone="success">escolhido</Badge>}</p>
          <AssetGrid assets={takes.data} selected={scene.asset_id ? [scene.asset_id] : []} onSelect={(a) => onChange({ asset_id: a.id })} />
          <p className="mt-2 flex items-center gap-1 text-xs text-muted"><Wand2 className="size-3" /> Veja e baixe cada take na Biblioteca.</p>
        </div>
      )}
    </Card>
  );
}
