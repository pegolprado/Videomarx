import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { Project } from './types';

export async function createProject(p: Pick<Project, 'name' | 'type'> & Partial<Pick<Project, 'aspect' | 'character_id' | 'data'>>): Promise<Project> {
  const { data, error } = await supabase.from('projects').insert(p).select('*').single();
  if (error) throw error;
  return data as Project;
}

export async function saveProject(id: string, patch: Partial<Pick<Project, 'name' | 'aspect' | 'character_id' | 'data' | 'thumbnail_asset_id' | 'is_favorite'>>) {
  const { error } = await supabase.from('projects').update(patch).eq('id', id);
  if (error) throw error;
}

export async function duplicateProject(p: Project): Promise<Project> {
  return createProject({ name: `${p.name} (cópia)`, type: p.type, aspect: p.aspect, character_id: p.character_id, data: p.data });
}

export async function deleteProject(id: string) {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

export const PROJECT_ROUTE: Record<Project['type'], string> = {
  transform: '/transformar',
  generate: '/gerar',
  edit: '/editor',
  social: '/viral',
  voice: '/voz',
  image: '/imagens',
};

export function useProjectRow(id: string | null) {
  return useQuery({
    queryKey: ['project', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from('projects').select('*').eq('id', id!).single();
      if (error) throw error;
      return data as Project;
    },
  });
}
