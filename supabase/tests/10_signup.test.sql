begin;
do $$
declare v_u uuid; v_acc public.credit_accounts;
begin
  v_u := tests.create_user('ana@teste.com');
  perform tests.assert((select terms_accepted_at is not null from public.profiles where id = v_u), 'aceite de termos registrado');
  perform tests.assert_eq((select plan_id from public.profiles where id = v_u), 'free', 'plano gratuito por padrão');
  perform tests.assert_eq((select role from public.profiles where id = v_u), 'user', 'papel padrão é user');
  select * into v_acc from public.credit_accounts where user_id = v_u;
  perform tests.assert_eq(v_acc.available, 50, 'bônus de cadastro');
  perform tests.assert_eq(v_acc.reserved, 0, 'nada reservado');
  perform tests.assert_eq((select sum(delta)::int from public.credit_ledger where user_id = v_u), 50, 'extrato com o bônus');
  raise notice 'cadastro ok';
end $$;
rollback;

begin;
do $$
declare v_admin uuid; v_user uuid;
begin
  v_admin := tests.create_user('marcospr4do@gmail.com');
  v_user := tests.create_user('outra@teste.com');
  perform tests.assert_eq((select role from public.profiles where id = v_admin), 'admin', 'e-mail configurado vira admin');
  perform tests.assert_eq((select role from public.profiles where id = v_user), 'user', 'demais e-mails continuam usuários');
  perform tests.assert_eq((select value::text from public.app_settings where key = 'max_upload_mb'), '50', 'limite do plano gratuito do Supabase');
  raise notice 'admin automático ok';
end $$;
rollback;
