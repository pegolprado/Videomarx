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
