import { Plus, Star, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSignedUrl, useAssets, useCharacters } from '@/lib/hooks';
import { Badge, Button, Empty, Input, PageHeader, Spinner } from '@/components/ui';
import type { Character } from '@/lib/types';
import { KIND_OPTIONS } from './options';

function CharacterCard({ c, image }: { c: Character; image?: string | null }) {
  const url = useSignedUrl(image);
  return (
    <Link to={`/personagens/${c.id}`} className="group flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2 transition hover:border-accent/50">
      <div className="grid aspect-[3/4] place-items-center overflow-hidden rounded-xl bg-surface-2">
        {url ? <img src={url} alt={c.name} className="size-full object-cover" loading="lazy" /> : <UserRound className="size-10 text-muted" />}
      </div>
      <div className="flex items-center justify-between gap-1 px-1">
        <span className="truncate font-medium">{c.name}</span>
        {c.is_favorite && <Star className="size-4 shrink-0 fill-warning text-warning" />}
      </div>
      <div className="flex flex-wrap gap-1 px-1 pb-1">
        <Badge>{KIND_OPTIONS.find((k) => k.value === c.kind)?.label ?? c.kind}</Badge>
        {c.version_label && <Badge tone="accent">{c.version_label}</Badge>}
      </div>
    </Link>
  );
}

export default function CharacterList() {
  const chars = useCharacters();
  const [q, setQ] = useState('');
  const ids = (chars.data ?? []).map((c) => c.primary_image_id).filter(Boolean) as string[];
  const images = useAssets({ ids });
  const thumbOf = (c: Character) => {
    const a = images.data?.find((x) => x.id === c.primary_image_id);
    return a?.thumbnail_path ?? a?.path ?? null;
  };
  const list = (chars.data ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader
        title="Meus personagens"
        subtitle="Personagens fictícios originais, com descrição e referências persistentes para manter a identidade visual."
        actions={
          <Link to="/personagens/novo">
            <Button variant="primary">
              <Plus className="size-4" /> Criar personagem
            </Button>
          </Link>
        }
      />
      <Input placeholder="Buscar personagem…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      {chars.isLoading ? (
        <Spinner />
      ) : list.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {list.map((c) => (
            <CharacterCard key={c.id} c={c} image={thumbOf(c)} />
          ))}
        </div>
      ) : (
        <Empty icon={<UserRound className="size-8" />} title="Nenhum personagem ainda">
          Crie seu primeiro personagem: descreva a aparência, gere imagens de referência e use-o em vídeos.
        </Empty>
      )}
    </div>
  );
}
