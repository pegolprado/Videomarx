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
