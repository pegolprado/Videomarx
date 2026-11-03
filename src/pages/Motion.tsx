import { Check, Clapperboard } from 'lucide-react';
import { useState } from 'react';
import type { Aspect, MotionPalette, MotionParams, MotionTemplate } from '@shared/jobs';
import { MOTION_LIMITS, MOTION_PALETTES, MOTION_TEMPLATES, planMotion, validateMotion } from '@shared/motion';
import { AssetThumb } from '@/components/Assets';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { Badge, Card, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useAssets, useJobs } from '@/lib/hooks';

/** Modelos animados (HyperFrames): textos + imagens da biblioteca → vídeo com animações, grátis no nosso servidor. */
export default function Motion() {
  const motion = useIntegration('motion');
  const images = useAssets({ kind: 'image', limit: 60 });
  const audios = useAssets({ kind: 'audio', limit: 60 });
  const [template, setTemplate] = useState<MotionTemplate>('kinetic');
  const [palette, setPalette] = useState<MotionPalette>('noite');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [cta, setCta] = useState('');
  const [seconds, setSeconds] = useState(3);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [audioId, setAudioId] = useState('');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const jobs = useJobs({ ids: jobIds });

  const okImages = (images.data ?? []).filter((a) => a.probe_status === 'ok');
  const okAudios = (audios.data ?? []).filter((a) => a.probe_status === 'ok');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const params: MotionParams = { template, palette, aspect, title: title.trim(), lines, cta: cta.trim() || undefined, seconds_per_item: seconds };
  const plan = planMotion(params, imageIds);
  const invalid = validateMotion(params, imageIds.length);
  const toggle = (id: string) =>
    setImageIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MOTION_LIMITS.maxImages ? ids : [...ids, id]));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Modelos animados"
        subtitle="Escreva frases, escolha imagens e um modelo: o servidor monta um vídeo com textos e imagens animados. Grátis, sem IA paga."
      />
      <IntegrationGate provider="motion" feature="Modelos animados (HyperFrames)" />

      <Card className="flex flex-col gap-3">
        <p className="font-medium">1. Modelo</p>
        <div className="grid gap-2 md:grid-cols-3">
          {MOTION_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition ${template === t.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface-2'}`}
            >
              <span className="flex items-center gap-2 font-medium"><Clapperboard className="size-4" /> {t.label}</span>
              <span className="text-xs text-muted">{t.description}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Proporção">
            {(i) => <Select id={i} value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} options={[{ value: '9:16', label: 'Vertical 9:16 (Reels, TikTok)' }, { value: '16:9', label: 'Horizontal 16:9 (YouTube)' }, { value: '1:1', label: 'Quadrado 1:1' }]} />}
          </Field>
          <Field label="Cores">
            {(i) => <Select id={i} value={palette} onChange={(e) => setPalette(e.target.value as MotionPalette)} options={Object.entries(MOTION_PALETTES).map(([id, p]) => ({ value: id, label: p.label }))} />}
          </Field>
          <Field label={`Segundos por frase/imagem: ${seconds}`}>
            {(i) => <input id={i} type="range" min={MOTION_LIMITS.minSeconds} max={MOTION_LIMITS.maxSeconds} step={0.5} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />}
          </Field>
        </div>
        <div className="flex gap-2">
          {(['bg', 'bg2', 'accent', 'ink'] as const).map((k) => (
            <span key={k} className="size-6 rounded-full border border-line" style={{ background: MOTION_PALETTES[palette][k] }} />
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <p className="font-medium">2. Textos</p>
        <Field label="Título (abre o vídeo)">{(i) => <Input id={i} maxLength={MOTION_LIMITS.maxTitle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Promoção de verão" />}</Field>
        <Field label="Frases (uma por linha — cada linha vira uma cena)" hint={`Até ${MOTION_LIMITS.maxLines} frases.`}>
          {(i) => <Textarea id={i} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Tudo com até 50% de desconto\nEntrega grátis\nSó até domingo'} />}
        </Field>
        <Field label="Chamada final (opcional)">{(i) => <Input id={i} maxLength={MOTION_LIMITS.maxLineChars} value={cta} onChange={(e) => setCta(e.target.value)} placeholder="Ex.: Siga para mais dicas!" />}</Field>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">3. Imagens {template === 'showcase' ? '(obrigatório)' : '(opcional)'}</p>
          <Badge>{imageIds.length} escolhida{imageIds.length === 1 ? '' : 's'}</Badge>
        </div>
        {okImages.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma imagem na biblioteca. Envie na Biblioteca ou gere em Imagens.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
            {okImages.map((a) => {
              const n = imageIds.indexOf(a.id);
              return (
                <button key={a.id} type="button" onClick={() => toggle(a.id)} className={`relative rounded-xl border-2 ${n >= 0 ? 'border-accent' : 'border-transparent'}`} aria-pressed={n >= 0} title={a.name}>
                  <AssetThumb asset={a} />
                  {n >= 0 && <span className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-accent text-xs font-bold text-white">{n + 1}</span>}
                </button>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted">A ordem dos números é a ordem no vídeo. Se houver mais frases que imagens, elas se repetem.</p>
        <Field label="Música ou narração (opcional)">
          {(i) => <Select id={i} value={audioId} onChange={(e) => setAudioId(e.target.value)} options={[{ value: '', label: 'Sem áudio' }, ...okAudios.map((a) => ({ value: a.id, label: a.name }))]} />}
        </Field>
      </Card>

      <Card className="flex flex-col gap-3">
        <p className="flex items-center gap-2 font-medium"><Check className="size-4" /> Resumo</p>
        <p className="text-sm text-muted">
          {plan.scenes.length} cena{plan.scenes.length === 1 ? '' : 's'} · cerca de {Math.round(plan.duration)} s · {plan.width}×{plan.height}
        </p>
        {plan.duration >= MOTION_LIMITS.maxTotal && <Notice tone="warning">O vídeo foi limitado a {MOTION_LIMITS.maxTotal} s. Use menos frases ou menos segundos por frase.</Notice>}
        <CostConfirm
          kind="media.motion"
          params={params as unknown as Record<string, unknown>}
          inputs={[...imageIds, ...(audioId ? [audioId] : [])]}
          disabled={!motion.ok ? motion.reason : invalid ?? false}
          label="Criar vídeo animado"
          onCreated={(j) => setJobIds((ids) => [j.id, ...ids])}
        />
        {jobs.data?.map((j) => <JobCard key={j.id} job={j} />)}
      </Card>
    </div>
  );
}
