import { useState } from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KIND_LABEL } from '@shared/jobs';
import { StatusBadge } from '@/components/JobCard';
import { Badge, Button, Card, Input, Notice, PageHeader, Select, Spinner, Tabs } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { usePrices } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import type { CreditAccount, Job, Plan, PriceRow, Profile } from '@/lib/types';

type Tab = 'overview' | 'users' | 'jobs' | 'prices' | 'plans' | 'integrations' | 'settings' | 'audit';

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

export default function Admin() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div>
      <PageHeader title="Administração" subtitle="Ações administrativas são registradas na auditoria." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Visão geral' }, { value: 'users', label: 'Usuários' }, { value: 'jobs', label: 'Tarefas' }, { value: 'prices', label: 'Preços' },
          { value: 'plans', label: 'Planos' }, { value: 'integrations', label: 'Integrações' }, { value: 'settings', label: 'Configurações' }, { value: 'audit', label: 'Auditoria' },
        ]}
      />
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <Users />}
      {tab === 'jobs' && <AllJobs />}
      {tab === 'prices' && <Prices />}
      {tab === 'plans' && <Plans />}
      {tab === 'integrations' && <IntegrationsAdmin />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

interface OverviewData {
  users: number; users_7d: number; projects: number; characters: number; jobs_by_status: Record<string, number>; failure_rate_30d: number;
  credits_charged_30d: number; credits_outstanding: number; spend_month_usd: number; budget_usd: number; budget_alert_ratio: number;
  usage_by_model: { provider: string; model: string; jobs: number; failed: number; credits: number; usd: number }[];
  workers: { id: string; version: string; capabilities: Record<string, boolean>; last_seen: string }[];
  subscriptions: Record<string, number>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <Card><p className="text-xs text-muted">{label}</p><p className="font-display text-2xl font-semibold">{value}</p></Card>;
}

function Overview() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => rpc('admin_overview', {}) as Promise<OverviewData>, refetchInterval: 30_000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Notice tone="danger">{errorMessage(q.error)}</Notice>;
  const d = q.data!;
  const budget = Number(d.budget_usd);
  const ratio = budget > 0 ? Number(d.spend_month_usd) / budget : 0;
  return (
    <div className="flex flex-col gap-4">
      {budget > 0 && ratio >= Number(d.budget_alert_ratio) && <Notice tone={ratio >= 1 ? 'danger' : 'warning'} title="Orçamento mensal">Gasto com provedores em {Math.round(ratio * 100)}% do teto (US$ {Number(d.spend_month_usd).toFixed(2)} de US$ {budget.toFixed(2)}).</Notice>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Usuários" value={`${d.users} (+${d.users_7d} em 7 d)`} />
        <Stat label="Projetos / personagens" value={`${d.projects} / ${d.characters}`} />
        <Stat label="Taxa de falha (30 d)" value={`${(Number(d.failure_rate_30d) * 100).toFixed(1)}%`} />
        <Stat label="Gasto do mês (USD)" value={`US$ ${Number(d.spend_month_usd).toFixed(2)}${budget ? ` / ${budget}` : ''}`} />
        <Stat label="Créditos cobrados (30 d)" value={d.credits_charged_30d} />
        <Stat label="Créditos em circulação" value={d.credits_outstanding} />
        <Stat label="Tarefas (30 d)" value={Object.entries(d.jobs_by_status).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'} />
        <Stat label="Usuários por plano" value={Object.entries(d.subscriptions).map(([k, v]) => `${k}: ${v}`).join(' · ')} />
      </div>
      <Card>
        <p className="mb-2 font-medium">Uso e custo por modelo (mês atual)</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="py-1">Provedor</th><th>Modelo</th><th>Tarefas</th><th>Falhas</th><th>Créditos</th><th>Custo real (USD)</th></tr></thead>
            <tbody className="divide-y divide-line">{d.usage_by_model.map((u) => <tr key={u.provider + u.model}><td className="py-1.5">{u.provider}</td><td>{u.model}</td><td>{u.jobs}</td><td>{u.failed}</td><td>{u.credits}</td><td>{Number(u.usd).toFixed(4)}</td></tr>)}</tbody>
          </table>
        </div>
      </Card>
      <Card>
        <p className="mb-2 font-medium">Workers</p>
        {d.workers.length ? d.workers.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
            <Badge tone={Date.now() - new Date(w.last_seen).getTime() < 120_000 ? 'success' : 'danger'}>{Date.now() - new Date(w.last_seen).getTime() < 120_000 ? 'online' : 'offline'}</Badge>
            <span>{w.id}</span><span className="text-xs text-muted">v{w.version} · {Object.entries(w.capabilities).map(([k, v]) => `${k}:${v ? 'sim' : 'não'}`).join(' ')} · {new Date(w.last_seen).toLocaleString('pt-BR')}</span>
          </div>
        )) : <p className="text-sm text-muted">Nenhum worker registrado.</p>}
      </Card>
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const users = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: async () => {
      let q = supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(100);
      if (search) q = q.ilike('email', `%${search}%`);
      const { data, error } = await q;
      if (error) throw error;
      const ids = (data ?? []).map((p) => p.id);
      const { data: acc } = await supabase.from('credit_accounts').select('*').in('user_id', ids);
      return (data as Profile[]).map((p) => ({ ...p, credits: (acc as CreditAccount[] | null)?.find((a) => a.user_id === p.id) }));
    },
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => ((await supabase.from('plans').select('*').order('sort')).data ?? []) as Plan[] });
  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); qc.invalidateQueries({ queryKey: ['admin'] }); } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <div className="flex flex-col gap-3">
      <Input placeholder="Buscar por e-mail…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      {users.isLoading ? <Spinner /> : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Usuário</th><th>Plano</th><th>Papel</th><th>Créditos</th><th>Ações</th></tr></thead>
            <tbody className="divide-y divide-line">
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2"><p>{u.email}</p><p className="text-xs text-muted">{u.display_name} · desde {new Date(u.created_at).toLocaleDateString('pt-BR')} {u.suspended && <Badge tone="danger">suspenso</Badge>}</p></td>
                  <td><Select value={u.plan_id} onChange={(e) => act(() => rpc('admin_update_user', { p_user: u.id, p_role: null, p_plan: e.target.value, p_suspended: null }), 'Plano alterado.')} options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))} /></td>
                  <td><Select value={u.role} onChange={(e) => act(() => rpc('admin_update_user', { p_user: u.id, p_role: e.target.value, p_plan: null, p_suspended: null }), 'Papel alterado.')} options={[{ value: 'user', label: 'Usuário' }, { value: 'admin', label: 'Admin' }]} /></td>
                  <td className="px-2">{u.credits?.available ?? 0}{u.credits?.reserved ? ` (+${u.credits.reserved} res.)` : ''}</td>
                  <td className="flex flex-wrap gap-1 px-2 py-2">
                    <Button size="sm" onClick={() => { const v = Number(prompt('Créditos a adicionar (negativo para remover):')); if (!v) return; const note = prompt('Motivo:') ?? ''; act(() => rpc('admin_adjust_credits', { p_user: u.id, p_delta: v, p_note: note }), 'Créditos ajustados.'); }}>Créditos</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(() => rpc('admin_update_user', { p_user: u.id, p_role: null, p_plan: null, p_suspended: !u.suspended }), u.suspended ? 'Reativado.' : 'Suspenso.')}>{u.suspended ? 'Reativar' : 'Suspender'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AllJobs() {
  const [status, setStatus] = useState('');
  const jobs = useQuery({
    queryKey: ['admin', 'jobs', status],
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(100);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data as Job[];
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <Select className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Todos os estados' }, ...['waiting', 'queued', 'processing', 'succeeded', 'failed', 'canceled'].map((s) => ({ value: s, label: s }))]} />
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Quando</th><th>Tipo</th><th>Estado</th><th>Créditos</th><th>USD</th><th>Tarefa externa / erro</th></tr></thead>
          <tbody className="divide-y divide-line">
            {(jobs.data ?? []).map((j) => (
              <tr key={j.id}>
                <td className="px-3 py-2 text-xs">{new Date(j.created_at).toLocaleString('pt-BR')}</td>
                <td>{KIND_LABEL[j.kind]}<p className="text-xs text-muted">{j.model ?? j.provider} · tent. {j.attempts}/{j.max_attempts}</p></td>
                <td><StatusBadge status={j.status} /></td>
                <td>{j.charged_credits ?? `${j.estimated_credits} (res.)`}</td>
                <td>{j.actual_usd != null ? Number(j.actual_usd).toFixed(4) : '—'}</td>
                <td className="max-w-xs px-2 text-xs text-muted"><p className="truncate">{j.provider_task_ids.join(', ')}</p>{j.error_code && <p className="text-danger">{j.error_code}: {j.error_message}</p>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Prices() {
  const prices = usePrices();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Record<string, Partial<PriceRow>>>({});
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="warning">Os valores iniciais são padrões. Confira a tabela atual de cada provedor (ex.: runwayml.com/pricing, anthropic.com/pricing) e ajuste. Se o provedor estimar um custo acima da reserva, a tarefa é cancelada sem cobrança.</Notice>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Operação</th><th>Créditos/unidade</th><th>Mínimo</th><th>Máx. s</th><th>Ativo</th><th /></tr></thead>
          <tbody className="divide-y divide-line">
            {(prices.data ?? []).map((p) => {
              const e = { ...p, ...edit[p.key] };
              const set = (patch: Partial<PriceRow>) => setEdit((x) => ({ ...x, [p.key]: { ...x[p.key], ...patch } }));
              return (
                <tr key={p.key}>
                  <td className="px-3 py-2">{p.label}<p className="text-xs text-muted">{p.key} · {p.unit} · {p.notes}</p></td>
                  <td><Input className="w-24" type="number" step="0.1" value={e.credits_per_unit} onChange={(ev) => set({ credits_per_unit: Number(ev.target.value) })} /></td>
                  <td><Input className="w-20" type="number" value={e.min_credits} onChange={(ev) => set({ min_credits: Number(ev.target.value) })} /></td>
                  <td><Input className="w-20" type="number" value={e.max_seconds ?? ''} onChange={(ev) => set({ max_seconds: ev.target.value ? Number(ev.target.value) : null })} /></td>
                  <td><input type="checkbox" checked={e.active} onChange={(ev) => set({ active: ev.target.checked })} /></td>
                  <td className="px-2"><Button size="sm" disabled={!edit[p.key]} onClick={async () => {
                    try { await rpc('admin_set_price', { p_key: p.key, p_credits_per_unit: e.credits_per_unit, p_min_credits: e.min_credits, p_max_seconds: e.max_seconds, p_active: e.active }); toast.success('Preço salvo.'); setEdit((x) => { const n = { ...x }; delete n[p.key]; return n; }); qc.invalidateQueries({ queryKey: ['prices'] }); } catch (err) { toast.error(errorMessage(err)); }
                  }}>Salvar</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Plans() {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => ((await supabase.from('plans').select('*').order('sort')).data ?? []) as Plan[] });
  const fields: [keyof Plan, string][] = [['max_projects', 'Projetos'], ['max_characters', 'Personagens'], ['max_upload_mb', 'Upload (MB)'], ['max_video_seconds', 'Vídeo (s)'], ['max_job_credits', 'Créditos/tarefa'], ['daily_credit_limit', 'Créditos/dia'], ['monthly_credits', 'Créditos/mês'], ['price_brl_cents', 'Preço (centavos)']];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {(plans.data ?? []).map((p) => (
        <Card key={p.id} className="flex flex-col gap-2">
          <p className="font-medium">{p.name} <span className="text-xs text-muted">({p.id})</span></p>
          <div className="grid grid-cols-2 gap-2">
            {fields.map(([k, label]) => (
              <label key={k} className="text-xs text-muted">{label}
                <Input type="number" defaultValue={(p[k] as number | null) ?? ''} onBlur={async (e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v === p[k]) return;
                  try { await rpc('admin_update_plan', { p_id: p.id, p_patch: { [k]: v } }); toast.success('Plano atualizado.'); qc.invalidateQueries({ queryKey: ['plans'] }); } catch (err) { toast.error(errorMessage(err)); }
                }} />
              </label>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Chaves de cada integração (guardadas no cofre do banco; só o servidor lê o valor). */
const SECRET_FIELDS: Record<string, { name: string; label: string; help: string }[]> = {
  gemini: [{ name: 'GEMINI_API_KEY', label: 'API key do Gemini', help: 'aistudio.google.com → Get API key → Create API key' }],
  cloudflare: [
    { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID da Cloudflare', help: 'Painel da Cloudflare → AI → Workers AI → Use REST API' },
    { name: 'CLOUDFLARE_API_TOKEN', label: 'API token (Workers AI)', help: 'Mesma tela → Create a Workers AI API Token' },
  ],
  runway: [{ name: 'RUNWAYML_API_SECRET', label: 'API secret da Runway (pago)', help: 'dev.runwayml.com' }],
  anthropic: [{ name: 'ANTHROPIC_API_KEY', label: 'API key da Anthropic (pago)', help: 'console.anthropic.com' }],
  fal: [{ name: 'FAL_KEY', label: 'API key da fal.ai (pago por uso)', help: 'fal.ai → Dashboard → API Keys → Add key (e adicione saldo em Billing)' }],
  hf: [{ name: 'HF_TOKEN', label: 'Token do Hugging Face (OPCIONAL, grátis)', help: 'Funciona sem token (cota anônima do servidor). Com token, usa a cota diária da sua conta: huggingface.co → Settings → Access Tokens → Create new token → tipo "Read".' }],
  pollinations: [{ name: 'POLLINATIONS_KEY', label: 'Chave secreta da Pollinations (sk_…, pago por uso)', help: 'enter.pollinations.ai → entrar → Keys → criar chave secreta (sk_). Vídeo usa só saldo comprado (pacotes a partir de US$ 2).' }],
};

function IntegrationsAdmin() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['admin', 'integrations'], queryFn: async () => ((await supabase.from('integrations').select('*').order('id')).data ?? []) as { id: string; label: string; description: string; enabled: boolean }[] });
  const secrets = useQuery({ queryKey: ['admin', 'secrets'], queryFn: () => rpc('admin_list_secrets', {}) as Promise<{ name: string; hint: string; updated_at: string }[]> });
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: () => rpc('platform_capabilities', {}) as Promise<{ worker_online: boolean; integrations: Record<string, { configured: boolean }> }> });

  async function saveSecret(name: string, value: string) {
    try {
      await rpc('admin_set_secret', { p_name: name, p_value: value });
      toast.success(value ? 'Chave salva. O servidor passa a usá-la em até 1 minuto.' : 'Chave removida.');
      setValues((v) => ({ ...v, [name]: '' }));
      qc.invalidateQueries({ queryKey: ['admin', 'secrets'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['capabilities'] }), 65_000);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Notice>
        Para ligar uma integração: cole a chave no quadro dela, clique em <strong>Salvar</strong> e deixe a integração <strong>habilitada</strong>. As chaves ficam guardadas no banco e só o servidor de processamento consegue lê-las; aqui aparece apenas o final de cada uma.
      </Notice>
      {list.data && !list.data.some((i) => i.id === 'hf') && (
        <Notice tone="warning">Faltam as integrações grátis novas (GPU do Hugging Face, modelos animados) e a Pollinations: aplique no Supabase a migração 20261106001000_free_gpu.sql.</Notice>
      )}
      {secrets.error && <Notice tone="warning">Não foi possível ler as chaves: {errorMessage(secrets.error)}. Aplique no Supabase a migração 20261103000700_free_providers.sql.</Notice>}
      {(list.data ?? []).map((i) => {
        const fields = SECRET_FIELDS[i.id] ?? [];
        const active = !!caps.data?.worker_online && !!caps.data.integrations[i.id]?.configured && i.enabled;
        return (
          <Card key={i.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {i.label}
                  {!i.enabled ? <Badge tone="danger">Desabilitada</Badge> : active ? <Badge tone="success">Ativa</Badge> : <Badge tone="warning">Pendente</Badge>}
                </p>
                <p className="text-xs text-muted">{i.description}</p>
              </div>
              <Button variant={i.enabled ? 'secondary' : 'primary'} onClick={async () => {
                try { await rpc('admin_set_integration', { p_id: i.id, p_enabled: !i.enabled }); qc.invalidateQueries({ queryKey: ['admin', 'integrations'] }); qc.invalidateQueries({ queryKey: ['capabilities'] }); } catch (e) { toast.error(errorMessage(e)); }
              }}>{i.enabled ? 'Desabilitar' : 'Habilitar'}</Button>
            </div>
            {fields.map((f) => {
              const saved = secrets.data?.find((x) => x.name === f.name);
              return (
                <div key={f.name} className="flex flex-col gap-1.5 rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{f.label}</p>
                    {saved ? <Badge tone="success">Salva {saved.hint}</Badge> : <Badge>Não configurada</Badge>}
                  </div>
                  <p className="text-xs text-muted">{f.help}</p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input type="password" autoComplete="off" placeholder={saved ? 'Colar uma nova para substituir' : 'Cole aqui'} value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                    <Button variant="primary" disabled={!(values[f.name] ?? '').trim()} onClick={() => saveSecret(f.name, (values[f.name] ?? '').trim())}>Salvar</Button>
                    {saved && <Button variant="ghost" onClick={() => confirm('Remover esta chave?') && saveSecret(f.name, '')}>Remover</Button>}
                  </div>
                </div>
              );
            })}
            {!fields.length && <p className="text-xs text-muted">Não precisa de chave: roda no nosso servidor.</p>}
          </Card>
        );
      })}
    </div>
  );
}

function Settings() {
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ['admin', 'settings'], queryFn: async () => ((await supabase.from('app_settings').select('*').order('key')).data ?? []) as { key: string; value: unknown; description: string }[] });
  return (
    <div className="flex flex-col gap-2">
      {(rows.data ?? []).map((r) => (
        <Card key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="font-mono text-sm">{r.key}</p><p className="text-xs text-muted">{r.description}</p></div>
          <Input className={r.value && typeof r.value === 'object' ? 'sm:w-[28rem]' : 'sm:w-40'} defaultValue={JSON.stringify(r.value)} onBlur={async (e) => {
            let v: unknown;
            try { v = JSON.parse(e.target.value); } catch { return toast.error('Valor inválido (use número, true/false ou texto entre aspas).'); }
            if (JSON.stringify(v) === JSON.stringify(r.value)) return;
            try { await rpc('admin_set_setting', { p_key: r.key, p_value: v }); toast.success('Configuração salva.'); qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); } catch (err) { toast.error(errorMessage(err)); }
          }} />
        </Card>
      ))}
    </div>
  );
}

function Audit() {
  const log = useQuery({ queryKey: ['admin', 'audit'], queryFn: async () => ((await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)).data ?? []) as { id: number; actor: string | null; action: string; target: string | null; data: unknown; created_at: string }[] });
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface text-sm">
      {(log.data ?? []).map((l) => (
        <li key={l.id} className="px-4 py-2">
          <p><Badge>{l.action}</Badge> <span className="text-muted">{l.target}</span></p>
          <p className="truncate text-xs text-muted">{new Date(l.created_at).toLocaleString('pt-BR')} · {l.actor ?? 'sistema'} · {JSON.stringify(l.data)}</p>
        </li>
      ))}
      {!log.data?.length && <li className="px-4 py-3 text-muted">Sem registros.</li>}
    </ul>
  );
}
