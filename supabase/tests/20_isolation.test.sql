begin;
do $$
declare
  v_a uuid := tests.create_user('a@teste.com');
  v_b uuid := tests.create_user('b@teste.com');
  v_char uuid;
  v_video uuid := tests.make_video(v_a, 8);
  v_job public.jobs;
begin
  perform tests.login(v_a);
  insert into public.characters (name, description) values ('Luna', 'Exploradora') returning id into v_char;
  v_job := public.create_job('media.trim', '{"trim_start":0,"trim_end":4}', array[v_video], null, 'trim-key-0001', 1);
  perform tests.logout();

  perform tests.login(v_b);
  perform tests.assert_eq((select count(*)::int from public.characters), 0, 'B não vê personagens de A');
  perform tests.assert_eq((select count(*)::int from public.assets), 0, 'B não vê arquivos de A');
  perform tests.assert_eq((select count(*)::int from public.jobs), 0, 'B não vê tarefas de A');
  perform tests.assert_eq((select count(*)::int from public.credit_ledger), 1, 'B só vê o próprio extrato');
  perform tests.assert_eq((select count(*)::int from public.profiles), 1, 'B só vê o próprio perfil');
  update public.characters set name = 'hack' where id = v_char;
  perform tests.assert(not found, 'B não altera personagem de A');
  delete from public.assets where id = v_video;
  perform tests.assert(not found, 'B não apaga arquivo de A');
  perform tests.assert_fails(format($q$insert into public.assets (user_id, kind, category, path) values (%L, 'video', 'original', %L)$q$, v_a, v_a || '/x.mp4'), 'B não cria arquivo em nome de A');
  perform tests.assert_fails(format($q$insert into public.assets (kind, category, path) values ('video', 'original', %L)$q$, v_a || '/x.mp4'), 'B não grava na pasta de A');
  perform tests.assert_fails(format($q$select public.create_job('media.trim', '{}', array[%L]::uuid[], null, 'steal-key-001', 10)$q$, v_video), 'B não processa arquivo de A');
  perform tests.assert_fails(format($q$select public.cancel_job(%L)$q$, v_job.id), 'B não cancela tarefa de A');
  perform tests.assert_fails(format($q$insert into public.characters (name, primary_image_id) values ('x', %L)$q$, v_video), 'B não usa imagem de A no personagem');
  perform tests.assert_fails($q$select public.create_job('media.trim', '{}', array[]::uuid[], null, 'trim-nofile-1', 10)$q$, 'corte exige um vídeo de entrada');
  perform tests.assert_fails($q$update public.profiles set role = 'admin' where id = auth.uid()$q$, 'usuário não se promove a admin');
  perform tests.assert_fails($q$update public.profiles set plan_id = 'pro' where id = auth.uid()$q$, 'usuário não troca de plano sozinho');
  perform tests.assert_fails($q$select public.admin_adjust_credits(auth.uid(), 1000, 'x')$q$, 'usuário comum não ajusta créditos');
  perform tests.assert_fails($q$select public.admin_overview()$q$, 'usuário comum não vê visão admin');
  perform tests.assert_fails($q$select * from public.worker_claim_jobs('w', 10, array['media.trim'])$q$, 'usuário não chama API do worker');
  perform tests.assert_fails(format($q$select public._settle_job(%L, 'succeeded', null, null, null, null, null, null)$q$, v_job.id), 'usuário não liquida tarefas');
  perform tests.assert_fails($q$insert into public.credit_ledger (user_id, delta, kind) values (auth.uid(), 999, 'grant')$q$, 'usuário não escreve no extrato');
  perform tests.assert_fails($q$update public.credit_accounts set available = 99999$q$, 'usuário não altera saldo');
  -- metadados técnicos não podem ser forjados no envio
  insert into public.assets (kind, category, path, duration_s, probe_status) values ('video', 'original', v_b || '/up/x.mp4', 1, 'ok');
  perform tests.assert_eq((select probe_status from public.assets where path = v_b || '/up/x.mp4'), 'pending', 'probe_status forçado a pending');
  perform tests.assert((select duration_s is null from public.assets where path = v_b || '/up/x.mp4'), 'duração só vem do processamento');
  perform tests.assert_fails($q$insert into public.assets (kind, category, path) values ('video', 'generated', auth.uid() || '/y.mp4')$q$, 'usuário não cria arquivo "gerado por IA"');
  perform tests.logout();
  raise notice 'isolamento ok';
end $$;

-- storage: cada um na sua pasta
do $$
declare v_a uuid := tests.create_user('c@teste.com'); v_b uuid := tests.create_user('d@teste.com');
begin
  perform tests.login(v_a);
  insert into storage.objects (bucket_id, name) values ('media', v_a || '/uploads/a.mp4');
  perform tests.assert_fails(format($q$insert into storage.objects (bucket_id, name) values ('media', %L)$q$, v_b || '/uploads/a.mp4'), 'não envia para pasta alheia');
  perform tests.logout();
  perform tests.login(v_b);
  perform tests.assert_eq((select count(*)::int from storage.objects where bucket_id = 'media'), 0, 'não lista arquivos alheios');
  perform tests.logout();
  raise notice 'storage ok';
end $$;
rollback;
