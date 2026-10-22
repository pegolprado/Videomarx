import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACTIVE_STATUSES } from '@shared/jobs';
import type { Capabilities } from '@shared/capabilities';
import { useAuth } from '@/app/auth';
import { signedUrl } from './api';
import { supabase } from './supabase';
import type { Asset, Character, CreditAccount, Job, Plan, Profile } from './types';

export function useProfile() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['profile', session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', session!.user.id).single();
      if (error) throw error;
      return data as Profile;
    },
  });
}

export function usePlan() {
  const profile = useProfile();
  return useQuery({
    queryKey: ['plan', profile.data?.plan_id],
    enabled: !!profile.data,
    queryFn: async () => {
      const { data, error } = await supabase.from('plans').select('*').eq('id', profile.data!.plan_id).single();
      if (error) throw error;
      return data as Plan;
    },
  });
}

export function useCredits() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['credits', session?.user.id],
    enabled: !!session,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('credit_accounts').select('*').eq('user_id', session!.user.id).single();
      if (error) throw error;
      return data as CreditAccount;
    },
  });
}

/** O que está realmente disponível agora (integrações configuradas + worker online). */
export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_capabilities');
      if (error) throw error;
      return data as Capabilities;
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('app_settings').select('key,value');
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) as Record<string, unknown>;
    },
  });
}

/** Tarefas; atualiza a cada 4 s enquanto houver alguma em andamento. */
export function useJobs(filter?: { ids?: string[]; limit?: number; projectId?: string }) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['jobs', session?.user.id, filter],
    enabled: !!session && (!filter?.ids || filter.ids.length > 0),
    queryFn: async () => {
      let q = supabase.from('jobs').select('*').eq('user_id', session!.user.id).order('created_at', { ascending: false }).limit(filter?.limit ?? 50);
      if (filter?.ids) q = q.in('id', filter.ids);
      if (filter?.projectId) q = q.eq('project_id', filter.projectId);
      const { data, error } = await q;
      if (error) throw error;
      return data as Job[];
    },
    refetchInterval: (query) => ((query.state.data as Job[] | undefined)?.some((j) => ACTIVE_STATUSES.includes(j.status)) ? 4000 : false),
  });
}

export function useAssets(filter: { kind?: string; categories?: string[]; characterId?: string; ids?: string[]; search?: string; favorites?: boolean; limit?: number } = {}) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['assets', session?.user.id, filter],
    enabled: !!session && (!filter.ids || filter.ids.length > 0),
    queryFn: async () => {
      let q = supabase.from('assets').select('*').eq('user_id', session!.user.id).order('created_at', { ascending: false }).limit(filter.limit ?? 200);
      if (filter.kind) q = q.eq('kind', filter.kind);
      if (filter.categories) q = q.in('category', filter.categories);
      if (filter.characterId) q = q.eq('character_id', filter.characterId);
      if (filter.ids) q = q.in('id', filter.ids);
      if (filter.search) q = q.ilike('name', `%${filter.search}%`);
      if (filter.favorites) q = q.eq('is_favorite', true);
      const { data, error } = await q;
      if (error) throw error;
      return data as Asset[];
    },
    refetchInterval: (query) => ((query.state.data as Asset[] | undefined)?.some((a) => a.probe_status === 'pending') ? 4000 : false),
  });
}

export function useCharacters() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['characters', session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.from('characters').select('*').eq('archived', false).order('updated_at', { ascending: false });
      if (error) throw error;
      return data as Character[];
    },
  });
}

export function useSignedUrl(path: string | null | undefined, download?: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) {
      setUrl(null);
      return;
    }
    signedUrl(path, download)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [path, download]);
  return url;
}

export function useProjects(limit = 50) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['projects', session?.user.id, limit],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.from('projects').select('*').order('updated_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return data as import('./types').Project[];
    },
  });
}

export function usePrices() {
  return useQuery({
    queryKey: ['prices'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('price_catalog').select('*').order('provider').order('key');
      if (error) throw error;
      return data as import('./types').PriceRow[];
    },
  });
}
