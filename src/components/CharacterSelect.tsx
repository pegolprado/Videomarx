import { useCharacters } from '@/lib/hooks';
import { Select } from './ui';

export function CharacterSelect({ value, onChange, allowNone, id }: { value: string; onChange: (id: string) => void; allowNone?: boolean; id?: string }) {
  const chars = useCharacters();
  const options = [
    ...(allowNone ? [{ value: '', label: 'Sem personagem' }] : [{ value: '', label: 'Escolha um personagem…' }]),
    ...(chars.data ?? []).map((c) => ({ value: c.id, label: `${c.name}${c.version_label ? ` (${c.version_label})` : ''}${c.primary_image_id ? '' : ' — sem imagem principal'}` })),
  ];
  return <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} options={options} />;
}
