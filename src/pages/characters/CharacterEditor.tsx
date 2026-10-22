import { ArrowLeft, Copy, Save, Star, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RUNWAY_VOICE_PRESETS, TTS_LANGUAGES } from '@shared/voices';
import { characterDescriptor, VIEW_PROMPTS } from '@shared/prompt';
import { AssetGrid, UploadBox } from '@/components/Assets';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration } from '@/components/IntegrationGate';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select, Spinner, Textarea } from '@/components/ui';
import { useAssets, useJobs } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { Character } from '@/lib/types';
import { JobCard } from '@/components/JobCard';
import { AGE_OPTIONS, APPEARANCE_FIELDS, KIND_OPTIONS } from './options';

type Form = Omit<Character, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'archived' | 'primary_image_id' | 'parent_id' | 'version_label' | 'is_favorite'>;

const EMPTY: Form = {
  name: '', kind: 'realistic', description: '', appearance: {}, personality: '', expressions: '', speaking_style: '', preferred_settings: '',
  reference_poses: '', custom_instructions: '', voice: { language: 'pt' },
};

const VIEWS: { view: string; label: string }[] = [
  { view: 'portrait', label: 'Retrato' },
  { view: 'front', label: 'Vista frontal' },
  { view: 'side', label: 'Vista lateral' },
  { view: 'full_body', label: 'Corpo inteiro' },
  { view: 'expression', label: 'Expressão' },
  { view: 'pose', label: 'Pose' },
];

export default function CharacterEditor() {
  const { id } = useParams();
  const isNew = id === 'novo';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState('front');
  const [extra, setExtra] = useState('');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const runway = useIntegration('runway');

  const char = useQuery({
    queryKey: ['character', id],
    enabled: !isNew,
    queryFn: async () => {
      const { data, error } = await supabase.from('characters').select('*').eq('id', id!).single();
      if (error) throw error;
      return data as Character;
    },
  });
  const refs = useAssets({ characterId: isNew ? undefined : id, kind: 'image' });
  const jobs = useJobs({ ids: jobIds });
  const versions = useQuery({
    queryKey: ['character-versions', id],
    enabled: !isNew,
    queryFn: async () => {
      const root = char.data?.parent_id ?? id;
      const { data } = await supabase.from('characters').select('id,name,version_label,parent_id').or(`id.eq.${root},parent_id.eq.${root}`).order('created_at');
      return (data ?? []) as Pick<Character, 'id' | 'name' | 'version_label' | 'parent_id'>[];
    },
  });

  useEffect(() => {
    if (char.data) {
      const { id: _i, user_id: _u, created_at: _c, updated_at: _up, archived: _a, primary_image_id: _p, parent_id: _pa, version_label: _v, is_favorite: _f, ...rest } = char.data;
      setForm(rest);
    }
  }, [char.data]);

  useEffect(() => {
    if (jobs.data?.some((j) => j.status === 'succeeded')) {
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['character', id] });
    }
  }, [jobs.data, qc, id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setApp = (k: string, v: string) => setForm((f) => ({ ...f, appearance: { ...f.appearance, [k]: v } }));
  const human = form.kind === 'realistic' || form.kind === 'cinematic';

  async function save() {
    if (!form.name.trim()) return toast.error('Dê um nome ao personagem.');
    setSaving(true);
    try {
      if (isNew) {
        const { data, error } = await supabase.from('characters').insert(form).select('id').single();
        if (error) throw error;
        toast.success('Personagem criado. Agora adicione ou gere imagens de referência.');
        qc.invalidateQueries({ queryKey: ['characters'] });
        navigate(`/personagens/${data.id}`, { replace: true });
      } else {
        const { error } = await supabase.from('characters').update(form).eq('id', id!);
        if (error) throw error;
        toast.success('Alterações salvas.');
        qc.invalidateQueries({ queryKey: ['characters'] });
        qc.invalidateQueries({ queryKey: ['character', id] });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function createVersion() {
    const label = prompt('Nome da versão (ex.: "roupa de inverno"):');
    if (!label) return;
    try {
      const { data, error } = await supabase
        .from('characters')
        .insert({ ...form, parent_id: char.data?.parent_id ?? id, version_label: label.slice(0, 40), primary_image_id: char.data?.primary_image_id })
        .select('id')
        .single();
      if (error) throw error;
      toast.success('Versão criada. O original continua salvo.');
      qc.invalidateQueries({ queryKey: ['characters'] });
      navigate(`/personagens/${data.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function patch(p: Partial<Character>) {
    const { error } = await supabase.from('characters').update(p).eq('id', id!);
    if (error) return toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: ['character', id] });
    qc.invalidateQueries({ queryKey: ['characters'] });
  }

  if (!isNew && char.isLoading) return <Spinner />;
  const c = char.data;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/personagens" className="flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Personagens
      </Link>
      <PageHeader
        title={isNew ? 'Novo personagem' : form.name || 'Personagem'}
        subtitle={c?.version_label ? `Versão: ${c.version_label}` : 'Personagens fictícios e originais são a opção recomendada.'}
        actions={
          !isNew && (
            <>
              <Button variant="ghost" onClick={() => patch({ is_favorite: !c?.is_favorite })}>
                <Star className={`size-4 ${c?.is_favorite ? 'fill-warning text-warning' : ''}`} /> {c?.is_favorite ? 'Favorito' : 'Favoritar'}
              </Button>
              <Button onClick={createVersion}>
                <Copy className="size-4" /> Criar versão alternativa
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm('Arquivar este personagem? As imagens continuam na biblioteca.')) return;
                  await patch({ archived: true });
                  navigate('/personagens');
                }}
              >
                <Trash2 className="size-4" /> Arquivar
              </Button>
            </>
          )
        }
      />

      {!!versions.data && versions.data.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {versions.data.map((v) => (
            <Link key={v.id} to={`/personagens/${v.id}`}>
              <Badge tone={v.id === id ? 'accent' : 'neutral'}>{v.version_label ?? 'Original'}</Badge>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-6">
          <Card className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome">{(i) => <Input id={i} maxLength={80} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
            <Field label="Tipo de personagem">{(i) => <Select id={i} value={form.kind} onChange={(e) => set('kind', e.target.value)} options={KIND_OPTIONS} />}</Field>
            <div className="sm:col-span-2">
              <Field label="Descrição visual geral" hint="Quem é, aparência marcante, o que o torna reconhecível.">
                {(i) => <Textarea id={i} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} />}
              </Field>
            </div>
            {human && (
              <Field label="Idade aparente" hint="Somente personagens adultos.">
                {(i) => <Select id={i} value={form.appearance.age ?? ''} onChange={(e) => setApp('age', e.target.value)} options={AGE_OPTIONS} />}
              </Field>
            )}
            {APPEARANCE_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                {(i) => <Input id={i} placeholder={f.placeholder} value={form.appearance[f.key] ?? ''} onChange={(e) => setApp(f.key, e.target.value)} />}
              </Field>
            ))}
          </Card>

          <Card className="grid gap-4 sm:grid-cols-2">
            <Field label="Personalidade e comportamento">{(i) => <Textarea id={i} value={form.personality} onChange={(e) => set('personality', e.target.value)} />}</Field>
            <Field label="Expressões faciais habituais">{(i) => <Textarea id={i} value={form.expressions} onChange={(e) => set('expressions', e.target.value)} />}</Field>
            <Field label="Maneira de falar">{(i) => <Textarea id={i} value={form.speaking_style} onChange={(e) => set('speaking_style', e.target.value)} />}</Field>
            <Field label="Cenários preferidos">{(i) => <Textarea id={i} value={form.preferred_settings} onChange={(e) => set('preferred_settings', e.target.value)} />}</Field>
            <Field label="Movimentos e poses de referência">{(i) => <Textarea id={i} value={form.reference_poses} onChange={(e) => set('reference_poses', e.target.value)} />}</Field>
            <Field label="Instruções personalizadas" hint="Detalhes que devem aparecer sempre.">
              {(i) => <Textarea id={i} maxLength={2000} value={form.custom_instructions} onChange={(e) => set('custom_instructions', e.target.value)} />}
            </Field>
          </Card>

          <Card className="grid gap-4 sm:grid-cols-3">
            <p className="text-sm font-medium sm:col-span-3">Voz associada</p>
            <Field label="Voz (prévia em Voz)">
              {(i) => (
                <Select id={i} value={form.voice.preset_id ?? ''} onChange={(e) => set('voice', { ...form.voice, preset_id: e.target.value || undefined })} options={[{ value: '', label: 'Nenhuma' }, ...RUNWAY_VOICE_PRESETS.map((v) => ({ value: v, label: v }))]} />
              )}
            </Field>
            <Field label="Idioma / sotaque">
              {(i) => <Select id={i} value={form.voice.language ?? 'pt'} onChange={(e) => set('voice', { ...form.voice, language: e.target.value })} options={TTS_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />}
            </Field>
            <Field label="Velocidade">
              {(i) => <Input id={i} type="number" min={0.7} max={1.2} step={0.05} value={form.voice.speed ?? 1} onChange={(e) => set('voice', { ...form.voice, speed: Number(e.target.value) })} />}
            </Field>
          </Card>

          <div className="flex justify-end">
            <Button variant="primary" size="lg" onClick={save} loading={saving}>
              <Save className="size-4" /> {isNew ? 'Criar personagem' : 'Salvar alterações'}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <p className="mb-1 text-sm font-medium">Descrição persistente</p>
            <p className="text-xs text-muted">Usada em todas as gerações deste personagem:</p>
            <p className="mt-2 rounded-lg bg-surface-2 p-2 text-xs">{characterDescriptor(form)}</p>
          </Card>
          {isNew ? (
            <Notice>Salve o personagem para adicionar imagens de referência.</Notice>
          ) : (
            <>
              <Card className="flex flex-col gap-3">
                <p className="text-sm font-medium">Imagens de referência</p>
                <Notice>
                  As referências ajudam a preservar a identidade visual, mas a fidelidade depende do modelo — a consistência perfeita não é garantida.
                </Notice>
                {refs.data?.length ? (
                  <AssetGrid assets={refs.data} selected={c?.primary_image_id ? [c.primary_image_id] : []} onSelect={(a) => patch({ primary_image_id: a.id }).then(() => toast.success('Imagem principal definida.'))} />
                ) : (
                  <p className="text-sm text-muted">Nenhuma imagem ainda.</p>
                )}
                {!!refs.data?.length && <p className="text-xs text-muted">Toque numa imagem para torná-la a referência principal.</p>}
                <UploadBox kind="image" category="reference" characterId={id} compact />
              </Card>
              <Card className="flex flex-col gap-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Wand2 className="size-4" /> Gerar imagens do personagem
                </p>
                <IntegrationGate provider="runway" feature="Geração de imagens" />
                <div className="flex flex-wrap gap-1.5">
                  {VIEWS.map((v) => (
                    <button key={v.view} onClick={() => setView(v.view)} className={`rounded-lg px-2.5 py-1 text-xs ${view === v.view ? 'bg-accent text-white' : 'bg-surface-2 text-muted'}`}>
                      {v.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted">{VIEW_PROMPTS[view]}</p>
                <Field label="Detalhes extras (opcional)">{(i) => <Input id={i} placeholder="ex.: sorrindo, roupa de inverno" value={extra} onChange={(e) => setExtra(e.target.value)} />}</Field>
                <CostConfirm
                  kind="ai.image"
                  params={{ model: 'gen4_image', character_id: id, view, prompt: extra, aspect: view === 'portrait' ? '1:1' : '9:16' }}
                  disabled={!runway.ok ? runway.reason : false}
                  label="Gerar imagem"
                  onCreated={(j) => setJobIds((ids) => [j.id, ...ids])}
                />
                {jobs.data?.map((j) => <JobCard key={j.id} job={j} showOutputs={false} />)}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
