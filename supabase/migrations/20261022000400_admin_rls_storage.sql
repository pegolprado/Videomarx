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
