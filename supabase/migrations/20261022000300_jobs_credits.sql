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
