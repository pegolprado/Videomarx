import { Clapperboard, Coins, Copy, Gift, FolderOpen, Scissors, Star, Trash2, Type, UserPlus, Wand2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { ACTIVE_STATUSES } from '@shared/jobs';
import { formatCredits } from '@shared/format';
import { AssetGrid } from '@/components/Assets';
import { JobCard } from '@/components/JobCard';
import { Badge, Button, Card, Empty, Notice, PageHeader, Spinner } from '@/components/ui';
import { useAuth } from '@/app/auth';
import { useAssets, useCapabilities, useCharacters, useCredits, useJobs, usePrices, useProfile, useProjects } from '@/lib/hooks';
import { deleteProject, duplicateProject, PROJECT_ROUTE } from '@/lib/projects';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { LedgerEntry } from '@/lib/types';

const ACTIONS = [
  { to: '/video-gratis', label: 'Criar vídeo grátis', icon: Gift, primary: true },
  { to: '/gerar', label: 'Criar vídeo', icon: Clapperboard },
  { to: '/transformar', label: 'Transformar vídeo', icon: Wand2, primary: true },
  { to: '/personagens/novo', label: 'Criar personagem', icon: UserPlus },
  { to: '/gerar?modo=texto', label: 'Gerar vídeo por texto', icon: Type },
  { to: '/editor', label: 'Editar vídeo', icon: Scissors },
];

export default function Dashboard() {
  const profile = useProfile();
  const credits = useCredits();
  const jobs = useJobs({ limit: 20 });
  const caps = useCapabilities();
  const characters = useCharacters();
  const projects = useProjects(6);
  const done = useAssets({ kind: 'video', categories: ['generated', 'transformed', 'export'], limit: 8 });
  const prices = usePrices();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { session } = useAuth();
  const ledger = useQuery({
    queryKey: ['ledger', session?.user.id, 8],
    queryFn: async () => {
      const { data, error } = await supabase.from('credit_ledger').select('*').order('created_at', { ascending: false }).limit(8);
      if (error) throw error;
      return data as LedgerEntry[];
    },
  });

  const active = (jobs.data ?? []).filter((j) => ACTIVE_STATUSES.includes(j.status));
  const recentFailures = (jobs.data ?? []).filter((j) => j.status === 'failed' && Date.now() - new Date(j.finished_at ?? j.created_at).getTime() < 86_400_000);
  const pending = caps.data ? Object.entries(caps.data.integrations).filter(([, i]) => !i.enabled || !i.configured || !caps.data!.worker_online) : [];
  const favorites = (characters.data ?? []).filter((c) => c.is_favorite).slice(0, 6);
  const price = (key: string) => prices.data?.find((p) => p.key === key);
  const sample = [
    { label: 'Vídeo de 5 s (Gen-4.5)', p: price('runway.gen4.5'), units: 5 },
    { label: 'Transformação de 10 s (Act-Two)', p: price('runway.act_two'), units: 10 },
    { label: 'Imagem de personagem', p: price('runway.gen4_image'), units: 1 },
    { label: 'Roteiro completo (Claude)', p: price('anthropic.text'), units: 1 },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={`Olá${profile.data?.display_name ? `, ${profile.data.display_name.split(' ')[0]}` : ''}!`} subtitle="O que vamos criar hoje?" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ACTIONS.map((a) => (
          <Link
            key={a.label}
            to={a.to}
            className={`flex flex-col gap-3 rounded-2xl border p-4 transition hover:-translate-y-0.5 ${a.primary ? 'gradient-bg border-transparent text-white shadow-lg shadow-accent/20' : 'border-line bg-surface hover:border-accent/50'}`}
          >
            <a.icon className="size-6" />
            <span className="font-medium">{a.label}</span>
          </Link>
        ))}
      </div>

      {caps.data && !caps.data.worker_online && (
        <Notice tone="danger" title="Servidor de processamento offline">
          Envios e gerações ficam na fila até o servidor voltar. Nenhum crédito é consumido enquanto isso.
        </Notice>
      )}
      {caps.data?.worker_online && pending.length > 0 && (
        <Notice tone="warning" title="Integrações pendentes">
          {pending.map(([, i]) => i.label).join(', ')} ainda não {pending.length > 1 ? 'estão ativas' : 'está ativa'}. As funções que dependem delas aparecem bloqueadas.{' '}
          <Link to="/integracoes" className="underline">
            Detalhes
          </Link>
        </Notice>
      )}
      {recentFailures.length > 0 && (
        <Notice tone="danger" title={`${recentFailures.length} tarefa(s) falharam nas últimas 24 h`}>
          <Link to="/tarefas" className="underline">
            Ver detalhes
          </Link>{' '}
          — os créditos foram devolvidos conforme a política de reembolso.
        </Notice>
      )}
      {credits.data && credits.data.available < 20 && (
        <Notice tone="warning" title="Poucos créditos">
          Seu saldo está baixo. <Link to="/creditos" className="underline">Ver créditos e planos</Link>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Coins className="size-4 text-warning" /> Créditos disponíveis
          </p>
          <p className="font-display text-3xl font-semibold">{credits.data?.available.toLocaleString('pt-BR') ?? '—'}</p>
          {!!credits.data?.reserved && <p className="text-xs text-muted">{formatCredits(credits.data.reserved)} reservados em tarefas em andamento</p>}
          <Link to="/creditos" className="text-sm text-accent">
            Histórico e planos →
          </Link>
        </Card>
        <Card className="lg:col-span-2">
          <p className="mb-2 text-sm font-medium">Estimativa das próximas gerações</p>
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {sample.map((s) => (
              <li key={s.label} className="flex justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <span className="text-muted">{s.label}</span>
                <span className="font-medium">{s.p ? (s.p.active ? `~${Math.max(Math.ceil(s.units * s.p.credits_per_unit), s.p.min_credits)}` : 'indisponível') : '—'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Valores aproximados em créditos; o custo exato aparece antes de cada geração.</p>
        </Card>
      </div>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Tarefas em processamento</h2>
        {jobs.isLoading ? <Spinner /> : active.length ? <div className="grid gap-3 md:grid-cols-2">{active.map((j) => <JobCard key={j.id} job={j} showOutputs={false} />)}</div> : <p className="text-sm text-muted">Nenhuma tarefa em andamento.</p>}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Projetos recentes</h2>
          <Link to="/biblioteca" className="text-sm text-accent">Biblioteca →</Link>
        </div>
        {projects.data?.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.data.map((p) => (
              <Card key={p.id} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-medium">{p.name}</p>
                  <Badge>{p.aspect}</Badge>
                </div>
                <p className="text-xs text-muted">Atualizado em {new Date(p.updated_at).toLocaleString('pt-BR')}</p>
                <div className="mt-1 flex gap-1">
                  <Button size="sm" onClick={() => navigate(`${PROJECT_ROUTE[p.type]}?projeto=${p.id}`)}>
                    <FolderOpen className="size-3.5" /> Abrir
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Duplicar" onClick={async () => {
                    try { await duplicateProject(p); qc.invalidateQueries({ queryKey: ['projects'] }); toast.success('Projeto duplicado.'); } catch (e) { toast.error(errorMessage(e)); }
                  }}>
                    <Copy className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Excluir" onClick={async () => {
                    if (!confirm(`Excluir o projeto "${p.name}"? Os arquivos continuam na biblioteca.`)) return;
                    try { await deleteProject(p.id); qc.invalidateQueries({ queryKey: ['projects'] }); } catch (e) { toast.error(errorMessage(e)); }
                  }}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Empty title="Nenhum projeto ainda">Comece criando um vídeo ou transformando um vídeo seu.</Empty>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
            <Star className="size-4 text-warning" /> Personagens favoritos
          </h2>
          {favorites.length ? (
            <div className="flex flex-wrap gap-2">
              {favorites.map((c) => (
                <Link key={c.id} to={`/personagens/${c.id}`} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm hover:border-accent/50">
                  {c.name}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Marque personagens com estrela para vê-los aqui.</p>
          )}
        </section>
        <section>
          <h2 className="mb-3 font-display text-lg font-semibold">Histórico de consumo</h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface text-sm">
            {(ledger.data ?? []).map((l) => (
              <li key={l.id} className="flex justify-between gap-2 px-4 py-2">
                <span className="truncate text-muted">{l.note ?? l.kind}</span>
                <span className={l.delta < 0 ? 'text-danger' : 'text-success'}>{l.delta > 0 ? '+' : ''}{l.delta}</span>
              </li>
            ))}
            {!ledger.data?.length && <li className="px-4 py-3 text-muted">Sem movimentações.</li>}
          </ul>
        </section>
      </div>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Vídeos concluídos</h2>
        {done.data?.length ? <AssetGrid assets={done.data} onSelect={() => navigate('/biblioteca')} /> : <p className="text-sm text-muted">Seus vídeos gerados, transformados e exportados aparecerão aqui.</p>}
      </section>
    </div>
  );
}
