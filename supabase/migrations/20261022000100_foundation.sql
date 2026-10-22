-- VideoAI Studio — fundação: perfis, planos, configurações, auditoria.
-- Convenção: tudo em public, RLS ligado em todas as tabelas, funções sensíveis
-- como SECURITY DEFINER com search_path fixo.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Configurações gerais (editáveis pelo administrador)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.app_settings (key, value, description) values
  ('signup_bonus_credits', '50', 'Créditos concedidos no cadastro'),
  ('credit_value_usd', '0.01', 'Valor de referência de 1 crédito da plataforma em USD (para converter o custo real do provedor)'),
  ('provider_markup', '1.0', 'Multiplicador aplicado ao custo real do provedor antes de converter em créditos'),
  ('runway_usd_per_credit', '0.01', 'Preço em USD de 1 crédito da Runway (confira em runwayml.com/pricing)'),
  ('monthly_budget_usd', '100', 'Teto de gasto mensal da plataforma com provedores (USD). 0 = sem teto'),
  ('budget_alert_ratio', '0.8', 'Fração do teto que dispara alerta no painel admin'),
  ('refund_failed_full', 'true', 'Se true, tarefas que falham são 100% reembolsadas ao usuário'),
  ('abort_if_provider_estimate_exceeds', 'true', 'Cancela a tarefa no provedor se a estimativa dele superar a reserva'),
  ('max_upload_mb', '200', 'Tamanho máximo por arquivo enviado (MB). Respeite também o limite do seu plano Supabase'),
  ('temp_retention_days', '7', 'Arquivos temporários são apagados depois deste prazo'),
  ('job_max_attempts', '3', 'Tentativas para falhas temporárias (rede, 429, 5xx)');

-- ---------------------------------------------------------------------------
-- Planos (estruturas iniciais — não são promessas de recursos)
-- ---------------------------------------------------------------------------
create table public.plans (
  id text primary key,
  name text not null,
  description text,
  monthly_credits integer not null default 0 check (monthly_credits >= 0),
  max_projects integer not null check (max_projects > 0),
  max_characters integer not null check (max_characters > 0),
  max_upload_mb integer not null check (max_upload_mb > 0),
  max_video_seconds integer not null check (max_video_seconds > 0),
  max_job_credits integer not null check (max_job_credits > 0),
  daily_credit_limit integer not null check (daily_credit_limit > 0),
  price_brl_cents integer,
  features jsonb not null default '[]'::jsonb,
  sort integer not null default 0,
  active boolean not null default true
);

insert into public.plans (id, name, description, monthly_credits, max_projects, max_characters, max_upload_mb, max_video_seconds, max_job_credits, daily_credit_limit, sort, features) values
  ('free', 'Gratuito', 'Para conhecer a plataforma', 0, 5, 3, 100, 15, 200, 300, 1,
   '["Personagens limitados","Vídeos curtos","Exportação MP4"]'),
  ('creator', 'Creator', 'Para criadores de conteúdo', 0, 50, 20, 200, 30, 2000, 3000, 2,
   '["Mais créditos","Biblioteca ampliada","Mais gerações"]'),
  ('pro', 'Pro', 'Maior volume de processamento', 0, 500, 100, 500, 60, 6000, 10000, 3,
   '["Mais projetos","Ferramentas avançadas","Edição adicional"]'),
  ('business', 'Business', 'Para equipes (gestão de usuários: em desenvolvimento)', 0, 5000, 1000, 500, 120, 20000, 50000, 4,
   '["Limites configuráveis","Recursos comerciais"]');

-- ---------------------------------------------------------------------------
-- Perfis
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  plan_id text not null default 'free' references public.plans (id),
  terms_accepted_at timestamptz,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan_id text not null references public.plans (id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled')),
  provider text,            -- provedor de pagamento (a definir)
  provider_ref text,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Auditoria
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  target text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.app_settings where key = p_key
$$;

create or replace function public.audit(p_action text, p_target text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, action, target, data) values (auth.uid(), p_action, p_target, coalesce(p_data, '{}'::jsonb))
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- O usuário não pode promover a si mesmo nem trocar de plano/suspensão.
-- (Sem SECURITY DEFINER: current_user precisa ser o papel de quem chamou.)
create or replace function public.profiles_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    if new.role is distinct from old.role
       or new.plan_id is distinct from old.plan_id
       or new.suspended is distinct from old.suspended
       or new.email is distinct from old.email then
      raise exception 'Alteração não permitida' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();
