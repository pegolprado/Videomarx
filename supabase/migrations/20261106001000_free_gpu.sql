-- Opções grátis e baratas novas:
--  * hf: GPU gratuita do Hugging Face (ZeroGPU) via Spaces públicos — Wan 2.2 (vídeo com movimento),
--    Wan 2.2 Animate (troca de personagem) e personagem falando. Sem custo; cota diária pequena por conta/IP.
--    Os Spaces são configuráveis em app_settings (hf_space_*), pois são mantidos pela comunidade.
--  * pollinations: Pollinations (pago por uso, ~US$ 0,05 por vídeo Wan 2.2 de 5 s; outra forma de pagamento).
--  * motion: modelos animados com HyperFrames (código aberto, roda no nosso servidor, grátis).

insert into public.integrations (id, label, description) values
  ('hf', 'GPU grátis do Hugging Face (modo teste)', 'Vídeo com movimento, troca de personagem e personagem falando sem custo, com limite diário e fila pública. Token opcional aumenta a cota'),
  ('pollinations', 'Pollinations (pago por uso, barato)', 'Vídeo com movimento por texto ou imagem (Wan 2.2) a ~US$ 0,05 por vídeo'),
  ('motion', 'Modelos animados — HyperFrames (grátis)', 'Vídeos com textos e imagens animados, gerados no nosso servidor')
on conflict (id) do nothing;

alter table public.provider_secrets drop constraint provider_secrets_name_check;
alter table public.provider_secrets add constraint provider_secrets_name_check check (name in (
  'RUNWAYML_API_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'FAL_KEY',
  'HF_TOKEN', 'POLLINATIONS_KEY'));

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'media.probe', 'media.trim', 'media.export', 'media.concat', 'media.autocut', 'media.slideshow', 'media.motion',
  'ai.image', 'ai.video', 'ai.transform', 'ai.tts', 'ai.text', 'ai.talk',
  'local.transcribe', 'local.tts', 'pipeline.auto_video'));

insert into public.price_catalog (key, label, provider, unit, credits_per_unit, min_credits, min_seconds, max_seconds, notes) values
  ('hf.video', 'Vídeo com movimento GRÁTIS (Wan 2.2, GPU do Hugging Face)', 'hf', 'request', 0, 0, null, null, 'Grátis, com cota diária de GPU do Hugging Face.'),
  ('hf.animate', 'Troca de personagem GRÁTIS (Wan 2.2 Animate, GPU do Hugging Face)', 'hf', 'second', 0, 0, 2, 8, 'Grátis. Cada segundo gasta ~1 min da cota diária de GPU; trechos curtos.'),
  ('hf.talk', 'Personagem falando GRÁTIS (GPU do Hugging Face)', 'hf', 'second', 0, 0, 1, 15, 'Grátis e experimental, com cota diária de GPU.'),
  ('pollinations.wan-2.2-fast', 'Vídeo com movimento 480p (Wan 2.2 via Pollinations, ~5 s)', 'pollinations', 'request', 5, 5, null, null, 'Pollinations: ~US$ 0,05 por vídeo de 5 s. Conferir em enter.pollinations.ai.'),
  ('media.motion', 'Modelo animado (HyperFrames)', 'motion', 'request', 0, 0, null, null, 'Roda no nosso servidor.')
on conflict (key) do nothing;

insert into public.app_settings (key, value, description) values
  ('hf_space_video', '{"space": "zerogpu-aoti/wan2-2-fp8da-aoti-faster", "api": "generate_video"}', 'Space do Hugging Face para vídeo com movimento grátis (imagem → vídeo)'),
  ('hf_space_animate', '{"space": "alexnasa/Wan2.2-Animate-ZEROGPU", "api": "animate_scene"}', 'Space do Hugging Face para troca de personagem grátis (Wan 2.2 Animate)'),
  ('hf_space_talk', '{"space": "apexstudio/infinitetalk", "api": null}', 'Space do Hugging Face para personagem falando grátis (imagem + áudio). api null = detectar sozinho')
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
  if p_kind = 'media.motion' then
    v_provider := 'motion';
    v_lines := array[array['media.motion', '1']];
  elsif p_kind like 'media.%' then
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
  elsif p_kind = 'ai.video' and p_params ->> 'engine' = 'hf' then
    v_provider := 'hf';
    v_lines := array[array['hf.video', '1']];
  elsif p_kind = 'ai.video' and p_params ->> 'engine' = 'pollinations' then
    v_provider := 'pollinations';
    v_lines := array[array['pollinations.wan-2.2-fast', '1']];
  elsif p_kind = 'ai.talk' and p_params ->> 'engine' = 'hf' then
    v_provider := 'hf';
    v_lines := array[array['hf.talk', public.job_duration(p_params, p_input_asset_ids)::text]];
  elsif p_kind = 'ai.transform' and p_params ->> 'engine' = 'hf' then
    v_provider := 'hf';
    v_seconds := public.job_duration(p_params, p_input_asset_ids);
    if v_mode in ('full_body', 'cinematic') then
      v_lines := array[array['hf.animate', v_seconds::text]];
    else
      v_errors := v_errors || to_jsonb('Este modo não está disponível no motor grátis (Hugging Face)'::text);
    end if;
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
     or (p_kind = 'media.motion' and (v_videos > 0
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'image') > 20
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind = 'audio') > 1
         or (select count(*) from unnest(p_input_asset_ids) u(id) join public.assets a on a.id = u.id and a.kind not in ('image', 'audio')) > 0))
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
