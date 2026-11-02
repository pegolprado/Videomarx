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

-- cofre de chaves
begin;
do $$
declare v_admin uuid := tests.create_user('cofre-admin@teste.com'); v_user uuid := tests.create_user('cofre-user@teste.com');
begin
  update public.profiles set role = 'admin' where id = v_admin;
  perform tests.login(v_admin);
  perform public.admin_set_secret('GEMINI_API_KEY', 'AIzaSy-chave-secreta-1234');
  perform tests.assert_eq((select hint from public.admin_list_secrets() where name = 'GEMINI_API_KEY'), '…1234', 'admin só vê o final da chave');
  perform tests.assert_fails($q$select * from public.provider_secrets$q$, 'nem o admin lê o valor direto');
  perform tests.assert_fails($q$select public.admin_set_secret('OUTRA_COISA', 'xxxxxxxxxx')$q$, 'só nomes conhecidos');
  perform public.admin_set_secret('GEMINI_API_KEY', '');
  perform tests.assert_eq((select count(*)::int from public.admin_list_secrets()), 0, 'apagar com valor vazio');
  perform tests.logout();
  perform tests.login(v_user);
  perform tests.assert_fails($q$select public.admin_set_secret('GEMINI_API_KEY', 'xxxxxxxxxx')$q$, 'usuário comum não grava chaves');
  perform tests.assert_fails($q$select * from public.admin_list_secrets()$q$, 'usuário comum não lista chaves');
  perform tests.logout();
  perform tests.assert((select count(*) = 0 from public.audit_log where data::text like '%chave-secreta%'), 'valor nunca vai para a auditoria');
  raise notice 'cofre ok';
end $$;
rollback;

-- opções grátis e vídeo animado
begin;
do $$
declare
  v_u uuid := tests.create_user('gratis@teste.com');
  v_img1 uuid := gen_random_uuid(); v_img2 uuid := gen_random_uuid(); v_aud uuid := gen_random_uuid();
  v_video uuid := tests.make_video(v_u, 5);
  v_est jsonb;
begin
  insert into public.assets (id, user_id, kind, category, path, probe_status) values
    (v_img1, v_u, 'image', 'generated', v_u || '/g/1.png', 'ok'), (v_img2, v_u, 'image', 'generated', v_u || '/g/2.png', 'ok'),
    (v_aud, v_u, 'audio', 'generated', v_u || '/g/a.mp3', 'ok');
  perform tests.login(v_u);
  v_est := public.estimate_job('ai.text', '{"engine":"gemini","task":"split_script"}', '{}');
  perform tests.assert_eq(v_est ->> 'provider', 'gemini', 'texto pelo Gemini');
  perform tests.assert_eq((v_est ->> 'credits')::int, 0, 'Gemini grátis');
  v_est := public.estimate_job('ai.image', '{"engine":"cloudflare","prompt":"x"}', '{}');
  perform tests.assert_eq(v_est ->> 'provider', 'cloudflare', 'imagem pela Cloudflare');
  perform tests.assert_eq((v_est ->> 'credits')::int, 0, 'Cloudflare grátis');
  v_est := public.estimate_job('ai.text', '{"task":"split_script"}', '{}');
  perform tests.assert_eq(v_est ->> 'provider', 'anthropic', 'padrão continua Claude');
  perform public.create_job('media.slideshow', '{"aspect":"9:16"}', array[v_img1, v_img2, v_aud], null, 'slide-0000001', 0);
  perform tests.assert_fails(format($q$select public.create_job('media.slideshow', '{}', array[%L, %L]::uuid[], null, 'slide-0000002', 0)$q$, v_img1, v_video), 'vídeo animado não aceita vídeo');
  perform tests.assert_fails(format($q$select public.create_job('media.slideshow', '{}', array[%L]::uuid[], null, 'slide-0000003', 0)$q$, v_aud), 'precisa de imagem');
  perform tests.assert_fails(format($q$select public.create_job('media.slideshow', '{}', array[%L, %L, %L]::uuid[], null, 'slide-0000004', 0)$q$, v_img1, v_aud, v_aud), 'no máximo um áudio');
  perform tests.logout();
  raise notice 'opções grátis ok';
end $$;
rollback;
