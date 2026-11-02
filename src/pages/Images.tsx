import { useEffect, useState } from 'react';
import type { Aspect } from '@shared/jobs';
import { AssetGrid } from '@/components/Assets';
import { CharacterSelect } from '@/components/CharacterSelect';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { Card, Field, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useAssets, useJobs } from '@/lib/hooks';

const PURPOSES = [
  { value: 'portrait', label: 'Retrato' },
  { value: 'full_body', label: 'Corpo inteiro' },
  { value: 'pose', label: 'Pose específica' },
  { value: 'expression', label: 'Expressão facial' },
  { value: 'scene', label: 'Personagem em cenário' },
  { value: 'cover', label: 'Capa / miniatura de vídeo' },
  { value: 'custom', label: 'Livre (cenário, iluminação, câmera…)' },
];

export default function Images() {
  const [characterId, setCharacterId] = useState('');
  const [view, setView] = useState('scene');
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [model, setModel] = useState('gen4_image');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const jobs = useJobs({ ids: jobIds });
  const gallery = useAssets({ kind: 'image', categories: ['generated', 'reference'], limit: 40 });
  const runway = useIntegration('runway');
  const cloudflare = useIntegration('cloudflare');
  const [engine, setEngine] = useState<'cloudflare' | 'runway'>('cloudflare');
  useEffect(() => {
    if (!cloudflare.ok && runway.ok) setEngine('runway');
  }, [cloudflare.ok, runway.ok]);
  const active = engine === 'cloudflare' ? cloudflare : runway;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Imagens de referência" subtitle="Retratos, poses, roupas, cenários, capas e miniaturas — salvos na biblioteca do personagem." />
      <IntegrationGate provider={engine} feature={engine === 'cloudflare' ? 'Imagens grátis (Cloudflare)' : 'Imagens (Runway)'} />
      <Card className="grid gap-4 md:grid-cols-2">
        <Field label="Personagem (opcional)" hint="Com personagem, as imagens de referência dele são usadas para manter a identidade.">
          {(i) => <CharacterSelect id={i} allowNone value={characterId} onChange={setCharacterId} />}
        </Field>
        <Field label="Tipo de imagem">{(i) => <Select id={i} value={view} onChange={(e) => setView(e.target.value)} options={PURPOSES} />}</Field>
        <div className="md:col-span-2">
          <Field label="Descrição" hint="Roupa, cenário, iluminação, ângulo de câmera…">
            {(i) => <Textarea id={i} maxLength={800} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="ex.: no topo de um prédio ao pôr do sol, luz dourada lateral, câmera baixa" />}
          </Field>
        </div>
        <Field label="Proporção">{(i) => <Select id={i} value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} options={[{ value: '9:16', label: 'Vertical 9:16' }, { value: '16:9', label: 'Horizontal 16:9' }, { value: '1:1', label: 'Quadrado 1:1' }]} />}</Field>
        <Field label="Motor de imagem">
          {(i) => (
            <Select
              id={i}
              value={engine === 'cloudflare' ? 'cloudflare' : model}
              onChange={(e) => {
                if (e.target.value === 'cloudflare') setEngine('cloudflare');
                else {
                  setEngine('runway');
                  setModel(e.target.value);
                }
              }}
              options={[
                { value: 'cloudflare', label: `FLUX.1 schnell via Cloudflare — grátis (cota diária)${cloudflare.ok ? '' : ' — não configurado'}` },
                { value: 'gen4_image', label: `Runway Gen-4 Image — pago, usa as referências do personagem${runway.ok ? '' : ' — não configurado'}` },
                { value: 'gen4_image_turbo', label: 'Runway Gen-4 Image Turbo — pago (exige personagem com referência)' },
              ]}
            />
          )}
        </Field>
        {engine === 'cloudflare' && characterId && <div className="md:col-span-2"><Notice>O motor grátis usa só a descrição do personagem (não as imagens de referência), então a aparência pode variar entre imagens.</Notice></div>}
        {engine === 'runway' && model === 'gen4_image_turbo' && !characterId && <div className="md:col-span-2"><Notice tone="warning">O Turbo exige um personagem com imagem de referência.</Notice></div>}
        <div className="md:col-span-2">
          <CostConfirm
            kind="ai.image"
            params={{ engine, model, character_id: characterId || undefined, view, prompt, aspect }}
            disabled={!active.ok ? active.reason : !prompt.trim() && !characterId ? 'Descreva a imagem.' : engine === 'runway' && model === 'gen4_image_turbo' && !characterId ? 'Escolha um personagem.' : false}
            label="Gerar imagem"
            onCreated={(j) => setJobIds((ids) => [j.id, ...ids])}
          />
        </div>
      </Card>
      {jobs.data?.map((j) => <JobCard key={j.id} job={j} />)}
      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Imagens recentes</h2>
        {gallery.data?.length ? <AssetGrid assets={gallery.data} /> : <p className="text-sm text-muted">Nenhuma imagem gerada ainda.</p>}
        <p className="mt-2 text-xs text-muted">Para definir a referência principal de um personagem, abra o personagem e toque na imagem desejada. Versões novas nunca apagam as anteriores.</p>
      </section>
    </div>
  );
}
