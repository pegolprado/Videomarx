import { clsx } from 'clsx';
import { CheckCircle2, Lock, Scissors } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatBytes, formatDuration } from '@shared/format';
import { availableModes, qualityWarnings, type SourceCheck, type TransformEngine, type TransformModeId } from '@shared/transform';

const ENGINE_LABEL: Record<TransformEngine, string> = {
  hf: 'GRÁTIS — GPU do Hugging Face (limite diário, mais lento)',
  fal: 'fal.ai — Wan 2.2 Animate (pago, barato)',
  runway: 'Runway (pago)',
};
import { AssetGrid, UploadBox } from '@/components/Assets';
import { CharacterSelect } from '@/components/CharacterSelect';
import { CostConfirm } from '@/components/CostConfirm';
import { JobCard } from '@/components/JobCard';
import { MediaPreview } from '@/components/MediaPreview';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useAssets, useCapabilities, useCharacters, useJobs, usePlan, usePrices, useSignedUrl } from '@/lib/hooks';
import { createProject, saveProject, useProjectRow } from '@/lib/projects';
import type { Asset, Job } from '@/lib/types';

function Step({ n, title, done, children, locked }: { n: number; title: string; done?: boolean; locked?: boolean; children: React.ReactNode }) {
  return (
    <Card className={clsx('flex flex-col gap-4', locked && 'opacity-50')}>
      <div className="flex items-center gap-3">
        <span className={clsx('grid size-7 place-items-center rounded-full text-sm font-semibold', done ? 'bg-success text-white' : 'bg-surface-2')}>
          {done ? <CheckCircle2 className="size-4" /> : n}
        </span>
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {locked && <Lock className="size-4 text-muted" />}
      </div>
      {!locked && children}
    </Card>
  );
}

function Frame({ path }: { path: string }) {
  const url = useSignedUrl(path);
  return <div className="aspect-video overflow-hidden rounded-lg bg-surface-2">{url && <img src={url} alt="Quadro do vídeo" className="size-full object-cover" />}</div>;
}

export default function Transform() {
  const [params] = useSearchParams();
  const [sourceId, setSourceId] = useState<string | null>(params.get('video'));
  const [check, setCheck] = useState<SourceCheck>({ multiplePeople: false, partiallyHidden: false, fastMotion: false, faceNotVisible: false });
  const [confirmedPerson, setConfirmedPerson] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState<number | null>(null);
  const [characterId, setCharacterId] = useState('');
  const [mode, setMode] = useState<TransformModeId>('full_body');
  const [opts, setOpts] = useState({ expression_intensity: 3, body_control: true, scene_prompt: '', outfit: 'character' as 'original' | 'character' | 'new', new_outfit: '', intensity: 'medium' as 'subtle' | 'medium' | 'strong', use_character_keyframe: true });
  const [rights, setRights] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(params.get('projeto'));
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [enginePref, setEnginePref] = useState<TransformEngine>('hf');
  const [falRes, setFalRes] = useState<'480p' | '580p' | '720p'>('480p');

  const videos = useAssets({ kind: 'video', categories: ['original'] });
  const source = videos.data?.find((v) => v.id === sourceId) ?? null;
  const caps = useCapabilities();
  const modes = availableModes(caps.data);
  const chars = useCharacters();
  const character = chars.data?.find((c) => c.id === characterId);
  const plan = usePlan();
  const prices = usePrices();
  const jobs = useJobs({ ids: jobIds });
  const project = useProjectRow(params.get('projeto'));

  // reabrir projeto salvo
  useEffect(() => {
    const d = project.data?.data as { source_asset_id?: string; mode?: TransformModeId; character_id?: string; jobs?: string[] } | undefined;
    if (!d) return;
    if (d.source_asset_id) setSourceId(d.source_asset_id);
    if (d.mode) setMode(d.mode);
    if (d.character_id) setCharacterId(d.character_id);
    if (d.jobs) setJobIds(d.jobs);
  }, [project.data]);

  useEffect(() => {
    if (source?.duration_s) {
      setStart(0);
      setEnd(Math.min(Number(source.duration_s), plan.data?.max_video_seconds ?? 15));
    }
  }, [source?.id, source?.duration_s, plan.data?.max_video_seconds]);

  const duration = source?.duration_s ? Number(source.duration_s) : 0;
  const clipLen = Math.max(0, (end ?? duration) - start);
  const sel = modes.find((m) => m.mode.id === mode);
  const engine: TransformEngine = sel?.engines.includes(enginePref) ? enginePref : (sel?.engines[0] ?? 'runway');
  // fal e hf usam o mesmo modelo (Wan 2.2 Animate): sem as opções do Act-Two
  const isFal = engine !== 'runway';
  const isHf = engine === 'hf';
  const mainKey = isHf ? 'hf.animate' : isFal ? `fal.animate.${falRes}` : mode === 'full_body' || mode === 'cinematic' ? 'runway.act_two' : 'runway.aleph2';
  const limits = prices.data?.find((p) => p.key === mainKey);
  const warnings = qualityWarnings(check, mode);

  const jobParams = useMemo(
    () => ({
      engine,
      ...(engine === 'fal' ? { resolution: falRes } : {}),
      mode,
      character_id: characterId,
      rights_confirmed: rights,
      trim_start: start,
      trim_end: end ?? duration,
      seed,
      ...(mode === 'full_body' || mode === 'cinematic' ? { expression_intensity: opts.expression_intensity, body_control: opts.body_control } : {}),
      ...(mode === 'cinematic' || mode === 'stylized' || mode === 'appearance' ? { scene_prompt: opts.scene_prompt } : {}),
      ...(mode === 'appearance' || mode === 'stylized' ? { outfit: opts.outfit, new_outfit: opts.new_outfit, intensity: opts.intensity, use_character_keyframe: opts.use_character_keyframe } : {}),
    }),
    [engine, falRes, mode, characterId, rights, start, end, duration, opts, seed],
  );

  const blocker = !source
    ? 'Escolha um vídeo.'
    : source.probe_status !== 'ok'
      ? 'Aguarde a análise do vídeo.'
      : !confirmedPerson
        ? 'Confira a prévia e confirme a pessoa a ser transformada.'
        : !character
          ? 'Escolha um personagem.'
          : !character.primary_image_id
            ? 'O personagem precisa de uma imagem principal.'
            : !sel?.available
              ? `Modo indisponível: ${sel?.reason}`
              : mode === 'cinematic' && !isFal && !opts.scene_prompt.trim()
                ? 'Descreva o cenário da nova cena.'
                : !rights
                  ? 'Confirme os direitos de uso do vídeo.'
                  : false;

  async function onCreated(job: Job) {
    setJobIds((ids) => [job.id, ...ids]);
    const data = { source_asset_id: sourceId, mode, character_id: characterId, trim: [start, end], jobs: [job.id, ...jobIds] };
    if (projectId) await saveProject(projectId, { data });
    else {
      const p = await createProject({ name: `${source?.name ?? 'Vídeo'} → ${character?.name ?? ''}`.slice(0, 120), type: 'transform', aspect: (source?.metadata.aspect as '9:16') ?? '9:16', character_id: characterId || null, data });
      setProjectId(p.id);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Transformar vídeo" subtitle="Use um vídeo seu ou autorizado e substitua a pessoa por um personagem digital." />

      <Step n={1} title="Vídeo" done={!!source && source.probe_status === 'ok'}>
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div>
            {videos.data?.length ? (
              <AssetGrid assets={videos.data.slice(0, 12)} selected={sourceId ? [sourceId] : []} onSelect={(a: Asset) => { setSourceId(a.id); setConfirmedPerson(false); }} />
            ) : (
              <p className="text-sm text-muted">Envie um vídeo para começar.</p>
            )}
          </div>
          <UploadBox kind="video" onUploaded={(a) => { setSourceId(a.id); setConfirmedPerson(false); }} />
        </div>
        {source?.probe_status === 'invalid' && <Notice tone="danger">Arquivo inválido: {String(source.metadata.invalid_reason ?? 'não foi possível ler o vídeo')}</Notice>}
      </Step>

      <Step n={2} title="Análise e prévia" locked={!source || source.probe_status !== 'ok'} done={confirmedPerson}>
        {source && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>Duração {formatDuration(duration)}</Badge>
              <Badge>{source.width}×{source.height}</Badge>
              <Badge>Proporção {String(source.metadata.aspect ?? '—')}</Badge>
              <Badge>{source.has_audio ? 'Com áudio' : 'Sem áudio'}</Badge>
              <Badge>{formatBytes(source.size_bytes)}</Badge>
            </div>
            <div className="grid grid-cols-3 gap-2">{(source.metadata.preview_frames ?? []).map((f) => <Frame key={f} path={f} />)}</div>
            <Notice title="Detecção automática de pessoas: integração pendente">
              Ainda não há um modelo de detecção conectado. Confira os quadros acima e informe o que você vê — a primeira versão funciona melhor com uma única pessoa claramente visível.
            </Notice>
            <div className="grid gap-2 sm:grid-cols-2">
              <Checkbox checked={check.multiplePeople} onChange={(v) => setCheck({ ...check, multiplePeople: v })}>Aparece mais de uma pessoa</Checkbox>
              <Checkbox checked={check.partiallyHidden} onChange={(v) => setCheck({ ...check, partiallyHidden: v })}>A pessoa fica parcialmente escondida ou sai do quadro</Checkbox>
              <Checkbox checked={check.fastMotion} onChange={(v) => setCheck({ ...check, fastMotion: v })}>Há movimentos muito rápidos</Checkbox>
              <Checkbox checked={check.faceNotVisible} onChange={(v) => setCheck({ ...check, faceNotVisible: v })}>O rosto não fica visível o tempo todo</Checkbox>
            </div>
            {warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
            <Button variant={confirmedPerson ? 'secondary' : 'primary'} onClick={() => setConfirmedPerson(true)}>
              {confirmedPerson ? 'Pessoa confirmada' : 'A pessoa principal do vídeo é quem será transformada'}
            </Button>
          </>
        )}
      </Step>

      <Step n={3} title="Trecho" locked={!confirmedPerson} done={confirmedPerson && clipLen > 0}>
        {source && (
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <MediaPreview asset={source} />
            <div className="flex flex-col gap-3">
              <Field label="Início (s)">{(i) => <Input id={i} type="number" min={0} max={duration} step={0.1} value={start} onChange={(e) => setStart(Math.max(0, Number(e.target.value)))} />}</Field>
              <Field label="Fim (s)">{(i) => <Input id={i} type="number" min={0} max={duration} step={0.1} value={end ?? duration} onChange={(e) => setEnd(Math.min(duration, Number(e.target.value)))} />}</Field>
              <p className="text-sm">Trecho selecionado: <strong>{clipLen.toFixed(1)} s</strong></p>
              <Button size="sm" onClick={() => setEnd(Math.min(duration, start + Math.max(limits?.min_seconds ?? 3, 3)))}>
                <Scissors className="size-3.5" /> Testar com trecho curto ({Math.max(limits?.min_seconds ?? 3, 3)} s)
              </Button>
              <p className="text-xs text-muted">
                Limites: seu plano permite até {plan.data?.max_video_seconds ?? '—'} s; {limits?.label ?? 'o modelo'} aceita de {limits?.min_seconds ?? '—'} a {limits?.max_seconds ?? '—'} s.
              </p>
            </div>
          </div>
        )}
      </Step>

      <Step n={4} title="Personagem e modo" locked={!confirmedPerson}>
        <Field label="Personagem substituto" hint={<Link to="/personagens/novo" className="text-accent">Criar novo personagem</Link>}>
          {(i) => <CharacterSelect id={i} value={characterId} onChange={setCharacterId} />}
        </Field>
        {character && !character.primary_image_id && (
          <Notice tone="warning">
            Este personagem ainda não tem imagem principal. <Link to={`/personagens/${character.id}`} className="underline">Adicione ou gere uma</Link>.
          </Notice>
        )}
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {modes.map(({ mode: m, available, reason }) => (
            <button
              key={m.id}
              type="button"
              disabled={!available}
              onClick={() => setMode(m.id)}
              className={clsx('flex flex-col gap-1.5 rounded-xl border p-3 text-left transition', mode === m.id ? 'border-accent ring-2 ring-accent/30' : 'border-line', available ? 'hover:border-accent/60' : 'cursor-not-allowed opacity-60')}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">Modo {m.letter} — {m.title}</span>
                {!available && <Badge tone="warning">{reason}</Badge>}
              </span>
              <span className="text-xs text-muted">{m.summary}</span>
            </button>
          ))}
        </div>
        {sel?.available && (sel.engines.length > 1 || (isFal && !isHf)) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {sel.engines.length > 1 && (
              <Field label="Motor">
                {(i) => <Select id={i} value={engine} onChange={(e) => setEnginePref(e.target.value as TransformEngine)} options={sel.engines.map((en) => ({ value: en, label: ENGINE_LABEL[en] }))} />}
              </Field>
            )}
            {isFal && !isHf && (
              <Field label="Qualidade" hint="Quanto maior, mais caro e mais demorado.">
                {(i) => <Select id={i} value={falRes} onChange={(e) => setFalRes(e.target.value as '480p')} options={[{ value: '480p', label: '480p — econômica' }, { value: '580p', label: '580p — intermediária' }, { value: '720p', label: '720p — melhor qualidade' }]} />}
              </Field>
            )}
          </div>
        )}
        {sel && (
          <Notice title="Como funciona">
            {isHf && sel.mode.howHf ? sel.mode.howHf : isFal && sel.mode.howFal ? sel.mode.howFal : sel.mode.how}{' '}
            <span className="text-muted">
              {isHf
                ? 'Trecho de 2 a 8 s. O áudio original é mantido. Se a cota do dia acabar, a tarefa avisa e não cobra nada.'
                : isFal
                  ? 'Trecho de 1 a 15 s. O áudio original do vídeo é mantido.'
                  : sel.mode.limits}
            </span>
          </Notice>
        )}
        {(mode === 'full_body' || mode === 'cinematic') && !isFal && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Intensidade das expressões: ${opts.expression_intensity}`}>
              {(i) => <input id={i} type="range" min={1} max={5} value={opts.expression_intensity} onChange={(e) => setOpts({ ...opts, expression_intensity: Number(e.target.value) })} />}
            </Field>
            <Checkbox checked={opts.body_control} onChange={(v) => setOpts({ ...opts, body_control: v })}>
              Transferir também gestos e movimento do corpo (não só o rosto)
            </Checkbox>
          </div>
        )}
        {(mode === 'appearance' || mode === 'stylized') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Roupa">
              {(i) => (
                <Select id={i} value={opts.outfit} onChange={(e) => setOpts({ ...opts, outfit: e.target.value as 'original' })} options={[{ value: 'character', label: 'Usar a roupa do personagem' }, { value: 'original', label: 'Preservar a roupa original' }, { value: 'new', label: 'Gerar um figurino novo' }]} />
              )}
            </Field>
            {opts.outfit === 'new' && <Field label="Figurino novo">{(i) => <Input id={i} value={opts.new_outfit} onChange={(e) => setOpts({ ...opts, new_outfit: e.target.value })} />}</Field>}
            <Field label="Intensidade da transformação">
              {(i) => <Select id={i} value={opts.intensity} onChange={(e) => setOpts({ ...opts, intensity: e.target.value as 'medium' })} options={[{ value: 'subtle', label: 'Sutil' }, { value: 'medium', label: 'Média' }, { value: 'strong', label: 'Forte' }]} />}
            </Field>
            <Checkbox checked={opts.use_character_keyframe} onChange={(v) => setOpts({ ...opts, use_character_keyframe: v })}>
              Gerar um quadro-guia com o personagem (melhora a fidelidade; custa uma imagem a mais)
            </Checkbox>
          </div>
        )}
        {(mode === 'stylized' || mode === 'appearance' || (mode === 'cinematic' && !isFal)) && (
          <Field label={mode === 'cinematic' ? 'Cenário da nova cena (obrigatório)' : 'Estilo/ajustes extras (opcional)'}>
            {(i) => <Textarea id={i} maxLength={600} placeholder={mode === 'cinematic' ? 'ex.: telhado de um prédio em Tóquio à noite, chuva leve, luzes neon' : 'ex.: visual anime com contornos marcados'} value={opts.scene_prompt} onChange={(e) => setOpts({ ...opts, scene_prompt: e.target.value })} />}
          </Field>
        )}
      </Step>

      <Step n={5} title="Confirmar e processar" locked={!confirmedPerson}>
        <Checkbox checked={rights} onChange={setRights}>
          Confirmo que tenho direitos ou autorização para usar e modificar este vídeo e a imagem das pessoas que aparecem nele, e que o resultado não será usado para enganar, fraudar ou assediar.
        </Checkbox>
        <CostConfirm
          kind="ai.transform"
          params={jobParams}
          inputs={sourceId ? [sourceId] : []}
          projectId={projectId}
          disabled={blocker}
          label="Transformar vídeo"
          extraWarning={warnings.length ? 'Há avisos de qualidade para este vídeo.' : undefined}
          onCreated={onCreated}
        />
      </Step>

      {jobs.data && jobs.data.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-semibold">Resultado</h2>
          {jobs.data.map((j) => (
            <div key={j.id} className="flex flex-col gap-2">
              <JobCard job={j} onRetry={() => setSeed(Math.floor(Math.random() * 1e9))} />
              {j.status === 'succeeded' && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>Gerar outra variação</Button>
                  <Link to={`/editor?asset=${j.output_asset_ids[0]}`}><Button size="sm">Editar e exportar</Button></Link>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-muted">Revise o resultado: rostos mudando entre quadros, mãos deformadas ou tremulação podem acontecer. Ajuste o trecho ou o modo e gere outra variação.</p>
        </section>
      )}
    </div>
  );
}
