import { Copy, Download, Pencil, Star, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, formatDuration } from '@shared/format';
import { useUserId } from '@/app/auth';
import { AssetThumb } from '@/components/Assets';
import { MediaPreview } from '@/components/MediaPreview';
import { Badge, Button, Empty, Input, Modal, PageHeader, Spinner, Tabs } from '@/components/ui';
import { deleteAsset, duplicateAsset, signedUrl } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useAssets } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import type { Asset, Script } from '@/lib/types';

type Tab = 'original' | 'generated' | 'transformed' | 'export' | 'image' | 'audio' | 'subtitle' | 'scripts' | 'favorites' | 'temp';

const TABS: { value: Tab; label: string }[] = [
  { value: 'original', label: 'Vídeos originais' },
  { value: 'generated', label: 'Vídeos gerados' },
  { value: 'transformed', label: 'Vídeos transformados' },
  { value: 'export', label: 'Exportações' },
  { value: 'image', label: 'Imagens' },
  { value: 'audio', label: 'Áudios' },
  { value: 'subtitle', label: 'Legendas' },
  { value: 'scripts', label: 'Roteiros' },
  { value: 'favorites', label: 'Favoritos' },
  { value: 'temp', label: 'Temporários' },
];

function filterFor(tab: Tab, search: string) {
  const base = { search: search || undefined };
  switch (tab) {
    case 'original': return { ...base, kind: 'video', categories: ['original'] };
    case 'generated': return { ...base, kind: 'video', categories: ['generated'] };
    case 'transformed': return { ...base, kind: 'video', categories: ['transformed'] };
    case 'export': return { ...base, categories: ['export'] };
    case 'image': return { ...base, kind: 'image', categories: ['generated', 'reference', 'original'] };
    case 'audio': return { ...base, kind: 'audio' };
    case 'subtitle': return { ...base, kind: 'subtitle' };
    case 'favorites': return { ...base, favorites: true };
    case 'temp': return { ...base, categories: ['temp'] };
    default: return base;
  }
}

export default function Library() {
  const [tab, setTab] = useState<Tab>('original');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Asset | null>(null);
  const assets = useAssets(tab === 'scripts' ? { ids: [] } : filterFor(tab, search));
  const userId = useUserId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['assets'] });
  const scripts = useQuery({
    queryKey: ['scripts', 'library', search],
    enabled: tab === 'scripts',
    queryFn: async () => {
      let q = supabase.from('scripts').select('*').order('created_at', { ascending: false }).limit(100);
      if (search) q = q.ilike('title', `%${search}%`);
      const { data, error } = await q;
      if (error) throw error;
      return data as Script[];
    },
  });

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div>
      <PageHeader title="Biblioteca" subtitle="Todos os seus arquivos são privados: só você tem acesso." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={TABS} />
      <Input placeholder="Pesquisar por nome…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-4 max-w-sm" />
      {tab === 'temp' && <p className="mb-3 text-xs text-muted">Arquivos temporários (trechos preparados para os provedores) são apagados automaticamente após o prazo de retenção.</p>}

      {tab === 'scripts' ? (
        scripts.isLoading ? <Spinner /> : scripts.data?.length ? (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {scripts.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="font-medium">{s.title}</span>
                <span className="flex items-center gap-2">
                  <Badge>{s.content.task === 'social_pack' ? 'Pacote social' : 'Cenas'}</Badge>
                  <span className="text-xs text-muted">{new Date(s.created_at).toLocaleString('pt-BR')}</span>
                  <Button size="sm" variant="ghost" onClick={() => {
                    const blob = new Blob([JSON.stringify(s.content.output, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${s.title}.json`;
                    a.click();
                  }}><Download className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm('Excluir roteiro?') && act(async () => { const { error } = await supabase.from('scripts').delete().eq('id', s.id); if (error) throw error; await scripts.refetch(); })}><Trash2 className="size-3.5" /></Button>
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty title="Nenhum roteiro salvo" />
      ) : assets.isLoading ? (
        <Spinner />
      ) : assets.data?.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.data.map((a) => (
            <div key={a.id} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2">
              <button onClick={() => setOpen(a)} className="text-left"><AssetThumb asset={a} /></button>
              <div className="flex items-center justify-between gap-1 px-1">
                <span className="truncate text-sm">{a.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <button aria-label="Favoritar" title="Favoritar" onClick={() => act(async () => { const { error } = await supabase.from('assets').update({ is_favorite: !a.is_favorite }).eq('id', a.id); if (error) throw error; })}>
                    <Star className={`size-4 ${a.is_favorite ? 'fill-warning text-warning' : 'text-muted'}`} />
                  </button>
                  <button aria-label="Excluir" title="Excluir" className="text-muted hover:text-danger" onClick={() => confirm(`Excluir "${a.name}" definitivamente?`) && act(() => deleteAsset(a), 'Arquivo excluído.')}>
                    <Trash2 className="size-4" />
                  </button>
                </span>
              </div>
              <p className="px-1 text-xs text-muted">{new Date(a.created_at).toLocaleDateString('pt-BR')} · {a.kind === 'image' ? `${a.width ?? '?'}×${a.height ?? '?'}` : formatDuration(a.duration_s)} · {formatBytes(a.size_bytes)}</p>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="Nada por aqui ainda" />
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.name ?? ''} wide>
        {open && (
          <div className="flex flex-col gap-4">
            {open.kind === 'subtitle' ? <p className="text-sm text-muted">Arquivo de legenda (.srt).</p> : <MediaPreview asset={open} />}
            {open.probe_status === 'invalid' && <p className="text-sm text-danger">Arquivo inválido: {String(open.metadata.invalid_reason ?? '')}</p>}
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>{open.category}</Badge>
              {open.width && <Badge>{open.width}×{open.height}</Badge>}
              {open.duration_s != null && <Badge>{formatDuration(open.duration_s)}</Badge>}
              <Badge>{formatBytes(open.size_bytes)}</Badge>
              {open.metadata.synthetic && <Badge tone="accent">Conteúdo gerado/alterado por IA</Badge>}
              {open.metadata.model && <Badge>{String(open.metadata.model)}</Badge>}
            </div>
            {open.metadata.prompt && <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">{String(open.metadata.prompt)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => act(async () => { window.location.href = await signedUrl(open.path, `${open.name.replace(/[^\w\-. ]+/g, '_')}.${open.path.split('.').pop()}`); })}>
                <Download className="size-4" /> Baixar
              </Button>
              <Button onClick={() => { const n = prompt('Novo nome:', open.name); if (n) act(async () => { const { error } = await supabase.from('assets').update({ name: n.slice(0, 120) }).eq('id', open.id); if (error) throw error; setOpen({ ...open, name: n }); }, 'Renomeado.'); }}>
                <Pencil className="size-4" /> Renomear
              </Button>
              {['original', 'reference'].includes(open.category) && (
                <Button onClick={() => act(() => duplicateAsset(open, userId), 'Cópia criada.')}><Copy className="size-4" /> Duplicar</Button>
              )}
              {open.kind === 'video' && open.probe_status === 'ok' && (
                <>
                  <Link to={`/editor?asset=${open.id}`}><Button>Abrir no editor</Button></Link>
                  {open.category === 'original' && <Link to={`/transformar?video=${open.id}`}><Button><Wand2 className="size-4" /> Transformar</Button></Link>}
                </>
              )}
              <Button variant="danger" onClick={() => confirm('Excluir este arquivo definitivamente?') && act(async () => { await deleteAsset(open); setOpen(null); }, 'Arquivo excluído.')}>
                <Trash2 className="size-4" /> Excluir
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
