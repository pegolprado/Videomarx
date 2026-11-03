-- VideoAI Studio — instalação completa do banco em um único arquivo.
-- Cole tudo no SQL Editor do Supabase e clique em Run. Gerado a partir de supabase/migrations.

-- ===== 20261022000100_foundation.sql =====
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

-- ===== 20261022000200_library.sql =====
-- Biblioteca: personagens, arquivos (assets), projetos e roteiros.

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- versões alternativas apontam para o personagem original (que nunca é alterado por elas)
  parent_id uuid references public.characters (id) on delete set null,
  version_label text,
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null default 'realistic' check (kind in
    ('realistic', 'cinematic', '3d', 'cartoon', 'anime', 'creature', 'mascot', 'avatar')),
  description text not null default '' check (length(description) <= 2000),
  -- cabelo, olhos, rosto, pele, corpo, roupas, calçados, acessórios, idade aparente, estilo
  appearance jsonb not null default '{}'::jsonb,
  personality text not null default '',
  expressions text not null default '',
  speaking_style text not null default '',
  preferred_settings text not null default '',
  reference_poses text not null default '',
  custom_instructions text not null default '' check (length(custom_instructions) <= 2000),
  -- { provider, preset_id, language, speed, stability }
  voice jsonb not null default '{}'::jsonb,
  primary_image_id uuid,
  is_favorite boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index characters_user_idx on public.characters (user_id, updated_at desc);
create trigger characters_touch before update on public.characters
  for each row execute function public.touch_updated_at();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  type text not null check (type in ('transform', 'generate', 'edit', 'social', 'voice', 'image')),
  aspect text not null default '9:16' check (aspect in ('9:16', '16:9', '1:1')),
  character_id uuid references public.characters (id) on delete set null,
  -- cenas, linha do tempo, configurações do assistente
  data jsonb not null default '{}'::jsonb,
  thumbnail_asset_id uuid,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_idx on public.projects (user_id, updated_at desc);
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'audio', 'subtitle', 'other')),
  category text not null check (category in
    ('original', 'generated', 'transformed', 'reference', 'export', 'temp')),
  name text not null default 'arquivo',
  bucket text not null default 'media',
  path text not null,
  mime text,
  size_bytes bigint,
  duration_s numeric(10, 3),
  width integer,
  height integer,
  fps numeric(8, 3),
  has_audio boolean,
  thumbnail_path text,
  character_id uuid references public.characters (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  job_id uuid,
  -- modelo, prompt, aviso de conteúdo sintético, validação de mídia…
  metadata jsonb not null default '{}'::jsonb,
  probe_status text not null default 'pending' check (probe_status in ('pending', 'ok', 'invalid')),
  rights_confirmed_at timestamptz,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  -- a pasta raiz do arquivo é sempre o id do dono
  constraint assets_path_owner check (split_part(path, '/', 1) = user_id::text),
  unique (bucket, path)
);
create index assets_user_idx on public.assets (user_id, created_at desc);
create index assets_character_idx on public.assets (character_id);

alter table public.characters
  add constraint characters_primary_image_fk foreign key (primary_image_id)
  references public.assets (id) on delete set null;
alter table public.projects
  add constraint projects_thumbnail_fk foreign key (thumbnail_asset_id)
  references public.assets (id) on delete set null;

create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  character_id uuid references public.characters (id) on delete set null,
  title text not null default 'Roteiro',
  platform text,
  -- saída estruturada do modelo de linguagem (ganchos, cenas, legendas…)
  content jsonb not null default '{}'::jsonb,
  job_id uuid,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now()
);
create index scripts_user_idx on public.scripts (user_id, created_at desc);

-- Limites do plano para criação de personagens/projetos
create or replace function public.enforce_plan_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_plan public.plans;
  v_count integer;
begin
  select p.* into v_plan from public.plans p join public.profiles pr on pr.plan_id = p.id where pr.id = new.user_id;
  if tg_table_name = 'characters' then
    select count(*) into v_count from public.characters where user_id = new.user_id and not archived;
    if v_count >= v_plan.max_characters then
      raise exception 'Limite de % personagens do plano % atingido', v_plan.max_characters, v_plan.name using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'projects' then
    select count(*) into v_count from public.projects where user_id = new.user_id;
    if v_count >= v_plan.max_projects then
      raise exception 'Limite de % projetos do plano % atingido', v_plan.max_projects, v_plan.name using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger characters_plan_limit before insert on public.characters
  for each row execute function public.enforce_plan_limits();
create trigger projects_plan_limit before insert on public.projects
  for each row execute function public.enforce_plan_limits();

-- Referências cruzadas sempre do mesmo dono (impede apontar para dados de outra conta)
create or replace function public.enforce_same_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'assets' then
    if new.character_id is not null and not exists (select 1 from public.characters where id = new.character_id and user_id = new.user_id) then
      raise exception 'Personagem inválido' using errcode = '42501';
    end if;
    if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and user_id = new.user_id) then
      raise exception 'Projeto inválido' using errcode = '42501';
    end if;
  elsif tg_table_name = 'characters' then
    if new.primary_image_id is not null and not exists (select 1 from public.assets where id = new.primary_image_id and user_id = new.user_id) then
      raise exception 'Imagem inválida' using errcode = '42501';
    end if;
    if new.parent_id is not null and not exists (select 1 from public.characters where id = new.parent_id and user_id = new.user_id) then
      raise exception 'Personagem de origem inválido' using errcode = '42501';
    end if;
  elsif tg_table_name = 'projects' then
    if new.character_id is not null and not exists (select 1 from public.characters where id = new.character_id and user_id = new.user_id) then
      raise exception 'Personagem inválido' using errcode = '42501';
    end if;
  elsif tg_table_name = 'scripts' then
    if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and user_id = new.user_id) then
      raise exception 'Projeto inválido' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger assets_same_owner before insert or update on public.assets
  for each row execute function public.enforce_same_owner();
create trigger characters_same_owner before insert or update on public.characters
  for each row execute function public.enforce_same_owner();
create trigger projects_same_owner before insert or update on public.projects
  for each row execute function public.enforce_same_owner();
create trigger scripts_same_owner before insert or update on public.scripts
  for each row execute function public.enforce_same_owner();

-- O usuário não grava nem altera metadados técnicos: eles vêm do processamento.
create or replace function public.assets_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.category not in ('original', 'reference', 'temp') then
      raise exception 'Categoria de envio inválida' using errcode = '42501';
    end if;
    new.probe_status := 'pending';
    new.duration_s := null; new.width := null; new.height := null; new.fps := null; new.has_audio := null;
    new.job_id := null; new.thumbnail_path := null; new.metadata := '{}'::jsonb;
    new.bucket := 'media';
    return new;
  end if;
  if new.path is distinct from old.path or new.bucket is distinct from old.bucket
     or new.user_id is distinct from old.user_id or new.probe_status is distinct from old.probe_status
     or new.duration_s is distinct from old.duration_s or new.size_bytes is distinct from old.size_bytes
     or new.kind is distinct from old.kind or new.category is distinct from old.category
     or new.job_id is distinct from old.job_id or new.metadata is distinct from old.metadata
     or new.rights_confirmed_at is distinct from old.rights_confirmed_at then
    raise exception 'Somente nome, favorito, personagem e projeto podem ser alterados' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger assets_guard before insert or update on public.assets
  for each row execute function public.assets_guard();

-- ===== 20261022000300_jobs_credits.sql =====
-- Tarefas assíncronas, catálogo de preços e créditos (reserva → liquidação).
--
-- Regras de dinheiro:
--  * nenhuma tarefa paga é criada sem o usuário ter visto a estimativa
--    (create_job recebe o valor confirmado e recusa se a estimativa subiu);
--  * os créditos são RESERVADOS na criação e LIQUIDADOS uma única vez no fim
--    (ledger com unique(job_id, kind) → não existe cobrança dupla);
--  * o usuário nunca paga mais do que a estimativa confirmada;
--  * saldo disponível e reservado nunca ficam negativos (check constraints).

-- ---------------------------------------------------------------------------
-- Integrações (habilitadas/desabilitadas pelo admin) e estado dos workers
-- ---------------------------------------------------------------------------
create table public.integrations (
  id text primary key,
  label text not null,
  description text not null default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.integrations (id, label, description) values
  ('ffmpeg', 'FFmpeg (processamento local)', 'Validação, cortes, conversão, montagem, legendas e exportação'),
  ('runway', 'Runway API', 'Imagens, vídeo por texto/imagem, transformação (Act-Two, Aleph) e voz'),
  ('anthropic', 'Claude (Anthropic)', 'Roteiros, ganchos, legendas, divisão em cenas e instruções para os modelos');

create table public.worker_status (
  worker_id text primary key,
  version text,
  capabilities jsonb not null default '{}'::jsonb,  -- {"ffmpeg":true,"runway":false,...}
  last_seen timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Catálogo de preços (créditos da plataforma). Valores iniciais são PADRÕES
-- que o administrador deve conferir com a tabela atual de cada provedor.
-- ---------------------------------------------------------------------------
create table public.price_catalog (
  key text primary key,
  label text not null,
  provider text not null references public.integrations (id),
  unit text not null check (unit in ('request', 'second', 'image', 'chars50')),
  credits_per_unit numeric(10, 3) not null check (credits_per_unit >= 0),
  min_credits integer not null default 0 check (min_credits >= 0),
  min_seconds numeric(6, 2),
  max_seconds numeric(6, 2),
  active boolean not null default true,
  notes text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, min_seconds, max_seconds, notes) values
  ('media.probe', 'Análise de arquivo', 'ffmpeg', 'request', 0, 0, null, null, 'Gratuito'),
  ('media.trim', 'Corte de trecho', 'ffmpeg', 'request', 1, 1, null, null, ''),
  ('media.export', 'Exportação/conversão', 'ffmpeg', 'second', 0.1, 1, null, 600, ''),
  ('media.concat', 'Montagem de sequência', 'ffmpeg', 'second', 0.1, 1, null, 600, ''),
  ('media.autocut', 'Corte automático de pausas', 'ffmpeg', 'second', 0.1, 1, null, 600, ''),
  ('runway.gen4_image', 'Runway Gen-4 Image', 'runway', 'image', 8, 8, null, null, 'Padrão: 5 (720p) a 8 (1080p) créditos Runway/imagem. Conferir.'),
  ('runway.gen4_image_turbo', 'Runway Gen-4 Image Turbo', 'runway', 'image', 2, 2, null, null, 'Exige ao menos 1 imagem de referência. Conferir preço.'),
  ('runway.gen4.5', 'Runway Gen-4.5 (vídeo)', 'runway', 'second', 12, 24, 2, 10, 'Duração inteira de 2 a 10 s. Conferir preço.'),
  ('runway.gen4_turbo', 'Runway Gen-4 Turbo (imagem→vídeo)', 'runway', 'second', 5, 10, 2, 10, 'Somente imagem→vídeo. Conferir preço.'),
  ('runway.veo3.1', 'Veo 3.1 via Runway', 'runway', 'second', 40, 160, 4, 8, 'Durações 4, 6 ou 8 s. Conferir preço.'),
  ('runway.veo3.1_fast', 'Veo 3.1 Fast via Runway', 'runway', 'second', 15, 60, 4, 8, 'Durações 4, 6 ou 8 s. Conferir preço.'),
  ('runway.act_two', 'Runway Act-Two (transferência de atuação)', 'runway', 'second', 5, 15, 3, 30, 'Vídeo de referência de 3 a 30 s.'),
  ('runway.aleph2', 'Runway Aleph 2 (vídeo→vídeo)', 'runway', 'second', 15, 15, 1, 10, 'Limite de duração definido aqui por segurança; conferir o limite real.'),
  ('runway.eleven_v3', 'Voz (Eleven v3 via Runway)', 'runway', 'chars50', 1, 1, null, null, 'Cobrado a cada 50 caracteres. Conferir preço.'),
  ('anthropic.text', 'Roteiros e textos (Claude)', 'anthropic', 'request', 10, 1, null, null, 'Liquidado pelo consumo real de tokens.');

-- ---------------------------------------------------------------------------
-- Contas de crédito e extrato
-- ---------------------------------------------------------------------------
create table public.credit_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  available integer not null default 0 check (available >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now()
);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta integer not null,
  kind text not null check (kind in ('grant', 'reserve', 'refund', 'adjust', 'purchase')),
  job_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);
-- uma reserva e um reembolso por tarefa, no máximo
create unique index credit_ledger_job_once on public.credit_ledger (job_id, kind) where job_id is not null;

-- ---------------------------------------------------------------------------
-- Tarefas
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  kind text not null check (kind in (
    'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut',
    'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text')),
  status text not null default 'queued' check (status in
    ('waiting', 'queued', 'processing', 'succeeded', 'failed', 'canceled')),
  provider text not null,
  model text,
  params jsonb not null default '{}'::jsonb,
  input_asset_ids uuid[] not null default '{}',
  output_asset_ids uuid[] not null default '{}',
  result jsonb,
  estimate jsonb not null default '{}'::jsonb,
  estimated_credits integer not null default 0 check (estimated_credits >= 0),
  charged_credits integer check (charged_credits >= 0),
  actual_usd numeric(12, 4),
  provider_cost jsonb not null default '{}'::jsonb,
  provider_task_ids text[] not null default '{}',
  state jsonb not null default '{}'::jsonb,            -- estágio do pipeline (retomada sem recobrança)
  progress numeric(5, 4) not null default 0,
  error_code text,
  error_message text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  next_attempt_at timestamptz not null default now(),
  cancel_requested boolean not null default false,
  locked_by text,
  locked_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (user_id, idempotency_key)
);
create index jobs_user_idx on public.jobs (user_id, created_at desc);
create index jobs_queue_idx on public.jobs (status, next_attempt_at) where status in ('queued', 'waiting', 'processing');

create table public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs (id) on delete cascade,
  type text not null,
  message text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index job_events_job_idx on public.job_events (job_id, id);

alter table public.assets add constraint assets_job_fk foreign key (job_id) references public.jobs (id) on delete set null;
alter table public.scripts add constraint scripts_job_fk foreign key (job_id) references public.jobs (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Cadastro: perfil + conta de créditos + bônus
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_bonus integer := coalesce((public.setting('signup_bonus_credits'))::text::integer, 0);
  v_terms boolean := coalesce((new.raw_user_meta_data ->> 'terms_accepted')::boolean, false);
begin
  insert into public.profiles (id, email, display_name, terms_accepted_at)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
          case when v_terms then now() end);
  insert into public.credit_accounts (user_id, available) values (new.id, v_bonus);
  if v_bonus > 0 then
    insert into public.credit_ledger (user_id, delta, kind, note) values (new.id, v_bonus, 'grant', 'Bônus de cadastro');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Estimativa de custo (fonte única da verdade: o banco)
-- ---------------------------------------------------------------------------
create or replace function public.job_duration(p_params jsonb, p_asset_ids uuid[]) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_dur numeric;
  v_start numeric := coalesce((p_params ->> 'trim_start')::numeric, 0);
  v_end numeric := (p_params ->> 'trim_end')::numeric;
begin
  -- unnest: um mesmo clipe pode aparecer mais de uma vez numa montagem
  select coalesce(sum(a.duration_s), 0) into v_dur
    from unnest(p_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind in ('video', 'audio');
  if cardinality(p_asset_ids) = 1 then
    v_dur := least(coalesce(v_end, v_dur), v_dur) - greatest(v_start, 0);
  end if;
  return greatest(v_dur, 0);
end $$;

create or replace function public.estimate_job(p_kind text, p_params jsonb, p_input_asset_ids uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_lines text[][] := '{}';     -- pares (chave, unidades)
  v_total integer := 0;
  v_seconds numeric;
  v_model text := p_params ->> 'model';
  v_mode text := p_params ->> 'mode';
  v_price public.price_catalog;
  v_units numeric;
  v_credits integer;
  v_i integer;
  v_provider text;
begin
  if p_kind like 'media.%' then
    v_provider := 'ffmpeg';
    if p_kind in ('media.export', 'media.concat', 'media.autocut') then
      v_lines := array[array[p_kind, public.job_duration(p_params, p_input_asset_ids)::text]];
    else
      v_lines := array[array[p_kind, '1']];
    end if;
  elsif p_kind = 'ai.text' then
    v_provider := 'anthropic';
    v_lines := array[array['anthropic.text', '1']];
  elsif p_kind = 'ai.image' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4_image'), coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.video' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4.5'), coalesce(p_params ->> 'duration', '5')]];
  elsif p_kind = 'ai.tts' then
    v_provider := 'runway';
    v_lines := array[array['runway.eleven_v3', ceil(length(coalesce(p_params ->> 'text', '')) / 50.0)::text]];
  elsif p_kind = 'ai.transform' then
    v_provider := 'runway';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode = 'full_body' then
      v_lines := array[array['runway.act_two', v_seconds::text]];
    elsif v_mode = 'cinematic' then
      v_lines := array[array['runway.gen4_image', '1'], array['runway.act_two', v_seconds::text]];
    elsif v_mode in ('appearance', 'stylized') then
      if coalesce((p_params ->> 'use_character_keyframe')::boolean, true) then
        v_lines := array[array['runway.gen4_image', '1'], array['runway.aleph2', v_seconds::text]];
      else
        v_lines := array[array['runway.aleph2', v_seconds::text]];
      end if;
    else
      v_errors := v_errors || to_jsonb('Modo de transformação indisponível: nenhuma integração conectada executa "' || coalesce(v_mode, '?') || '"'::text);
    end if;
  else
    v_errors := v_errors || to_jsonb('Tipo de tarefa desconhecido'::text);
  end if;

  for v_i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    select * into v_price from public.price_catalog where key = v_lines[v_i][1];
    if v_price.key is null or not v_price.active then
      v_errors := v_errors || to_jsonb('Modelo indisponível: ' || v_lines[v_i][1]);
      continue;
    end if;
    v_units := v_lines[v_i][2]::numeric;
    if v_price.unit = 'second' then
      if v_units <= 0 then
        v_errors := v_errors || to_jsonb('Duração inválida para ' || v_price.label);
      end if;
      if v_price.min_seconds is not null and v_units < v_price.min_seconds then
        v_errors := v_errors || to_jsonb(format('%s exige no mínimo %s s (trecho atual: %s s)', v_price.label, v_price.min_seconds, round(v_units, 1)));
      end if;
      if v_price.max_seconds is not null and v_units > v_price.max_seconds then
        v_errors := v_errors || to_jsonb(format('%s aceita no máximo %s s (trecho atual: %s s). Selecione um trecho menor.', v_price.label, v_price.max_seconds, round(v_units, 1)));
      end if;
      v_units := ceil(v_units);
    end if;
    v_credits := greatest(ceil(v_units * v_price.credits_per_unit)::integer, v_price.min_credits);
    if v_price.credits_per_unit = 0 then v_credits := 0; end if;
    v_total := v_total + v_credits;
    v_items := v_items || jsonb_build_object('key', v_price.key, 'label', v_price.label, 'unit', v_price.unit,
      'units', v_units, 'credits', v_credits, 'max_seconds', v_price.max_seconds, 'min_seconds', v_price.min_seconds);
  end loop;

  if v_provider is not null and not exists (select 1 from public.integrations where id = v_provider and enabled) then
    v_errors := v_errors || to_jsonb('Integração desabilitada pelo administrador: ' || v_provider);
  end if;

  return jsonb_build_object('credits', v_total, 'provider', v_provider, 'items', v_items, 'errors', v_errors,
    'credit_value_usd', public.setting('credit_value_usd'));
end $$;

-- ---------------------------------------------------------------------------
-- Criação de tarefa (com reserva de créditos)
-- ---------------------------------------------------------------------------
create or replace function public.month_provider_spend_usd() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case
      when status in ('succeeded', 'failed', 'canceled') then coalesce(actual_usd, 0)
      else estimated_credits * (public.setting('credit_value_usd'))::text::numeric end), 0)
  from public.jobs where created_at >= date_trunc('month', now())
$$;

create or replace function public.create_job(
  p_kind text,
  p_params jsonb,
  p_input_asset_ids uuid[],
  p_project_id uuid,
  p_idempotency_key text,
  p_confirmed_credits integer
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_plan public.plans;
  v_job public.jobs;
  v_est jsonb;
  v_credits integer;
  v_today integer;
  v_budget numeric := coalesce((public.setting('monthly_budget_usd'))::text::numeric, 0);
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_missing integer;
  v_seconds numeric;
  v_n integer;
  v_videos integer;
begin
  if v_uid is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Chave de idempotência inválida' using errcode = '22023';
  end if;

  -- repetição da mesma requisição devolve a mesma tarefa (sem nova cobrança)
  select * into v_job from public.jobs where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return v_job; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended then raise exception 'Conta suspensa' using errcode = '42501'; end if;
  if v_profile.terms_accepted_at is null then
    raise exception 'Aceite os termos de uso antes de processar arquivos' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where id = v_profile.plan_id;

  p_input_asset_ids := coalesce(p_input_asset_ids, '{}');
  select count(*) into v_missing from unnest(p_input_asset_ids) a(id)
    where not exists (select 1 from public.assets s where s.id = a.id and s.user_id = v_uid
                      and (s.probe_status = 'ok' or p_kind = 'media.probe'));
  if v_missing > 0 then
    raise exception 'Arquivo inexistente, de outra conta ou ainda não validado' using errcode = '42501';
  end if;
  -- quantidade e tipo de arquivos de entrada por tipo de tarefa
  v_n := cardinality(p_input_asset_ids);
  select count(*) into v_videos from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'video';
  if (p_kind in ('media.probe') and v_n <> 1)
     or (p_kind in ('media.trim', 'media.export', 'media.autocut', 'ai.transform') and (v_n <> 1 or v_videos <> 1))
     or (p_kind = 'media.concat' and (v_n < 1 or v_n > 50 or v_videos <> v_n))
     or (p_kind in ('ai.tts', 'ai.text') and v_n <> 0)
     or (p_kind = 'ai.video' and (v_n > 1 or v_videos > 0))
     or (p_kind = 'ai.image' and (v_n > 3 or v_videos > 0)) then
    raise exception 'Arquivos de entrada inválidos para esta operação' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (select 1 from public.projects where id = p_project_id and user_id = v_uid) then
    raise exception 'Projeto inválido' using errcode = '42501';
  end if;

  if p_kind = 'ai.transform' then
    if coalesce((p_params ->> 'rights_confirmed')::boolean, false) is not true
       or exists (select 1 from public.assets where id = any(p_input_asset_ids) and rights_confirmed_at is null) then
      raise exception 'Confirme que você tem direitos ou autorização para usar e modificar este vídeo' using errcode = '42501';
    end if;
  end if;
  if p_params ? 'character_id' and (p_params ->> 'character_id') is not null
     and not exists (select 1 from public.characters where id = (p_params ->> 'character_id')::uuid and user_id = v_uid) then
    raise exception 'Personagem inválido' using errcode = '42501';
  end if;

  v_seconds := public.job_duration(p_params, p_input_asset_ids);
  if p_kind in ('ai.transform', 'media.export', 'media.autocut') and v_seconds > v_plan.max_video_seconds then
    raise exception 'Seu plano permite trechos de até % s (selecionado: % s)', v_plan.max_video_seconds, round(v_seconds, 1) using errcode = 'P0001';
  end if;

  v_est := public.estimate_job(p_kind, p_params, p_input_asset_ids);
  if jsonb_array_length(v_est -> 'errors') > 0 then
    raise exception '%', v_est -> 'errors' ->> 0 using errcode = 'P0001';
  end if;
  v_credits := (v_est ->> 'credits')::integer;

  if v_credits > coalesce(p_confirmed_credits, -1) then
    raise exception 'A estimativa mudou para % créditos. Revise e confirme novamente.', v_credits using errcode = 'P0002';
  end if;
  if v_credits > v_plan.max_job_credits then
    raise exception 'Esta tarefa (% créditos) passa do limite por tarefa do seu plano (%)', v_credits, v_plan.max_job_credits using errcode = 'P0001';
  end if;
  select coalesce(sum(coalesce(charged_credits, estimated_credits)), 0) into v_today from public.jobs
    where user_id = v_uid and created_at >= date_trunc('day', now()) and status not in ('failed', 'canceled');
  if v_today + v_credits > v_plan.daily_credit_limit then
    raise exception 'Limite diário de % créditos do seu plano atingido', v_plan.daily_credit_limit using errcode = 'P0001';
  end if;
  if v_budget > 0 and v_credits > 0 and public.month_provider_spend_usd() + v_credits * v_value > v_budget then
    perform public.audit('budget.blocked', p_kind, jsonb_build_object('user', v_uid, 'credits', v_credits));
    raise exception 'O orçamento mensal da plataforma foi atingido. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, project_id, kind, provider, model, params, input_asset_ids, estimate,
                           estimated_credits, idempotency_key, max_attempts)
  values (v_uid, p_project_id, p_kind, v_est ->> 'provider', p_params ->> 'model', coalesce(p_params, '{}'::jsonb),
          p_input_asset_ids, v_est, v_credits, p_idempotency_key,
          coalesce((public.setting('job_max_attempts'))::text::integer, 3))
  returning * into v_job;

  if v_credits > 0 then
    update public.credit_accounts set available = available - v_credits, reserved = reserved + v_credits, updated_at = now()
      where user_id = v_uid and available >= v_credits;
    if not found then
      raise exception 'Créditos insuficientes: esta tarefa precisa de % créditos', v_credits using errcode = 'P0003';
    end if;
    insert into public.credit_ledger (user_id, delta, kind, job_id, note)
      values (v_uid, -v_credits, 'reserve', v_job.id, 'Reserva: ' || p_kind);
  end if;
  insert into public.job_events (job_id, type, message) values (v_job.id, 'created', 'Tarefa na fila');
  return v_job;
end $$;

-- ---------------------------------------------------------------------------
-- Liquidação (uma única vez por tarefa)
-- ---------------------------------------------------------------------------
create or replace function public._settle_job(
  p_job_id uuid, p_status text, p_actual_usd numeric, p_provider_cost jsonb,
  p_output_asset_ids uuid[], p_result jsonb, p_error_code text, p_error_message text
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
  v_charge integer;
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_markup numeric := coalesce((public.setting('provider_markup'))::text::numeric, 1);
  v_refund_full boolean := coalesce((public.setting('refund_failed_full'))::text::boolean, true);
begin
  if p_status not in ('succeeded', 'failed', 'canceled') then
    raise exception 'Estado final inválido' using errcode = '22023';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then raise exception 'Tarefa não encontrada' using errcode = 'P0002'; end if;
  if v_job.status in ('succeeded', 'failed', 'canceled') then
    return v_job;  -- idempotente
  end if;

  if p_status = 'succeeded' then
    v_charge := case when p_actual_usd is null then v_job.estimated_credits
                     else least(v_job.estimated_credits, ceil(p_actual_usd * v_markup / v_value)::integer) end;
  elsif v_refund_full or p_actual_usd is null then
    v_charge := 0;
  else
    v_charge := least(v_job.estimated_credits, ceil(p_actual_usd * v_markup / v_value)::integer);
  end if;
  v_charge := greatest(v_charge, 0);

  if v_job.estimated_credits > 0 then
    update public.credit_accounts
      set reserved = reserved - v_job.estimated_credits,
          available = available + (v_job.estimated_credits - v_charge),
          updated_at = now()
      where user_id = v_job.user_id;
    if v_job.estimated_credits - v_charge > 0 then
      insert into public.credit_ledger (user_id, delta, kind, job_id, note)
        values (v_job.user_id, v_job.estimated_credits - v_charge, 'refund', v_job.id,
                case p_status when 'succeeded' then 'Diferença entre estimativa e custo real'
                              when 'failed' then 'Reembolso: tarefa falhou'
                              else 'Reembolso: tarefa cancelada' end);
    end if;
  end if;

  update public.jobs set
    status = p_status,
    charged_credits = v_charge,
    actual_usd = p_actual_usd,
    provider_cost = coalesce(p_provider_cost, provider_cost),
    output_asset_ids = coalesce(p_output_asset_ids, output_asset_ids),
    result = coalesce(p_result, result),
    error_code = p_error_code,
    error_message = p_error_message,
    progress = case when p_status = 'succeeded' then 1 else progress end,
    finished_at = now(),
    locked_by = null,
    locked_at = null
  where id = p_job_id returning * into v_job;

  insert into public.job_events (job_id, type, message, data)
    values (p_job_id, p_status, coalesce(p_error_message, case p_status when 'succeeded' then 'Concluída' when 'canceled' then 'Cancelada' end),
            jsonb_build_object('charged_credits', v_charge, 'actual_usd', p_actual_usd));
  return v_job;
end $$;
revoke all on function public._settle_job(uuid, text, numeric, jsonb, uuid[], jsonb, text, text) from public, anon, authenticated;

create or replace function public.cancel_job(p_job_id uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = auth.uid() for update;
  if not found then raise exception 'Tarefa não encontrada' using errcode = 'P0002'; end if;
  if v_job.status in ('queued', 'waiting') then
    return public._settle_job(p_job_id, 'canceled', null, null, null, null, 'canceled_by_user', 'Cancelada pelo usuário');
  elsif v_job.status = 'processing' then
    update public.jobs set cancel_requested = true where id = p_job_id returning * into v_job;
    insert into public.job_events (job_id, type, message) values (p_job_id, 'cancel_requested', 'Cancelamento solicitado');
  end if;
  return v_job;
end $$;

-- ---------------------------------------------------------------------------
-- API do worker (somente service_role)
-- ---------------------------------------------------------------------------
create or replace function public.worker_claim_jobs(p_worker text, p_limit integer, p_kinds text[])
returns setof public.jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.jobs j set
    status = 'processing',
    locked_by = p_worker,
    locked_at = now(),
    started_at = coalesce(j.started_at, now()),
    attempts = j.attempts + 1
  where j.id in (
    select id from public.jobs
    where kind = any(p_kinds)
      and ((status in ('queued', 'waiting') and next_attempt_at <= now())
           -- trava abandonada (worker caiu): retoma pelo estado salvo, sem recriar tarefas no provedor
           or (status = 'processing' and locked_at < now() - interval '10 minutes'))
    order by created_at
    for update skip locked
    limit p_limit
  )
  returning j.*;
end $$;

create or replace function public.worker_progress(p_job_id uuid, p_worker text, p_progress numeric, p_state jsonb, p_task_id text, p_event text)
returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
begin
  update public.jobs set
    locked_at = now(),
    progress = coalesce(least(greatest(p_progress, 0), 1), progress),
    state = case when p_state is null then state else state || p_state end,
    provider_task_ids = case when p_task_id is null or p_task_id = any(provider_task_ids) then provider_task_ids
                             else provider_task_ids || p_task_id end
  where id = p_job_id and locked_by = p_worker and status = 'processing'
  returning * into v_job;
  if not found then raise exception 'Tarefa não está com este worker' using errcode = 'P0002'; end if;
  if p_event is not null then
    insert into public.job_events (job_id, type, message) values (p_job_id, 'progress', p_event);
  end if;
  return v_job;
end $$;

create or replace function public.worker_requeue(p_job_id uuid, p_worker text, p_delay_seconds integer, p_error text)
returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id and locked_by = p_worker and status = 'processing' for update;
  if not found then raise exception 'Tarefa não está com este worker' using errcode = 'P0002'; end if;
  if v_job.attempts >= v_job.max_attempts then
    return public._settle_job(p_job_id, 'failed', null, null, null, null, 'max_attempts', p_error);
  end if;
  update public.jobs set status = 'waiting', next_attempt_at = now() + make_interval(secs => greatest(p_delay_seconds, 1)),
    locked_by = null, locked_at = null, error_message = p_error
  where id = p_job_id returning * into v_job;
  insert into public.job_events (job_id, type, message) values (p_job_id, 'retry', p_error);
  return v_job;
end $$;

create or replace function public.worker_finish(
  p_job_id uuid, p_worker text, p_status text, p_actual_usd numeric, p_provider_cost jsonb,
  p_output_asset_ids uuid[], p_result jsonb, p_error_code text, p_error_message text
) returns public.jobs
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.jobs where id = p_job_id and (locked_by = p_worker or status in ('succeeded', 'failed', 'canceled'))) then
    raise exception 'Tarefa não está com este worker' using errcode = 'P0002';
  end if;
  return public._settle_job(p_job_id, p_status, p_actual_usd, p_provider_cost, p_output_asset_ids, p_result, p_error_code, p_error_message);
end $$;

create or replace function public.worker_heartbeat(p_worker text, p_version text, p_capabilities jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.worker_status (worker_id, version, capabilities, last_seen)
  values (p_worker, p_version, p_capabilities, now())
  on conflict (worker_id) do update set version = excluded.version, capabilities = excluded.capabilities, last_seen = now()
$$;

revoke all on function public.worker_claim_jobs(text, integer, text[]) from public, anon, authenticated;
revoke all on function public.worker_progress(uuid, text, numeric, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.worker_requeue(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.worker_finish(uuid, text, text, numeric, jsonb, uuid[], jsonb, text, text) from public, anon, authenticated;
revoke all on function public.worker_heartbeat(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.worker_claim_jobs(text, integer, text[]) to service_role;
grant execute on function public.worker_progress(uuid, text, numeric, jsonb, text, text) to service_role;
grant execute on function public.worker_requeue(uuid, text, integer, text) to service_role;
grant execute on function public.worker_finish(uuid, text, text, numeric, jsonb, uuid[], jsonb, text, text) to service_role;
grant execute on function public.worker_heartbeat(text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- O que está realmente disponível agora (para a interface habilitar opções)
-- ---------------------------------------------------------------------------
create or replace function public.platform_capabilities() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'worker_online', exists (select 1 from public.worker_status where last_seen > now() - interval '2 minutes'),
    'integrations', coalesce(jsonb_object_agg(i.id, jsonb_build_object(
      'label', i.label,
      'description', i.description,
      'enabled', i.enabled,
      'configured', exists (select 1 from public.worker_status w
                            where w.last_seen > now() - interval '2 minutes'
                              and coalesce((w.capabilities ->> i.id)::boolean, false)))), '{}'::jsonb)
  )
  from public.integrations i
$$;

-- ===== 20261022000400_admin_rls_storage.sql =====
-- Administração, exclusão de conta, RLS e armazenamento privado.

alter table public.profiles add column deletion_requested_at timestamptz;

-- ---------------------------------------------------------------------------
-- Funções administrativas (todas auditadas)
-- ---------------------------------------------------------------------------
create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso restrito a administradores' using errcode = '42501'; end if;
end $$;

create or replace function public.admin_adjust_credits(p_user uuid, p_delta integer, p_note text)
returns public.credit_accounts
language plpgsql security definer set search_path = public as $$
declare
  v_acc public.credit_accounts;
begin
  perform public.require_admin();
  if p_delta = 0 then raise exception 'Informe um valor diferente de zero' using errcode = '22023'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Informe o motivo' using errcode = '22023'; end if;
  update public.credit_accounts set available = available + p_delta, updated_at = now()
    where user_id = p_user and available + p_delta >= 0 returning * into v_acc;
  if not found then raise exception 'Usuário inexistente ou saldo ficaria negativo' using errcode = 'P0001'; end if;
  insert into public.credit_ledger (user_id, delta, kind, note, created_by) values (p_user, p_delta, 'adjust', p_note, auth.uid());
  perform public.audit('credits.adjust', p_user::text, jsonb_build_object('delta', p_delta, 'note', p_note));
  return v_acc;
end $$;

create or replace function public.admin_update_user(p_user uuid, p_role text, p_plan text, p_suspended boolean)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_old public.profiles;
  v_new public.profiles;
begin
  perform public.require_admin();
  select * into v_old from public.profiles where id = p_user;
  if p_user = auth.uid() and p_role is distinct from 'admin' then
    raise exception 'Você não pode remover o seu próprio acesso de administrador' using errcode = 'P0001';
  end if;
  update public.profiles set role = coalesce(p_role, role), plan_id = coalesce(p_plan, plan_id),
    suspended = coalesce(p_suspended, suspended)
    where id = p_user returning * into v_new;
  perform public.audit('user.update', p_user::text, jsonb_build_object(
    'role', jsonb_build_array(v_old.role, v_new.role), 'plan', jsonb_build_array(v_old.plan_id, v_new.plan_id),
    'suspended', jsonb_build_array(v_old.suspended, v_new.suspended)));
  return v_new;
end $$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns public.app_settings
language plpgsql security definer set search_path = public as $$
declare
  v_row public.app_settings;
begin
  perform public.require_admin();
  update public.app_settings set value = p_value, updated_at = now(), updated_by = auth.uid()
    where key = p_key returning * into v_row;
  if not found then raise exception 'Configuração desconhecida' using errcode = 'P0002'; end if;
  perform public.audit('setting.update', p_key, jsonb_build_object('value', p_value));
  return v_row;
end $$;

create or replace function public.admin_set_price(p_key text, p_credits_per_unit numeric, p_min_credits integer, p_max_seconds numeric, p_active boolean)
returns public.price_catalog
language plpgsql security definer set search_path = public as $$
declare
  v_row public.price_catalog;
begin
  perform public.require_admin();
  update public.price_catalog set credits_per_unit = p_credits_per_unit, min_credits = p_min_credits,
    max_seconds = p_max_seconds, active = p_active, updated_at = now()
    where key = p_key returning * into v_row;
  if not found then raise exception 'Preço desconhecido' using errcode = 'P0002'; end if;
  perform public.audit('price.update', p_key, to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.admin_set_integration(p_id text, p_enabled boolean)
returns public.integrations
language plpgsql security definer set search_path = public as $$
declare
  v_row public.integrations;
begin
  perform public.require_admin();
  update public.integrations set enabled = p_enabled, updated_at = now() where id = p_id returning * into v_row;
  if not found then raise exception 'Integração desconhecida' using errcode = 'P0002'; end if;
  perform public.audit('integration.update', p_id, jsonb_build_object('enabled', p_enabled));
  return v_row;
end $$;

create or replace function public.admin_update_plan(p_id text, p_patch jsonb)
returns public.plans
language plpgsql security definer set search_path = public as $$
declare
  v_row public.plans;
begin
  perform public.require_admin();
  update public.plans set
    monthly_credits = coalesce((p_patch ->> 'monthly_credits')::integer, monthly_credits),
    max_projects = coalesce((p_patch ->> 'max_projects')::integer, max_projects),
    max_characters = coalesce((p_patch ->> 'max_characters')::integer, max_characters),
    max_upload_mb = coalesce((p_patch ->> 'max_upload_mb')::integer, max_upload_mb),
    max_video_seconds = coalesce((p_patch ->> 'max_video_seconds')::integer, max_video_seconds),
    max_job_credits = coalesce((p_patch ->> 'max_job_credits')::integer, max_job_credits),
    daily_credit_limit = coalesce((p_patch ->> 'daily_credit_limit')::integer, daily_credit_limit),
    price_brl_cents = case when p_patch ? 'price_brl_cents' then (p_patch ->> 'price_brl_cents')::integer else price_brl_cents end,
    active = coalesce((p_patch ->> 'active')::boolean, active)
  where id = p_id returning * into v_row;
  if not found then raise exception 'Plano desconhecido' using errcode = 'P0002'; end if;
  perform public.audit('plan.update', p_id, p_patch);
  return v_row;
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform public.require_admin();
  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'projects', (select count(*) from public.projects),
    'characters', (select count(*) from public.characters),
    'jobs_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from
        (select status, count(*) n from public.jobs where created_at > now() - interval '30 days' group by status) s),
    'failure_rate_30d', (select case when count(*) filter (where status in ('succeeded', 'failed')) = 0 then 0
        else round(count(*) filter (where status = 'failed')::numeric / count(*) filter (where status in ('succeeded', 'failed')), 4) end
        from public.jobs where created_at > now() - interval '30 days'),
    'credits_charged_30d', (select coalesce(sum(charged_credits), 0) from public.jobs where finished_at > now() - interval '30 days'),
    'credits_outstanding', (select coalesce(sum(available), 0) from public.credit_accounts),
    'spend_month_usd', public.month_provider_spend_usd(),
    'budget_usd', public.setting('monthly_budget_usd'),
    'budget_alert_ratio', public.setting('budget_alert_ratio'),
    'usage_by_model', (select coalesce(jsonb_agg(u order by u.usd desc nulls last), '[]'::jsonb) from (
        select provider, coalesce(model, kind) as model, count(*) as jobs,
               count(*) filter (where status = 'failed') as failed,
               coalesce(sum(charged_credits), 0) as credits, round(coalesce(sum(actual_usd), 0), 4) as usd
        from public.jobs where created_at >= date_trunc('month', now()) group by 1, 2) u),
    'workers', (select coalesce(jsonb_agg(jsonb_build_object('id', worker_id, 'version', version,
        'capabilities', capabilities, 'last_seen', last_seen) order by last_seen desc), '[]'::jsonb) from public.worker_status),
    'subscriptions', (select coalesce(jsonb_object_agg(plan_id, n), '{}'::jsonb) from
        (select plan_id, count(*) n from public.profiles group by plan_id) p)
  ) into v;
  return v;
end $$;

-- Exclusão de conta: o worker (service_role) apaga arquivos e o usuário do Auth.
create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  update public.profiles set deletion_requested_at = now() where id = auth.uid();
  perform public.audit('account.deletion_requested', auth.uid()::text, '{}'::jsonb);
end $$;

create or replace function public.accept_terms() returns void
language sql security definer set search_path = public as $$
  update public.profiles set terms_accepted_at = coalesce(terms_accepted_at, now()) where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.audit_log enable row level security;
alter table public.characters enable row level security;
alter table public.projects enable row level security;
alter table public.assets enable row level security;
alter table public.scripts enable row level security;
alter table public.integrations enable row level security;
alter table public.worker_status enable row level security;
alter table public.price_catalog enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;

create policy settings_read on public.app_settings for select to authenticated using (true);
create policy plans_read on public.plans for select to authenticated, anon using (active or public.is_admin());
create policy integrations_read on public.integrations for select to authenticated using (true);
create policy prices_read on public.price_catalog for select to authenticated using (true);
create policy worker_status_admin on public.worker_status for select to authenticated using (public.is_admin());
create policy audit_admin on public.audit_log for select to authenticated using (public.is_admin());

create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy subscriptions_select on public.subscriptions for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy credit_accounts_select on public.credit_accounts for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy credit_ledger_select on public.credit_ledger for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy jobs_select on public.jobs for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy job_events_select on public.job_events for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_id and (j.user_id = auth.uid() or public.is_admin())));

-- Dados do usuário: somente o dono lê e escreve (o admin só lê, para suporte)
create policy characters_owner on public.characters for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy characters_admin_read on public.characters for select to authenticated using (public.is_admin());
create policy projects_owner on public.projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy projects_admin_read on public.projects for select to authenticated using (public.is_admin());
create policy assets_owner on public.assets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy scripts_owner on public.scripts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.characters, public.projects, public.assets, public.scripts to authenticated;
grant update on public.profiles to authenticated;
grant select on public.plans to anon;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- RPCs disponíveis para usuários logados
grant execute on function public.estimate_job(text, jsonb, uuid[]) to authenticated;
grant execute on function public.create_job(text, jsonb, uuid[], uuid, text, integer) to authenticated;
grant execute on function public.cancel_job(uuid) to authenticated;
grant execute on function public.platform_capabilities() to authenticated;
grant execute on function public.request_account_deletion() to authenticated;
grant execute on function public.accept_terms() to authenticated;

-- ---------------------------------------------------------------------------
-- Armazenamento privado: bucket "media", cada usuário só acessa a própria pasta
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 524288000, array[
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska',
  'image/png', 'image/jpeg', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg', 'audio/webm',
  'application/x-subrip', 'text/vtt', 'text/plain'])
on conflict (id) do nothing;

create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and split_part(name, '/', 1) = auth.uid()::text);
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and split_part(name, '/', 1) = auth.uid()::text);
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and split_part(name, '/', 1) = auth.uid()::text);

-- Funções internas não ficam expostas via API
revoke execute on function public.audit(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.month_provider_spend_usd() from public, anon, authenticated;
revoke execute on function public.job_duration(jsonb, uuid[]) from public, anon, authenticated;
revoke execute on function public.setting(text) from public, anon;

-- ===== 20261026000500_quickstart.sql =====
-- Ajustes para começar rápido:
--  * e-mails em admin_emails viram administradores automaticamente no cadastro
--    (dispensa rodar SQL à mão para criar o primeiro admin);
--  * limites compatíveis com o plano gratuito do Supabase (arquivos de até 50 MB);
--  * teto de gastos baixo durante a fase de testes.

insert into public.app_settings (key, value, description) values
  ('admin_emails', '["marcospr4do@gmail.com"]', 'E-mails que recebem acesso de administrador ao se cadastrar')
on conflict (key) do nothing;

update public.app_settings set value = '50' where key = 'max_upload_mb';
update public.app_settings set value = '10' where key = 'monthly_budget_usd';
update storage.buckets set file_size_limit = 52428800 where id = 'media';

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_bonus integer := coalesce((public.setting('signup_bonus_credits'))::text::integer, 0);
  v_terms boolean := coalesce((new.raw_user_meta_data ->> 'terms_accepted')::boolean, false);
  v_admin boolean := coalesce(public.setting('admin_emails') ? lower(new.email), false);
begin
  insert into public.profiles (id, email, display_name, terms_accepted_at, role)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
          case when v_terms then now() end,
          case when v_admin then 'admin' else 'user' end);
  insert into public.credit_accounts (user_id, available) values (new.id, v_bonus);
  if v_bonus > 0 then
    insert into public.credit_ledger (user_id, delta, kind, note) values (new.id, v_bonus, 'grant', 'Bônus de cadastro');
  end if;
  if v_admin then
    perform public.audit('user.auto_admin', new.id::text, jsonb_build_object('email', new.email));
  end if;
  return new;
end $$;

-- ===== 20261102000600_local_engine.sql =====
-- Fase 1 do motor próprio: IA rodando no nosso servidor (CPU), sem provedor pago.
--  * local.transcribe: legendas automáticas a partir da fala (Whisper / whisper.cpp)
--  * local.tts: voz sintética em português (Piper)

insert into public.integrations (id, label, description) values
  ('local', 'Motor próprio (servidor)', 'Legendas automáticas (Whisper) e voz em português (Piper) rodando no nosso servidor, sem custo por uso')
on conflict (id) do nothing;

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut',
  'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text',
  'local.transcribe', 'local.tts'));

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, min_seconds, max_seconds, notes) values
  ('local.transcribe', 'Legendas automáticas (Whisper, motor próprio)', 'local', 'second', 0, 0, null, 300,
   'Roda no nosso servidor: sem custo de provedor. Ajuste o limite conforme a potência da máquina.'),
  ('local.tts', 'Voz própria (Piper, motor próprio)', 'local', 'chars50', 0, 0, null, null,
   'Roda no nosso servidor: sem custo de provedor.')
on conflict (key) do nothing;

create or replace function public.estimate_job(p_kind text, p_params jsonb, p_input_asset_ids uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_lines text[][] := '{}';     -- pares (chave, unidades)
  v_total integer := 0;
  v_seconds numeric;
  v_model text := p_params ->> 'model';
  v_mode text := p_params ->> 'mode';
  v_price public.price_catalog;
  v_units numeric;
  v_credits integer;
  v_i integer;
  v_provider text;
begin
  if p_kind like 'media.%' then
    v_provider := 'ffmpeg';
    if p_kind in ('media.export', 'media.concat', 'media.autocut') then
      v_lines := array[array[p_kind, public.job_duration(p_params, p_input_asset_ids)::text]];
    else
      v_lines := array[array[p_kind, '1']];
    end if;
  elsif p_kind = 'local.transcribe' then
    v_provider := 'local';
    v_lines := array[array['local.transcribe', public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'local.tts' then
    v_provider := 'local';
    v_lines := array[array['local.tts', greatest(ceil(length(coalesce(p_params ->> 'text', '')) / 50.0), 1)::text]];
  elsif p_kind = 'ai.text' then
    v_provider := 'anthropic';
    v_lines := array[array['anthropic.text', '1']];
  elsif p_kind = 'ai.image' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4_image'), coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.video' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4.5'), coalesce(p_params ->> 'duration', '5')]];
  elsif p_kind = 'ai.tts' then
    v_provider := 'runway';
    v_lines := array[array['runway.eleven_v3', ceil(length(coalesce(p_params ->> 'text', '')) / 50.0)::text]];
  elsif p_kind = 'ai.transform' then
    v_provider := 'runway';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode = 'full_body' then
      v_lines := array[array['runway.act_two', v_seconds::text]];
    elsif v_mode = 'cinematic' then
      v_lines := array[array['runway.gen4_image', '1'], array['runway.act_two', v_seconds::text]];
    elsif v_mode in ('appearance', 'stylized') then
      if coalesce((p_params ->> 'use_character_keyframe')::boolean, true) then
        v_lines := array[array['runway.gen4_image', '1'], array['runway.aleph2', v_seconds::text]];
      else
        v_lines := array[array['runway.aleph2', v_seconds::text]];
      end if;
    else
      v_errors := v_errors || to_jsonb('Modo de transformação indisponível: nenhuma integração conectada executa "' || coalesce(v_mode, '?') || '"'::text);
    end if;
  else
    v_errors := v_errors || to_jsonb('Tipo de tarefa desconhecido'::text);
  end if;

  for v_i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    select * into v_price from public.price_catalog where key = v_lines[v_i][1];
    if v_price.key is null or not v_price.active then
      v_errors := v_errors || to_jsonb('Modelo indisponível: ' || v_lines[v_i][1]);
      continue;
    end if;
    v_units := v_lines[v_i][2]::numeric;
    if v_price.unit = 'second' then
      if v_units <= 0 then
        v_errors := v_errors || to_jsonb('Duração inválida para ' || v_price.label);
      end if;
      if v_price.min_seconds is not null and v_units < v_price.min_seconds then
        v_errors := v_errors || to_jsonb(format('%s exige no mínimo %s s (trecho atual: %s s)', v_price.label, v_price.min_seconds, round(v_units, 1)));
      end if;
      if v_price.max_seconds is not null and v_units > v_price.max_seconds then
        v_errors := v_errors || to_jsonb(format('%s aceita no máximo %s s (trecho atual: %s s). Selecione um trecho menor.', v_price.label, v_price.max_seconds, round(v_units, 1)));
      end if;
      v_units := ceil(v_units);
    end if;
    v_credits := greatest(ceil(v_units * v_price.credits_per_unit)::integer, v_price.min_credits);
    if v_price.credits_per_unit = 0 then v_credits := 0; end if;
    v_total := v_total + v_credits;
    v_items := v_items || jsonb_build_object('key', v_price.key, 'label', v_price.label, 'unit', v_price.unit,
      'units', v_units, 'credits', v_credits, 'max_seconds', v_price.max_seconds, 'min_seconds', v_price.min_seconds);
  end loop;

  if v_provider is not null and not exists (select 1 from public.integrations where id = v_provider and enabled) then
    v_errors := v_errors || to_jsonb('Integração desabilitada pelo administrador: ' || v_provider);
  end if;

  return jsonb_build_object('credits', v_total, 'provider', v_provider, 'items', v_items, 'errors', v_errors,
    'credit_value_usd', public.setting('credit_value_usd'));
end $$;

create or replace function public.create_job(
  p_kind text,
  p_params jsonb,
  p_input_asset_ids uuid[],
  p_project_id uuid,
  p_idempotency_key text,
  p_confirmed_credits integer
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_plan public.plans;
  v_job public.jobs;
  v_est jsonb;
  v_credits integer;
  v_today integer;
  v_budget numeric := coalesce((public.setting('monthly_budget_usd'))::text::numeric, 0);
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_missing integer;
  v_seconds numeric;
  v_n integer;
  v_videos integer;
begin
  if v_uid is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Chave de idempotência inválida' using errcode = '22023';
  end if;

  -- repetição da mesma requisição devolve a mesma tarefa (sem nova cobrança)
  select * into v_job from public.jobs where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return v_job; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended then raise exception 'Conta suspensa' using errcode = '42501'; end if;
  if v_profile.terms_accepted_at is null then
    raise exception 'Aceite os termos de uso antes de processar arquivos' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where id = v_profile.plan_id;

  p_input_asset_ids := coalesce(p_input_asset_ids, '{}');
  select count(*) into v_missing from unnest(p_input_asset_ids) a(id)
    where not exists (select 1 from public.assets s where s.id = a.id and s.user_id = v_uid
                      and (s.probe_status = 'ok' or p_kind = 'media.probe'));
  if v_missing > 0 then
    raise exception 'Arquivo inexistente, de outra conta ou ainda não validado' using errcode = '42501';
  end if;
  -- quantidade e tipo de arquivos de entrada por tipo de tarefa
  v_n := cardinality(p_input_asset_ids);
  select count(*) into v_videos from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'video';
  if (p_kind in ('media.probe') and v_n <> 1)
     or (p_kind in ('media.trim', 'media.export', 'media.autocut', 'ai.transform') and (v_n <> 1 or v_videos <> 1))
     or (p_kind = 'media.concat' and (v_n < 1 or v_n > 50 or v_videos <> v_n))
     or (p_kind in ('ai.tts', 'ai.text', 'local.tts') and v_n <> 0)
     or (p_kind = 'local.transcribe' and (v_n <> 1 or not exists (
           select 1 from public.assets where id = p_input_asset_ids[1] and kind in ('video', 'audio'))))
     or (p_kind = 'ai.video' and (v_n > 1 or v_videos > 0))
     or (p_kind = 'ai.image' and (v_n > 3 or v_videos > 0)) then
    raise exception 'Arquivos de entrada inválidos para esta operação' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (select 1 from public.projects where id = p_project_id and user_id = v_uid) then
    raise exception 'Projeto inválido' using errcode = '42501';
  end if;

  if p_kind = 'ai.transform' then
    if coalesce((p_params ->> 'rights_confirmed')::boolean, false) is not true
       or exists (select 1 from public.assets where id = any(p_input_asset_ids) and rights_confirmed_at is null) then
      raise exception 'Confirme que você tem direitos ou autorização para usar e modificar este vídeo' using errcode = '42501';
    end if;
  end if;
  if p_params ? 'character_id' and (p_params ->> 'character_id') is not null
     and not exists (select 1 from public.characters where id = (p_params ->> 'character_id')::uuid and user_id = v_uid) then
    raise exception 'Personagem inválido' using errcode = '42501';
  end if;

  v_seconds := public.job_duration(p_params, p_input_asset_ids);
  if p_kind in ('ai.transform', 'media.export', 'media.autocut') and v_seconds > v_plan.max_video_seconds then
    raise exception 'Seu plano permite trechos de até % s (selecionado: % s)', v_plan.max_video_seconds, round(v_seconds, 1) using errcode = 'P0001';
  end if;

  v_est := public.estimate_job(p_kind, p_params, p_input_asset_ids);
  if jsonb_array_length(v_est -> 'errors') > 0 then
    raise exception '%', v_est -> 'errors' ->> 0 using errcode = 'P0001';
  end if;
  v_credits := (v_est ->> 'credits')::integer;

  if v_credits > coalesce(p_confirmed_credits, -1) then
    raise exception 'A estimativa mudou para % créditos. Revise e confirme novamente.', v_credits using errcode = 'P0002';
  end if;
  if v_credits > v_plan.max_job_credits then
    raise exception 'Esta tarefa (% créditos) passa do limite por tarefa do seu plano (%)', v_credits, v_plan.max_job_credits using errcode = 'P0001';
  end if;
  select coalesce(sum(coalesce(charged_credits, estimated_credits)), 0) into v_today from public.jobs
    where user_id = v_uid and created_at >= date_trunc('day', now()) and status not in ('failed', 'canceled');
  if v_today + v_credits > v_plan.daily_credit_limit then
    raise exception 'Limite diário de % créditos do seu plano atingido', v_plan.daily_credit_limit using errcode = 'P0001';
  end if;
  if v_budget > 0 and v_credits > 0 and public.month_provider_spend_usd() + v_credits * v_value > v_budget then
    perform public.audit('budget.blocked', p_kind, jsonb_build_object('user', v_uid, 'credits', v_credits));
    raise exception 'O orçamento mensal da plataforma foi atingido. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, project_id, kind, provider, model, params, input_asset_ids, estimate,
                           estimated_credits, idempotency_key, max_attempts)
  values (v_uid, p_project_id, p_kind, v_est ->> 'provider', p_params ->> 'model', coalesce(p_params, '{}'::jsonb),
          p_input_asset_ids, v_est, v_credits, p_idempotency_key,
          coalesce((public.setting('job_max_attempts'))::text::integer, 3))
  returning * into v_job;

  if v_credits > 0 then
    update public.credit_accounts set available = available - v_credits, reserved = reserved + v_credits, updated_at = now()
      where user_id = v_uid and available >= v_credits;
    if not found then
      raise exception 'Créditos insuficientes: esta tarefa precisa de % créditos', v_credits using errcode = 'P0003';
    end if;
    insert into public.credit_ledger (user_id, delta, kind, job_id, note)
      values (v_uid, -v_credits, 'reserve', v_job.id, 'Reserva: ' || p_kind);
  end if;
  insert into public.job_events (job_id, type, message) values (v_job.id, 'created', 'Tarefa na fila');
  return v_job;
end $$;

-- capacidades: inclui o que o motor próprio de cada worker online oferece
create or replace function public.platform_capabilities() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'worker_online', exists (select 1 from public.worker_status where last_seen > now() - interval '2 minutes'),
    'integrations', coalesce((select jsonb_object_agg(i.id, jsonb_build_object(
      'label', i.label,
      'description', i.description,
      'enabled', i.enabled,
      'configured', exists (select 1 from public.worker_status w
                            where w.last_seen > now() - interval '2 minutes'
                              and coalesce((w.capabilities ->> i.id)::boolean, false))))
      from public.integrations i), '{}'::jsonb),
    'local', jsonb_build_object(
      'transcribe', exists (select 1 from public.worker_status w where w.last_seen > now() - interval '2 minutes'
                            and coalesce((w.capabilities ->> 'local_transcribe')::boolean, false)),
      'tts', exists (select 1 from public.worker_status w where w.last_seen > now() - interval '2 minutes'
                     and coalesce((w.capabilities ->> 'local_tts')::boolean, false)),
      'voices', coalesce((select w.capabilities -> 'local_voices' from public.worker_status w
                          where w.last_seen > now() - interval '2 minutes' and jsonb_typeof(w.capabilities -> 'local_voices') = 'array'
                          order by w.last_seen desc limit 1), '[]'::jsonb))
  )
$$;

-- ===== 20261103000700_free_providers.sql =====
-- Opções gratuitas: Gemini (textos), Cloudflare Workers AI (imagens), vídeo animado
-- a partir de imagens (FFmpeg) e cofre de chaves de API editável pelo admin.

insert into public.integrations (id, label, description) values
  ('gemini', 'Google Gemini (plano grátis)', 'Roteiros, ganchos, legendas e divisão em cenas — plano gratuito com limite diário'),
  ('cloudflare', 'Cloudflare Workers AI (plano grátis)', 'Imagens de personagens e cenas (FLUX.1 schnell) — cota gratuita diária')
on conflict (id) do nothing;

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut', 'media.slideshow',
  'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text',
  'local.transcribe', 'local.tts'));

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, notes) values
  ('gemini.text', 'Roteiros e textos (Gemini, plano grátis)', 'gemini', 'request', 0, 0, 'Plano gratuito do Google: limite diário de pedidos.'),
  ('cloudflare.flux-1-schnell', 'Imagem (FLUX.1 schnell via Cloudflare, cota grátis)', 'cloudflare', 'image', 0, 0, 'Cota gratuita diária do Workers AI (10.000 neurons/dia).'),
  ('media.slideshow', 'Vídeo animado a partir de imagens', 'ffmpeg', 'request', 0, 0, 'Roda no nosso servidor.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Cofre de chaves de API: o admin grava pelo painel; somente o worker
-- (service_role) lê o valor. Nenhuma política de RLS para usuários.
-- ---------------------------------------------------------------------------
create table public.provider_secrets (
  name text primary key check (name in (
    'RUNWAYML_API_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN')),
  value text not null check (length(value) between 8 and 500),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.provider_secrets enable row level security;
revoke all on public.provider_secrets from anon, authenticated;
grant all on public.provider_secrets to service_role;

create or replace function public.admin_set_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_value is null or trim(p_value) = '' then
    delete from public.provider_secrets where name = p_name;
    perform public.audit('secret.delete', p_name, '{}'::jsonb);
    return;
  end if;
  insert into public.provider_secrets (name, value, updated_by) values (p_name, trim(p_value), auth.uid())
  on conflict (name) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  perform public.audit('secret.set', p_name, '{}'::jsonb);
end $$;

-- lista só o nome, a data e os 4 últimos caracteres (nunca o valor)
create or replace function public.admin_list_secrets() returns table (name text, hint text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return query select s.name, '…' || right(s.value, 4), s.updated_at from public.provider_secrets s order by s.name;
end $$;

create or replace function public.estimate_job(p_kind text, p_params jsonb, p_input_asset_ids uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_lines text[][] := '{}';     -- pares (chave, unidades)
  v_total integer := 0;
  v_seconds numeric;
  v_model text := p_params ->> 'model';
  v_mode text := p_params ->> 'mode';
  v_price public.price_catalog;
  v_units numeric;
  v_credits integer;
  v_i integer;
  v_provider text;
begin
  if p_kind like 'media.%' then
    v_provider := 'ffmpeg';
    if p_kind = 'media.slideshow' then
      v_lines := array[array[p_kind, '1']];
    elsif p_kind in ('media.export', 'media.concat', 'media.autocut') then
      v_lines := array[array[p_kind, public.job_duration(p_params, p_input_asset_ids)::text]];
    else
      v_lines := array[array[p_kind, '1']];
    end if;
  elsif p_kind = 'local.transcribe' then
    v_provider := 'local';
    v_lines := array[array['local.transcribe', public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'local.tts' then
    v_provider := 'local';
    v_lines := array[array['local.tts', greatest(ceil(length(coalesce(p_params ->> 'text', '')) / 50.0), 1)::text]];
  elsif p_kind = 'ai.text' and p_params ->> 'engine' = 'gemini' then
    v_provider := 'gemini';
    v_lines := array[array['gemini.text', '1']];
  elsif p_kind = 'ai.text' then
    v_provider := 'anthropic';
    v_lines := array[array['anthropic.text', '1']];
  elsif p_kind = 'ai.image' and p_params ->> 'engine' = 'cloudflare' then
    v_provider := 'cloudflare';
    v_lines := array[array['cloudflare.flux-1-schnell', coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.image' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4_image'), coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.video' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4.5'), coalesce(p_params ->> 'duration', '5')]];
  elsif p_kind = 'ai.tts' then
    v_provider := 'runway';
    v_lines := array[array['runway.eleven_v3', ceil(length(coalesce(p_params ->> 'text', '')) / 50.0)::text]];
  elsif p_kind = 'ai.transform' then
    v_provider := 'runway';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode = 'full_body' then
      v_lines := array[array['runway.act_two', v_seconds::text]];
    elsif v_mode = 'cinematic' then
      v_lines := array[array['runway.gen4_image', '1'], array['runway.act_two', v_seconds::text]];
    elsif v_mode in ('appearance', 'stylized') then
      if coalesce((p_params ->> 'use_character_keyframe')::boolean, true) then
        v_lines := array[array['runway.gen4_image', '1'], array['runway.aleph2', v_seconds::text]];
      else
        v_lines := array[array['runway.aleph2', v_seconds::text]];
      end if;
    else
      v_errors := v_errors || to_jsonb('Modo de transformação indisponível: nenhuma integração conectada executa "' || coalesce(v_mode, '?') || '"'::text);
    end if;
  else
    v_errors := v_errors || to_jsonb('Tipo de tarefa desconhecido'::text);
  end if;

  for v_i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    select * into v_price from public.price_catalog where key = v_lines[v_i][1];
    if v_price.key is null or not v_price.active then
      v_errors := v_errors || to_jsonb('Modelo indisponível: ' || v_lines[v_i][1]);
      continue;
    end if;
    v_units := v_lines[v_i][2]::numeric;
    if v_price.unit = 'second' then
      if v_units <= 0 then
        v_errors := v_errors || to_jsonb('Duração inválida para ' || v_price.label);
      end if;
      if v_price.min_seconds is not null and v_units < v_price.min_seconds then
        v_errors := v_errors || to_jsonb(format('%s exige no mínimo %s s (trecho atual: %s s)', v_price.label, v_price.min_seconds, round(v_units, 1)));
      end if;
      if v_price.max_seconds is not null and v_units > v_price.max_seconds then
        v_errors := v_errors || to_jsonb(format('%s aceita no máximo %s s (trecho atual: %s s). Selecione um trecho menor.', v_price.label, v_price.max_seconds, round(v_units, 1)));
      end if;
      v_units := ceil(v_units);
    end if;
    v_credits := greatest(ceil(v_units * v_price.credits_per_unit)::integer, v_price.min_credits);
    if v_price.credits_per_unit = 0 then v_credits := 0; end if;
    v_total := v_total + v_credits;
    v_items := v_items || jsonb_build_object('key', v_price.key, 'label', v_price.label, 'unit', v_price.unit,
      'units', v_units, 'credits', v_credits, 'max_seconds', v_price.max_seconds, 'min_seconds', v_price.min_seconds);
  end loop;

  if v_provider is not null and not exists (select 1 from public.integrations where id = v_provider and enabled) then
    v_errors := v_errors || to_jsonb('Integração desabilitada pelo administrador: ' || v_provider);
  end if;

  return jsonb_build_object('credits', v_total, 'provider', v_provider, 'items', v_items, 'errors', v_errors,
    'credit_value_usd', public.setting('credit_value_usd'));
end $$;

create or replace function public.create_job(
  p_kind text,
  p_params jsonb,
  p_input_asset_ids uuid[],
  p_project_id uuid,
  p_idempotency_key text,
  p_confirmed_credits integer
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_plan public.plans;
  v_job public.jobs;
  v_est jsonb;
  v_credits integer;
  v_today integer;
  v_budget numeric := coalesce((public.setting('monthly_budget_usd'))::text::numeric, 0);
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_missing integer;
  v_seconds numeric;
  v_n integer;
  v_videos integer;
begin
  if v_uid is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Chave de idempotência inválida' using errcode = '22023';
  end if;

  -- repetição da mesma requisição devolve a mesma tarefa (sem nova cobrança)
  select * into v_job from public.jobs where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return v_job; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended then raise exception 'Conta suspensa' using errcode = '42501'; end if;
  if v_profile.terms_accepted_at is null then
    raise exception 'Aceite os termos de uso antes de processar arquivos' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where id = v_profile.plan_id;

  p_input_asset_ids := coalesce(p_input_asset_ids, '{}');
  select count(*) into v_missing from unnest(p_input_asset_ids) a(id)
    where not exists (select 1 from public.assets s where s.id = a.id and s.user_id = v_uid
                      and (s.probe_status = 'ok' or p_kind = 'media.probe'));
  if v_missing > 0 then
    raise exception 'Arquivo inexistente, de outra conta ou ainda não validado' using errcode = '42501';
  end if;
  -- quantidade e tipo de arquivos de entrada por tipo de tarefa
  v_n := cardinality(p_input_asset_ids);
  select count(*) into v_videos from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'video';
  if (p_kind in ('media.probe') and v_n <> 1)
     or (p_kind in ('media.trim', 'media.export', 'media.autocut', 'ai.transform') and (v_n <> 1 or v_videos <> 1))
     or (p_kind = 'media.concat' and (v_n < 1 or v_n > 50 or v_videos <> v_n))
     or (p_kind in ('ai.tts', 'ai.text', 'local.tts') and v_n <> 0)
     or (p_kind = 'local.transcribe' and (v_n <> 1 or not exists (
           select 1 from public.assets where id = p_input_asset_ids[1] and kind in ('video', 'audio'))))
     or (p_kind = 'ai.video' and (v_n > 1 or v_videos > 0))
     or (p_kind = 'ai.image' and (v_n > 3 or v_videos > 0))
     or (p_kind = 'media.slideshow' and (v_videos > 0
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'image') not between 1 and 40
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'audio') > 1
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind not in ('image', 'audio')) > 0)) then
    raise exception 'Arquivos de entrada inválidos para esta operação' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (select 1 from public.projects where id = p_project_id and user_id = v_uid) then
    raise exception 'Projeto inválido' using errcode = '42501';
  end if;

  if p_kind = 'ai.transform' then
    if coalesce((p_params ->> 'rights_confirmed')::boolean, false) is not true
       or exists (select 1 from public.assets where id = any(p_input_asset_ids) and rights_confirmed_at is null) then
      raise exception 'Confirme que você tem direitos ou autorização para usar e modificar este vídeo' using errcode = '42501';
    end if;
  end if;
  if p_params ? 'character_id' and (p_params ->> 'character_id') is not null
     and not exists (select 1 from public.characters where id = (p_params ->> 'character_id')::uuid and user_id = v_uid) then
    raise exception 'Personagem inválido' using errcode = '42501';
  end if;

  v_seconds := public.job_duration(p_params, p_input_asset_ids);
  if p_kind in ('ai.transform', 'media.export', 'media.autocut') and v_seconds > v_plan.max_video_seconds then
    raise exception 'Seu plano permite trechos de até % s (selecionado: % s)', v_plan.max_video_seconds, round(v_seconds, 1) using errcode = 'P0001';
  end if;

  v_est := public.estimate_job(p_kind, p_params, p_input_asset_ids);
  if jsonb_array_length(v_est -> 'errors') > 0 then
    raise exception '%', v_est -> 'errors' ->> 0 using errcode = 'P0001';
  end if;
  v_credits := (v_est ->> 'credits')::integer;

  if v_credits > coalesce(p_confirmed_credits, -1) then
    raise exception 'A estimativa mudou para % créditos. Revise e confirme novamente.', v_credits using errcode = 'P0002';
  end if;
  if v_credits > v_plan.max_job_credits then
    raise exception 'Esta tarefa (% créditos) passa do limite por tarefa do seu plano (%)', v_credits, v_plan.max_job_credits using errcode = 'P0001';
  end if;
  select coalesce(sum(coalesce(charged_credits, estimated_credits)), 0) into v_today from public.jobs
    where user_id = v_uid and created_at >= date_trunc('day', now()) and status not in ('failed', 'canceled');
  if v_today + v_credits > v_plan.daily_credit_limit then
    raise exception 'Limite diário de % créditos do seu plano atingido', v_plan.daily_credit_limit using errcode = 'P0001';
  end if;
  if v_budget > 0 and v_credits > 0 and public.month_provider_spend_usd() + v_credits * v_value > v_budget then
    perform public.audit('budget.blocked', p_kind, jsonb_build_object('user', v_uid, 'credits', v_credits));
    raise exception 'O orçamento mensal da plataforma foi atingido. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, project_id, kind, provider, model, params, input_asset_ids, estimate,
                           estimated_credits, idempotency_key, max_attempts)
  values (v_uid, p_project_id, p_kind, v_est ->> 'provider', p_params ->> 'model', coalesce(p_params, '{}'::jsonb),
          p_input_asset_ids, v_est, v_credits, p_idempotency_key,
          coalesce((public.setting('job_max_attempts'))::text::integer, 3))
  returning * into v_job;

  if v_credits > 0 then
    update public.credit_accounts set available = available - v_credits, reserved = reserved + v_credits, updated_at = now()
      where user_id = v_uid and available >= v_credits;
    if not found then
      raise exception 'Créditos insuficientes: esta tarefa precisa de % créditos', v_credits using errcode = 'P0003';
    end if;
    insert into public.credit_ledger (user_id, delta, kind, job_id, note)
      values (v_uid, -v_credits, 'reserve', v_job.id, 'Reserva: ' || p_kind);
  end if;
  insert into public.job_events (job_id, type, message) values (v_job.id, 'created', 'Tarefa na fila');
  return v_job;
end $$;

-- ===== 20261104000800_auto_video.sql =====
-- Vídeo automático (tema ou roteiro → cenas → imagens → narração → vídeo), grátis.
-- Ideia inspirada no Pixelle-Video (AIDC-AI, Apache-2.0); implementação própria.

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut', 'media.slideshow',
  'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text',
  'local.transcribe', 'local.tts', 'pipeline.auto_video'));

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, notes) values
  ('pipeline.auto_video', 'Vídeo automático (opções grátis)', 'cloudflare', 'request', 0, 0,
   'Usa Gemini, Cloudflare (cota diária) e o nosso servidor: sem custo de provedor.')
on conflict (key) do nothing;

create or replace function public.estimate_job(p_kind text, p_params jsonb, p_input_asset_ids uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_lines text[][] := '{}';     -- pares (chave, unidades)
  v_total integer := 0;
  v_seconds numeric;
  v_model text := p_params ->> 'model';
  v_mode text := p_params ->> 'mode';
  v_price public.price_catalog;
  v_units numeric;
  v_credits integer;
  v_i integer;
  v_provider text;
begin
  if p_kind like 'media.%' then
    v_provider := 'ffmpeg';
    if p_kind = 'media.slideshow' then
      v_lines := array[array[p_kind, '1']];
    elsif p_kind in ('media.export', 'media.concat', 'media.autocut') then
      v_lines := array[array[p_kind, public.job_duration(p_params, p_input_asset_ids)::text]];
    else
      v_lines := array[array[p_kind, '1']];
    end if;
  elsif p_kind = 'pipeline.auto_video' then
    v_provider := 'cloudflare';
    v_lines := array[array['pipeline.auto_video', '1']];
  elsif p_kind = 'local.transcribe' then
    v_provider := 'local';
    v_lines := array[array['local.transcribe', public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'local.tts' then
    v_provider := 'local';
    v_lines := array[array['local.tts', greatest(ceil(length(coalesce(p_params ->> 'text', '')) / 50.0), 1)::text]];
  elsif p_kind = 'ai.text' and p_params ->> 'engine' = 'gemini' then
    v_provider := 'gemini';
    v_lines := array[array['gemini.text', '1']];
  elsif p_kind = 'ai.text' then
    v_provider := 'anthropic';
    v_lines := array[array['anthropic.text', '1']];
  elsif p_kind = 'ai.image' and p_params ->> 'engine' = 'cloudflare' then
    v_provider := 'cloudflare';
    v_lines := array[array['cloudflare.flux-1-schnell', coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.image' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4_image'), coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.video' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4.5'), coalesce(p_params ->> 'duration', '5')]];
  elsif p_kind = 'ai.tts' then
    v_provider := 'runway';
    v_lines := array[array['runway.eleven_v3', ceil(length(coalesce(p_params ->> 'text', '')) / 50.0)::text]];
  elsif p_kind = 'ai.transform' then
    v_provider := 'runway';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode = 'full_body' then
      v_lines := array[array['runway.act_two', v_seconds::text]];
    elsif v_mode = 'cinematic' then
      v_lines := array[array['runway.gen4_image', '1'], array['runway.act_two', v_seconds::text]];
    elsif v_mode in ('appearance', 'stylized') then
      if coalesce((p_params ->> 'use_character_keyframe')::boolean, true) then
        v_lines := array[array['runway.gen4_image', '1'], array['runway.aleph2', v_seconds::text]];
      else
        v_lines := array[array['runway.aleph2', v_seconds::text]];
      end if;
    else
      v_errors := v_errors || to_jsonb('Modo de transformação indisponível: nenhuma integração conectada executa "' || coalesce(v_mode, '?') || '"'::text);
    end if;
  else
    v_errors := v_errors || to_jsonb('Tipo de tarefa desconhecido'::text);
  end if;

  for v_i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    select * into v_price from public.price_catalog where key = v_lines[v_i][1];
    if v_price.key is null or not v_price.active then
      v_errors := v_errors || to_jsonb('Modelo indisponível: ' || v_lines[v_i][1]);
      continue;
    end if;
    v_units := v_lines[v_i][2]::numeric;
    if v_price.unit = 'second' then
      if v_units <= 0 then
        v_errors := v_errors || to_jsonb('Duração inválida para ' || v_price.label);
      end if;
      if v_price.min_seconds is not null and v_units < v_price.min_seconds then
        v_errors := v_errors || to_jsonb(format('%s exige no mínimo %s s (trecho atual: %s s)', v_price.label, v_price.min_seconds, round(v_units, 1)));
      end if;
      if v_price.max_seconds is not null and v_units > v_price.max_seconds then
        v_errors := v_errors || to_jsonb(format('%s aceita no máximo %s s (trecho atual: %s s). Selecione um trecho menor.', v_price.label, v_price.max_seconds, round(v_units, 1)));
      end if;
      v_units := ceil(v_units);
    end if;
    v_credits := greatest(ceil(v_units * v_price.credits_per_unit)::integer, v_price.min_credits);
    if v_price.credits_per_unit = 0 then v_credits := 0; end if;
    v_total := v_total + v_credits;
    v_items := v_items || jsonb_build_object('key', v_price.key, 'label', v_price.label, 'unit', v_price.unit,
      'units', v_units, 'credits', v_credits, 'max_seconds', v_price.max_seconds, 'min_seconds', v_price.min_seconds);
  end loop;

  if v_provider is not null and not exists (select 1 from public.integrations where id = v_provider and enabled) then
    v_errors := v_errors || to_jsonb('Integração desabilitada pelo administrador: ' || v_provider);
  end if;

  return jsonb_build_object('credits', v_total, 'provider', v_provider, 'items', v_items, 'errors', v_errors,
    'credit_value_usd', public.setting('credit_value_usd'));
end $$;

create or replace function public.create_job(
  p_kind text,
  p_params jsonb,
  p_input_asset_ids uuid[],
  p_project_id uuid,
  p_idempotency_key text,
  p_confirmed_credits integer
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_plan public.plans;
  v_job public.jobs;
  v_est jsonb;
  v_credits integer;
  v_today integer;
  v_budget numeric := coalesce((public.setting('monthly_budget_usd'))::text::numeric, 0);
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_missing integer;
  v_seconds numeric;
  v_n integer;
  v_videos integer;
begin
  if v_uid is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Chave de idempotência inválida' using errcode = '22023';
  end if;

  -- repetição da mesma requisição devolve a mesma tarefa (sem nova cobrança)
  select * into v_job from public.jobs where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return v_job; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended then raise exception 'Conta suspensa' using errcode = '42501'; end if;
  if v_profile.terms_accepted_at is null then
    raise exception 'Aceite os termos de uso antes de processar arquivos' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where id = v_profile.plan_id;

  p_input_asset_ids := coalesce(p_input_asset_ids, '{}');
  select count(*) into v_missing from unnest(p_input_asset_ids) a(id)
    where not exists (select 1 from public.assets s where s.id = a.id and s.user_id = v_uid
                      and (s.probe_status = 'ok' or p_kind = 'media.probe'));
  if v_missing > 0 then
    raise exception 'Arquivo inexistente, de outra conta ou ainda não validado' using errcode = '42501';
  end if;
  -- quantidade e tipo de arquivos de entrada por tipo de tarefa
  v_n := cardinality(p_input_asset_ids);
  select count(*) into v_videos from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'video';
  if (p_kind in ('media.probe') and v_n <> 1)
     or (p_kind in ('media.trim', 'media.export', 'media.autocut', 'ai.transform') and (v_n <> 1 or v_videos <> 1))
     or (p_kind = 'media.concat' and (v_n < 1 or v_n > 50 or v_videos <> v_n))
     or (p_kind in ('ai.tts', 'ai.text', 'local.tts', 'pipeline.auto_video') and v_n <> 0)
     or (p_kind = 'local.transcribe' and (v_n <> 1 or not exists (
           select 1 from public.assets where id = p_input_asset_ids[1] and kind in ('video', 'audio'))))
     or (p_kind = 'ai.video' and (v_n > 1 or v_videos > 0))
     or (p_kind = 'ai.image' and (v_n > 3 or v_videos > 0))
     or (p_kind = 'media.slideshow' and (v_videos > 0
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'image') not between 1 and 40
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'audio') > 1
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind not in ('image', 'audio')) > 0)) then
    raise exception 'Arquivos de entrada inválidos para esta operação' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (select 1 from public.projects where id = p_project_id and user_id = v_uid) then
    raise exception 'Projeto inválido' using errcode = '42501';
  end if;

  if p_kind = 'ai.transform' then
    if coalesce((p_params ->> 'rights_confirmed')::boolean, false) is not true
       or exists (select 1 from public.assets where id = any(p_input_asset_ids) and rights_confirmed_at is null) then
      raise exception 'Confirme que você tem direitos ou autorização para usar e modificar este vídeo' using errcode = '42501';
    end if;
  end if;
  if p_params ? 'character_id' and (p_params ->> 'character_id') is not null
     and not exists (select 1 from public.characters where id = (p_params ->> 'character_id')::uuid and user_id = v_uid) then
    raise exception 'Personagem inválido' using errcode = '42501';
  end if;

  v_seconds := public.job_duration(p_params, p_input_asset_ids);
  if p_kind in ('ai.transform', 'media.export', 'media.autocut') and v_seconds > v_plan.max_video_seconds then
    raise exception 'Seu plano permite trechos de até % s (selecionado: % s)', v_plan.max_video_seconds, round(v_seconds, 1) using errcode = 'P0001';
  end if;

  v_est := public.estimate_job(p_kind, p_params, p_input_asset_ids);
  if jsonb_array_length(v_est -> 'errors') > 0 then
    raise exception '%', v_est -> 'errors' ->> 0 using errcode = 'P0001';
  end if;
  v_credits := (v_est ->> 'credits')::integer;

  if v_credits > coalesce(p_confirmed_credits, -1) then
    raise exception 'A estimativa mudou para % créditos. Revise e confirme novamente.', v_credits using errcode = 'P0002';
  end if;
  if v_credits > v_plan.max_job_credits then
    raise exception 'Esta tarefa (% créditos) passa do limite por tarefa do seu plano (%)', v_credits, v_plan.max_job_credits using errcode = 'P0001';
  end if;
  select coalesce(sum(coalesce(charged_credits, estimated_credits)), 0) into v_today from public.jobs
    where user_id = v_uid and created_at >= date_trunc('day', now()) and status not in ('failed', 'canceled');
  if v_today + v_credits > v_plan.daily_credit_limit then
    raise exception 'Limite diário de % créditos do seu plano atingido', v_plan.daily_credit_limit using errcode = 'P0001';
  end if;
  if v_budget > 0 and v_credits > 0 and public.month_provider_spend_usd() + v_credits * v_value > v_budget then
    perform public.audit('budget.blocked', p_kind, jsonb_build_object('user', v_uid, 'credits', v_credits));
    raise exception 'O orçamento mensal da plataforma foi atingido. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, project_id, kind, provider, model, params, input_asset_ids, estimate,
                           estimated_credits, idempotency_key, max_attempts)
  values (v_uid, p_project_id, p_kind, v_est ->> 'provider', p_params ->> 'model', coalesce(p_params, '{}'::jsonb),
          p_input_asset_ids, v_est, v_credits, p_idempotency_key,
          coalesce((public.setting('job_max_attempts'))::text::integer, 3))
  returning * into v_job;

  if v_credits > 0 then
    update public.credit_accounts set available = available - v_credits, reserved = reserved + v_credits, updated_at = now()
      where user_id = v_uid and available >= v_credits;
    if not found then
      raise exception 'Créditos insuficientes: esta tarefa precisa de % créditos', v_credits using errcode = 'P0003';
    end if;
    insert into public.credit_ledger (user_id, delta, kind, job_id, note)
      values (v_uid, -v_credits, 'reserve', v_job.id, 'Reserva: ' || p_kind);
  end if;
  insert into public.job_events (job_id, type, message) values (v_job.id, 'created', 'Tarefa na fila');
  return v_job;
end $$;

-- ===== 20261105000900_fal.sql =====
-- fal.ai (pago por uso, barato): vídeo com movimento a partir de imagem (Wan 2.2),
-- troca da pessoa do vídeo pelo personagem e transferência de movimento (Wan 2.2 Animate)
-- e personagem falando a partir de imagem + áudio (VEED Fabric 1.0).
-- Preços em créditos da plataforma (padrão 1 crédito = US$ 0,01), conferir em fal.ai.

insert into public.integrations (id, label, description) values
  ('fal', 'fal.ai (pago por uso)', 'Vídeo com movimento a partir de imagem, troca da pessoa do vídeo pelo personagem e personagem falando')
on conflict (id) do nothing;

alter table public.provider_secrets drop constraint provider_secrets_name_check;
alter table public.provider_secrets add constraint provider_secrets_name_check check (name in (
  'RUNWAYML_API_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'FAL_KEY'));

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut', 'media.slideshow',
  'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text', 'ai.talk',
  'local.transcribe', 'local.tts', 'pipeline.auto_video'));

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, min_seconds, max_seconds, notes) values
  ('fal.wan-i2v.480p', 'Vídeo com movimento 480p (Wan 2.2 Turbo, ~5 s)', 'fal', 'request', 5, 5, null, null, 'fal.ai: ~US$ 0,05 por vídeo de 5 s em 480p. Conferir.'),
  ('fal.wan-i2v.720p', 'Vídeo com movimento 720p (Wan 2.2 Turbo, ~5 s)', 'fal', 'request', 10, 10, null, null, 'fal.ai: ~US$ 0,10 por vídeo de 5 s em 720p. Conferir.'),
  ('fal.animate.480p', 'Troca de personagem 480p (Wan 2.2 Animate)', 'fal', 'second', 4, 8, 1, 15, 'fal.ai: US$ 0,04 por segundo (16 quadros/s). Conferir.'),
  ('fal.animate.580p', 'Troca de personagem 580p (Wan 2.2 Animate)', 'fal', 'second', 6, 12, 1, 15, 'fal.ai: US$ 0,06 por segundo. Conferir.'),
  ('fal.animate.720p', 'Troca de personagem 720p (Wan 2.2 Animate)', 'fal', 'second', 8, 16, 1, 15, 'fal.ai: US$ 0,08 por segundo. Conferir.'),
  ('fal.fabric.480p', 'Personagem falando 480p (VEED Fabric)', 'fal', 'second', 8, 8, 1, 30, 'fal.ai: US$ 0,08 por segundo de vídeo. Conferir.'),
  ('fal.fabric.720p', 'Personagem falando 720p (VEED Fabric)', 'fal', 'second', 15, 15, 1, 30, 'fal.ai: US$ 0,15 por segundo de vídeo. Conferir.')
on conflict (key) do nothing;

create or replace function public.estimate_job(p_kind text, p_params jsonb, p_input_asset_ids uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_lines text[][] := '{}';     -- pares (chave, unidades)
  v_total integer := 0;
  v_seconds numeric;
  v_model text := p_params ->> 'model';
  v_mode text := p_params ->> 'mode';
  v_price public.price_catalog;
  v_units numeric;
  v_credits integer;
  v_i integer;
  v_provider text;
begin
  if p_kind like 'media.%' then
    v_provider := 'ffmpeg';
    if p_kind = 'media.slideshow' then
      v_lines := array[array[p_kind, '1']];
    elsif p_kind in ('media.export', 'media.concat', 'media.autocut') then
      v_lines := array[array[p_kind, public.job_duration(p_params, p_input_asset_ids)::text]];
    else
      v_lines := array[array[p_kind, '1']];
    end if;
  elsif p_kind = 'pipeline.auto_video' then
    v_provider := 'cloudflare';
    v_lines := array[array['pipeline.auto_video', '1']];
  elsif p_kind = 'local.transcribe' then
    v_provider := 'local';
    v_lines := array[array['local.transcribe', public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'local.tts' then
    v_provider := 'local';
    v_lines := array[array['local.tts', greatest(ceil(length(coalesce(p_params ->> 'text', '')) / 50.0), 1)::text]];
  elsif p_kind = 'ai.text' and p_params ->> 'engine' = 'gemini' then
    v_provider := 'gemini';
    v_lines := array[array['gemini.text', '1']];
  elsif p_kind = 'ai.text' then
    v_provider := 'anthropic';
    v_lines := array[array['anthropic.text', '1']];
  elsif p_kind = 'ai.image' and p_params ->> 'engine' = 'cloudflare' then
    v_provider := 'cloudflare';
    v_lines := array[array['cloudflare.flux-1-schnell', coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.image' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4_image'), coalesce(p_params ->> 'count', '1')]];
  elsif p_kind = 'ai.video' and p_params ->> 'engine' = 'fal' then
    v_provider := 'fal';
    v_lines := array[array['fal.wan-i2v.' || coalesce(p_params ->> 'resolution', '480p'), '1']];
  elsif p_kind = 'ai.talk' then
    v_provider := 'fal';
    v_lines := array[array['fal.fabric.' || coalesce(p_params ->> 'resolution', '480p'), public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'ai.transform' and p_params ->> 'engine' = 'fal' then
    v_provider := 'fal';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode in ('full_body', 'cinematic') then
      v_lines := array[array['fal.animate.' || coalesce(p_params ->> 'resolution', '480p'), v_seconds::text]];
    else
      v_errors := v_errors || to_jsonb('Este modo não está disponível no motor fal.ai'::text);
    end if;
  elsif p_kind = 'ai.video' then
    v_provider := 'runway';
    v_lines := array[array['runway.' || coalesce(v_model, 'gen4.5'), coalesce(p_params ->> 'duration', '5')]];
  elsif p_kind = 'ai.tts' then
    v_provider := 'runway';
    v_lines := array[array['runway.eleven_v3', ceil(length(coalesce(p_params ->> 'text', '')) / 50.0)::text]];
  elsif p_kind = 'ai.transform' then
    v_provider := 'runway';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode = 'full_body' then
      v_lines := array[array['runway.act_two', v_seconds::text]];
    elsif v_mode = 'cinematic' then
      v_lines := array[array['runway.gen4_image', '1'], array['runway.act_two', v_seconds::text]];
    elsif v_mode in ('appearance', 'stylized') then
      if coalesce((p_params ->> 'use_character_keyframe')::boolean, true) then
        v_lines := array[array['runway.gen4_image', '1'], array['runway.aleph2', v_seconds::text]];
      else
        v_lines := array[array['runway.aleph2', v_seconds::text]];
      end if;
    else
      v_errors := v_errors || to_jsonb('Modo de transformação indisponível: nenhuma integração conectada executa "' || coalesce(v_mode, '?') || '"'::text);
    end if;
  else
    v_errors := v_errors || to_jsonb('Tipo de tarefa desconhecido'::text);
  end if;

  for v_i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    select * into v_price from public.price_catalog where key = v_lines[v_i][1];
    if v_price.key is null or not v_price.active then
      v_errors := v_errors || to_jsonb('Modelo indisponível: ' || v_lines[v_i][1]);
      continue;
    end if;
    v_units := v_lines[v_i][2]::numeric;
    if v_price.unit = 'second' then
      if v_units <= 0 then
        v_errors := v_errors || to_jsonb('Duração inválida para ' || v_price.label);
      end if;
      if v_price.min_seconds is not null and v_units < v_price.min_seconds then
        v_errors := v_errors || to_jsonb(format('%s exige no mínimo %s s (trecho atual: %s s)', v_price.label, v_price.min_seconds, round(v_units, 1)));
      end if;
      if v_price.max_seconds is not null and v_units > v_price.max_seconds then
        v_errors := v_errors || to_jsonb(format('%s aceita no máximo %s s (trecho atual: %s s). Selecione um trecho menor.', v_price.label, v_price.max_seconds, round(v_units, 1)));
      end if;
      v_units := ceil(v_units);
    end if;
    v_credits := greatest(ceil(v_units * v_price.credits_per_unit)::integer, v_price.min_credits);
    if v_price.credits_per_unit = 0 then v_credits := 0; end if;
    v_total := v_total + v_credits;
    v_items := v_items || jsonb_build_object('key', v_price.key, 'label', v_price.label, 'unit', v_price.unit,
      'units', v_units, 'credits', v_credits, 'max_seconds', v_price.max_seconds, 'min_seconds', v_price.min_seconds);
  end loop;

  if v_provider is not null and not exists (select 1 from public.integrations where id = v_provider and enabled) then
    v_errors := v_errors || to_jsonb('Integração desabilitada pelo administrador: ' || v_provider);
  end if;

  return jsonb_build_object('credits', v_total, 'provider', v_provider, 'items', v_items, 'errors', v_errors,
    'credit_value_usd', public.setting('credit_value_usd'));
end $$;

create or replace function public.create_job(
  p_kind text,
  p_params jsonb,
  p_input_asset_ids uuid[],
  p_project_id uuid,
  p_idempotency_key text,
  p_confirmed_credits integer
) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_plan public.plans;
  v_job public.jobs;
  v_est jsonb;
  v_credits integer;
  v_today integer;
  v_budget numeric := coalesce((public.setting('monthly_budget_usd'))::text::numeric, 0);
  v_value numeric := (public.setting('credit_value_usd'))::text::numeric;
  v_missing integer;
  v_seconds numeric;
  v_n integer;
  v_videos integer;
begin
  if v_uid is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Chave de idempotência inválida' using errcode = '22023';
  end if;

  -- repetição da mesma requisição devolve a mesma tarefa (sem nova cobrança)
  select * into v_job from public.jobs where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return v_job; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended then raise exception 'Conta suspensa' using errcode = '42501'; end if;
  if v_profile.terms_accepted_at is null then
    raise exception 'Aceite os termos de uso antes de processar arquivos' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where id = v_profile.plan_id;

  p_input_asset_ids := coalesce(p_input_asset_ids, '{}');
  select count(*) into v_missing from unnest(p_input_asset_ids) a(id)
    where not exists (select 1 from public.assets s where s.id = a.id and s.user_id = v_uid
                      and (s.probe_status = 'ok' or p_kind = 'media.probe'));
  if v_missing > 0 then
    raise exception 'Arquivo inexistente, de outra conta ou ainda não validado' using errcode = '42501';
  end if;
  -- quantidade e tipo de arquivos de entrada por tipo de tarefa
  v_n := cardinality(p_input_asset_ids);
  select count(*) into v_videos from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'video';
  if (p_kind in ('media.probe') and v_n <> 1)
     or (p_kind in ('media.trim', 'media.export', 'media.autocut', 'ai.transform') and (v_n <> 1 or v_videos <> 1))
     or (p_kind = 'media.concat' and (v_n < 1 or v_n > 50 or v_videos <> v_n))
     or (p_kind in ('ai.tts', 'ai.text', 'local.tts', 'pipeline.auto_video') and v_n <> 0)
     or (p_kind = 'local.transcribe' and (v_n <> 1 or not exists (
           select 1 from public.assets where id = p_input_asset_ids[1] and kind in ('video', 'audio'))))
     or (p_kind = 'ai.video' and (v_n > 1 or v_videos > 0))
     or (p_kind = 'ai.talk' and (v_n <> 2 or v_videos > 0
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'image') <> 1
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'audio') <> 1))
     or (p_kind = 'ai.image' and (v_n > 3 or v_videos > 0))
     or (p_kind = 'media.slideshow' and (v_videos > 0
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'image') not between 1 and 40
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'audio') > 1
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind not in ('image', 'audio')) > 0)) then
    raise exception 'Arquivos de entrada inválidos para esta operação' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (select 1 from public.projects where id = p_project_id and user_id = v_uid) then
    raise exception 'Projeto inválido' using errcode = '42501';
  end if;

  if p_kind = 'ai.transform' then
    if coalesce((p_params ->> 'rights_confirmed')::boolean, false) is not true
       or exists (select 1 from public.assets where id = any(p_input_asset_ids) and rights_confirmed_at is null) then
      raise exception 'Confirme que você tem direitos ou autorização para usar e modificar este vídeo' using errcode = '42501';
    end if;
  end if;
  if p_params ? 'character_id' and (p_params ->> 'character_id') is not null
     and not exists (select 1 from public.characters where id = (p_params ->> 'character_id')::uuid and user_id = v_uid) then
    raise exception 'Personagem inválido' using errcode = '42501';
  end if;

  v_seconds := public.job_duration(p_params, p_input_asset_ids);
  if p_kind in ('ai.transform', 'media.export', 'media.autocut') and v_seconds > v_plan.max_video_seconds then
    raise exception 'Seu plano permite trechos de até % s (selecionado: % s)', v_plan.max_video_seconds, round(v_seconds, 1) using errcode = 'P0001';
  end if;

  v_est := public.estimate_job(p_kind, p_params, p_input_asset_ids);
  if jsonb_array_length(v_est -> 'errors') > 0 then
    raise exception '%', v_est -> 'errors' ->> 0 using errcode = 'P0001';
  end if;
  v_credits := (v_est ->> 'credits')::integer;

  if v_credits > coalesce(p_confirmed_credits, -1) then
    raise exception 'A estimativa mudou para % créditos. Revise e confirme novamente.', v_credits using errcode = 'P0002';
  end if;
  if v_credits > v_plan.max_job_credits then
    raise exception 'Esta tarefa (% créditos) passa do limite por tarefa do seu plano (%)', v_credits, v_plan.max_job_credits using errcode = 'P0001';
  end if;
  select coalesce(sum(coalesce(charged_credits, estimated_credits)), 0) into v_today from public.jobs
    where user_id = v_uid and created_at >= date_trunc('day', now()) and status not in ('failed', 'canceled');
  if v_today + v_credits > v_plan.daily_credit_limit then
    raise exception 'Limite diário de % créditos do seu plano atingido', v_plan.daily_credit_limit using errcode = 'P0001';
  end if;
  if v_budget > 0 and v_credits > 0 and public.month_provider_spend_usd() + v_credits * v_value > v_budget then
    perform public.audit('budget.blocked', p_kind, jsonb_build_object('user', v_uid, 'credits', v_credits));
    raise exception 'O orçamento mensal da plataforma foi atingido. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, project_id, kind, provider, model, params, input_asset_ids, estimate,
                           estimated_credits, idempotency_key, max_attempts)
  values (v_uid, p_project_id, p_kind, v_est ->> 'provider', p_params ->> 'model', coalesce(p_params, '{}'::jsonb),
          p_input_asset_ids, v_est, v_credits, p_idempotency_key,
          coalesce((public.setting('job_max_attempts'))::text::integer, 3))
  returning * into v_job;

  if v_credits > 0 then
    update public.credit_accounts set available = available - v_credits, reserved = reserved + v_credits, updated_at = now()
      where user_id = v_uid and available >= v_credits;
    if not found then
      raise exception 'Créditos insuficientes: esta tarefa precisa de % créditos', v_credits using errcode = 'P0003';
    end if;
    insert into public.credit_ledger (user_id, delta, kind, job_id, note)
      values (v_uid, -v_credits, 'reserve', v_job.id, 'Reserva: ' || p_kind);
  end if;
  insert into public.job_events (job_id, type, message) values (v_job.id, 'created', 'Tarefa na fila');
  return v_job;
end $$;
