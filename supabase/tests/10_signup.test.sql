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
