import { Copy, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { CharacterSelect } from '@/components/CharacterSelect';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useJobs } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import type { Script } from '@/lib/types';

interface Pack {
  ideas: { title: string; hook: string; summary: string }[];
  script: { title: string; hook: string; development: string; climax: string; conclusion: string; cta: string; lines: { speaker: string; text: string; approx_seconds: number }[] };
  scenes: { description_pt: string; visual_prompt_en: string; camera: string; duration_seconds: number }[];
  caption: string;
  titles: string[];
  description: string;
  hashtags: string[];
  cover_suggestion: string;
  variations: { label: string; hook: string; script: string }[];
}

const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success('Copiado.'));

export default function Viral() {
  const [form, setForm] = useState({ plataforma: 'TikTok', nicho: '', publico: '', objetivo: 'Engajamento', duracao: '30 segundos', tom: 'Divertido', estilo_de_edicao: 'Cortes rápidos com legendas', idioma: 'Português (Brasil)', tema: '' });
  const [characterId, setCharacterId] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const jobs = useJobs({ ids: jobId ? [jobId] : [] });
  const anthropic = useIntegration('anthropic');
  const history = useQuery({
    queryKey: ['scripts'],
    queryFn: async () => {
      const { data } = await supabase.from('scripts').select('*').order('created_at', { ascending: false }).limit(10);
      return (data ?? []) as Script[];
    },
  });

  useEffect(() => {
    const j = jobs.data?.[0];
    if (j?.status === 'succeeded' && j.result) {
      setPack(j.result as unknown as Pack);
      history.refetch();
    }
  }, [jobs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Criar conteúdo viral" subtitle="Ideias, ganchos, roteiro, cenas, legendas e hashtags — com potencial de engajamento, sem promessas de viralização." />
      <IntegrationGate provider="anthropic" feature="Roteiros com IA" />
      <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-3">
          <Field label="Tema ou ideia do vídeo">{(i) => <Textarea id={i} value={form.tema} onChange={(e) => set('tema', e.target.value)} placeholder="ex.: 3 erros comuns ao começar na academia" />}</Field>
        </div>
        <Field label="Plataforma">{(i) => <Select id={i} value={form.plataforma} onChange={(e) => set('plataforma', e.target.value)} options={['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Kwai', 'Facebook Reels'].map((v) => ({ value: v, label: v }))} />}</Field>
        <Field label="Nicho">{(i) => <Input id={i} value={form.nicho} onChange={(e) => set('nicho', e.target.value)} placeholder="ex.: fitness" />}</Field>
        <Field label="Personagem">{(i) => <CharacterSelect id={i} allowNone value={characterId} onChange={setCharacterId} />}</Field>
        <Field label="Público pretendido">{(i) => <Input id={i} value={form.publico} onChange={(e) => set('publico', e.target.value)} />}</Field>
        <Field label="Objetivo">{(i) => <Select id={i} value={form.objetivo} onChange={(e) => set('objetivo', e.target.value)} options={['Engajamento', 'Seguidores', 'Vendas', 'Educação', 'Entretenimento', 'Divulgar marca'].map((v) => ({ value: v, label: v }))} />}</Field>
        <Field label="Duração">{(i) => <Select id={i} value={form.duracao} onChange={(e) => set('duracao', e.target.value)} options={['15 segundos', '30 segundos', '45 segundos', '60 segundos', '90 segundos'].map((v) => ({ value: v, label: v }))} />}</Field>
        <Field label="Tom">{(i) => <Select id={i} value={form.tom} onChange={(e) => set('tom', e.target.value)} options={['Divertido', 'Inspirador', 'Educativo', 'Polêmico respeitoso', 'Misterioso', 'Emocionante', 'Profissional'].map((v) => ({ value: v, label: v }))} />}</Field>
        <Field label="Estilo de edição">{(i) => <Input id={i} value={form.estilo_de_edicao} onChange={(e) => set('estilo_de_edicao', e.target.value)} />}</Field>
        <Field label="Idioma">{(i) => <Select id={i} value={form.idioma} onChange={(e) => set('idioma', e.target.value)} options={['Português (Brasil)', 'Inglês', 'Espanhol'].map((v) => ({ value: v, label: v }))} />}</Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <Notice>Sem fonte de dados de tendências conectada: o sistema não usa nem inventa estatísticas, números de visualizações ou tendências.</Notice>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <CostConfirm kind="ai.text" params={{ task: 'social_pack', character_id: characterId || undefined, input: form }} disabled={!anthropic.ok ? anthropic.reason : !form.tema.trim() ? 'Descreva o tema.' : false} label="Gerar conteúdo" onCreated={(j) => { setJobId(j.id); setPack(null); }} />
        </div>
      </Card>
      {jobs.data?.map((j) => j.status !== 'succeeded' && <JobCard key={j.id} job={j} showOutputs={false} />)}
      {pack && <PackView pack={pack} />}
      {!!history.data?.length && (
        <Card>
          <p className="mb-2 flex items-center gap-2 font-medium"><History className="size-4" /> Roteiros salvos</p>
          <ul className="divide-y divide-line text-sm">
            {history.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <button className="truncate text-left hover:text-accent" onClick={() => s.content.task === 'social_pack' && setPack(s.content.output as unknown as Pack)}>{s.title}</button>
                <span className="shrink-0 text-xs text-muted">{s.platform ?? s.content.task} · {new Date(s.created_at).toLocaleDateString('pt-BR')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
        <button onClick={() => copy(text)} className="text-muted hover:text-fg" aria-label={`Copiar ${title}`}><Copy className="size-3.5" /></button>
      </div>
      <p className="whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}

function PackView({ pack }: { pack: Pack }) {
  const fullScript = pack.script.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <p className="font-display text-lg font-semibold">{pack.script.title}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Block title="Gancho inicial" text={pack.script.hook} />
          <Block title="Desenvolvimento" text={pack.script.development} />
          <Block title="Momento principal" text={pack.script.climax} />
          <Block title="Conclusão" text={pack.script.conclusion} />
          <Block title="Chamada para ação" text={pack.script.cta} />
          <Block title="Falas do personagem" text={fullScript} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/voz" state={{ text: pack.script.lines.map((l) => l.text).join(' ') }}><Button size="sm">Gerar a narração</Button></Link>
          <Link to="/gerar"><Button size="sm">Gerar as cenas</Button></Link>
        </div>
      </Card>
      <Card className="flex flex-col gap-2">
        <p className="font-medium">Cenas sugeridas</p>
        {pack.scenes.map((s, i) => (
          <div key={i} className="rounded-xl bg-surface-2 p-3 text-sm">
            <p><Badge>{s.duration_seconds} s</Badge> {s.description_pt}</p>
            <p className="mt-1 text-xs text-muted">Câmera: {s.camera}</p>
            <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer">Instrução visual</summary>{s.visual_prompt_en}</details>
          </div>
        ))}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <Block title="Legenda do post" text={pack.caption} />
          <Block title="Descrição" text={pack.description} />
          <Block title="Hashtags" text={pack.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')} />
          <Block title="Sugestão de capa" text={pack.cover_suggestion} />
        </Card>
        <Card className="flex flex-col gap-2">
          <Block title="Títulos" text={pack.titles.join('\n')} />
          <p className="text-sm font-medium">Ideias</p>
          {pack.ideas.map((i) => <Block key={i.title} title={i.title} text={`${i.hook}\n${i.summary}`} />)}
        </Card>
      </div>
      <Card className="flex flex-col gap-2">
        <p className="font-medium">Variações do roteiro</p>
        {pack.variations.map((v) => <Block key={v.label} title={v.label} text={`Gancho: ${v.hook}\n\n${v.script}`} />)}
      </Card>
    </div>
  );
}
