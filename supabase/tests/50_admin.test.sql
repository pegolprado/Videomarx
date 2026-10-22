begin;
do $$
declare
  v_admin uuid := tests.create_user('admin@teste.com');
  v_u uuid := tests.create_user('cliente@teste.com');
  v_over jsonb;
begin
  update public.profiles set role = 'admin' where id = v_admin;
  perform tests.login(v_admin);
  perform public.admin_adjust_credits(v_u, 100, 'Cortesia');
  perform tests.assert_eq((select available from public.credit_accounts where user_id = v_u), 150, 'créditos adicionados');
  perform tests.assert_fails(format($q$select public.admin_adjust_credits(%L, -1000, 'x')$q$, v_u), 'saldo não fica negativo');
  perform public.admin_update_user(v_u, 'user', 'pro', false);
  perform tests.assert_eq((select plan_id from public.profiles where id = v_u), 'pro', 'plano alterado');
  perform tests.assert_fails(format($q$select public.admin_update_user(%L, 'user', null, null)$q$, v_admin), 'admin não remove o próprio acesso');
  perform public.admin_set_integration('anthropic', false);
  perform public.admin_set_setting('monthly_budget_usd', '250');
  perform public.admin_set_price('runway.act_two', 6, 18, 30, true);
  v_over := public.admin_overview();
  perform tests.assert_eq((v_over ->> 'users')::int, 2, 'visão geral conta usuários');
  perform tests.assert((select count(*) >= 5 from public.audit_log), 'ações administrativas auditadas');
  perform tests.assert_eq((select count(*)::int from public.profiles), 2, 'admin vê todos os perfis');
  perform tests.logout();
  raise notice 'admin ok';
end $$;
rollback;
