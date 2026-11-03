begin;
do $$
declare
  v_u uuid := tests.create_user('cred@teste.com');
  v_video uuid := tests.make_video(v_u, 6);
  v_long uuid := tests.make_video(v_u, 40);
  v_norights uuid := tests.make_video(v_u, 6, false);
  v_est jsonb;
  v_job public.jobs;
  v_job2 public.jobs;
  v_acc public.credit_accounts;
begin
  update public.credit_accounts set available = 500 where user_id = v_u;
  update public.app_settings set value = '0' where key = 'monthly_budget_usd';
  update public.price_catalog set credits_per_unit = 5, min_credits = 15 where key = 'runway.act_two';
  perform tests.login(v_u);

  -- estimativa: Act-Two 6 s × 5 = 30
  v_est := public.estimate_job('ai.transform', '{"mode":"full_body"}', array[v_video]);
  perform tests.assert_eq((v_est ->> 'credits')::int, 30, 'estimativa Act-Two');
  perform tests.assert_eq(jsonb_array_length(v_est -> 'errors'), 0, 'sem erros');
  -- trecho de 1 s: abaixo do mínimo do Act-Two
  v_est := public.estimate_job('ai.transform', '{"mode":"full_body","trim_start":2,"trim_end":3}', array[v_video]);
  perform tests.assert(jsonb_array_length(v_est -> 'errors') > 0, 'mínimo de 3 s respeitado');
  -- modo sem integração
  v_est := public.estimate_job('ai.transform', '{"mode":"face_swap"}', array[v_video]);
  perform tests.assert(jsonb_array_length(v_est -> 'errors') > 0, 'troca de rosto indisponível sem integração');
  -- recriação = imagem (8) + act-two (30)
  v_est := public.estimate_job('ai.transform', '{"mode":"cinematic"}', array[v_video]);
  perform tests.assert_eq((v_est ->> 'credits')::int, 38, 'recriação cinematográfica soma imagem + vídeo');

  -- exige confirmação de direitos
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body"}', array[%L]::uuid[], null, 'no-rights-0001', 100)$q$, v_video), 'sem rights_confirmed');
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'no-rights-0002', 100)$q$, v_norights), 'arquivo sem confirmação de direitos');
  -- exige ter visto a estimativa
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'low-confirm-01', 10)$q$, v_video), 'estimativa maior que a confirmada');
  -- limite de duração do plano gratuito (15 s)
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'too-long-0001', 1000)$q$, v_long), 'duração acima do plano');

  v_job := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'transform-0001', 30);
  perform tests.assert_eq(v_job.status, 'queued', 'tarefa na fila');
  perform tests.assert_eq(v_job.estimated_credits, 30, 'reserva = estimativa');
  select * into v_acc from public.credit_accounts where user_id = v_u;
  perform tests.assert_eq(v_acc.available, 470, 'disponível reduzido');
  perform tests.assert_eq(v_acc.reserved, 30, 'reservado');

  -- repetir a requisição (duplo clique / reenvio) não cobra de novo
  v_job2 := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'transform-0001', 30);
  perform tests.assert_eq(v_job2.id, v_job.id, 'idempotência devolve a mesma tarefa');
  perform tests.assert_eq((select available from public.credit_accounts where user_id = v_u), 470, 'sem cobrança dupla');

  -- cancelar na fila devolve tudo
  v_job2 := public.create_job('media.trim', '{"trim_start":0,"trim_end":3}', array[v_video], null, 'trim-cancel-01', 1);
  v_job2 := public.cancel_job(v_job2.id);
  perform tests.assert_eq(v_job2.status, 'canceled', 'cancelada');
  perform tests.assert_eq(v_job2.charged_credits, 0, 'nada cobrado no cancelamento');
  perform tests.assert_eq((select available from public.credit_accounts where user_id = v_u), 470, 'reserva devolvida');
  perform tests.logout();

  -- liquidação com custo real menor: cobra o real e devolve a diferença
  update public.app_settings set value = '0.01' where key = 'credit_value_usd';
  update public.app_settings set value = '1.0' where key = 'provider_markup';
  update public.jobs set status = 'processing', locked_by = 'w1' where id = v_job.id;
  v_job := public.worker_finish(v_job.id, 'w1', 'succeeded', 0.25, '{"runway_credits":25}', null, null, null, null);
  perform tests.assert_eq(v_job.charged_credits, 25, 'cobra o custo real');
  select * into v_acc from public.credit_accounts where user_id = v_u;
  perform tests.assert_eq(v_acc.available, 475, 'diferença devolvida');
  perform tests.assert_eq(v_acc.reserved, 0, 'reserva liberada');
  -- liquidar de novo não muda nada
  v_job := public.worker_finish(v_job.id, 'w1', 'failed', 0.25, null, null, null, 'x', 'x');
  perform tests.assert_eq(v_job.status, 'succeeded', 'estado final não muda');
  perform tests.assert_eq((select available from public.credit_accounts where user_id = v_u), 475, 'sem segunda liquidação');
  perform tests.assert_eq((select count(*)::int from public.credit_ledger where job_id = v_job.id and kind = 'refund'), 1, 'um único reembolso');

  -- custo real maior que a estimativa: nunca cobra acima do confirmado
  perform tests.login(v_u);
  v_job := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'transform-0002', 30);
  perform tests.logout();
  update public.jobs set status = 'processing', locked_by = 'w1' where id = v_job.id;
  v_job := public.worker_finish(v_job.id, 'w1', 'succeeded', 9.99, null, null, null, null, null);
  perform tests.assert_eq(v_job.charged_credits, 30, 'teto = estimativa confirmada');

  -- falha: reembolso integral (política padrão)
  perform tests.login(v_u);
  v_job := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'transform-0003', 30);
  perform tests.logout();
  update public.jobs set status = 'processing', locked_by = 'w1' where id = v_job.id;
  v_job := public.worker_finish(v_job.id, 'w1', 'failed', 0.05, null, null, null, 'provider_failed', 'falhou');
  perform tests.assert_eq(v_job.charged_credits, 0, 'falha não é cobrada');
  -- política alternativa: cobra o que o provedor efetivamente cobrou
  update public.app_settings set value = 'false' where key = 'refund_failed_full';
  perform tests.login(v_u);
  v_job := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'transform-0004', 30);
  perform tests.logout();
  update public.jobs set status = 'processing', locked_by = 'w1' where id = v_job.id;
  v_job := public.worker_finish(v_job.id, 'w1', 'failed', 0.05, null, null, null, 'provider_failed', 'falhou');
  perform tests.assert_eq(v_job.charged_credits, 5, 'falha cobra só o custo incorrido');

  -- saldo insuficiente
  update public.credit_accounts set available = 10 where user_id = v_u;
  perform tests.login(v_u);
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'poor-0000001', 30)$q$, v_video), 'créditos insuficientes');
  perform tests.assert_eq((select available from public.credit_accounts where user_id = v_u), 10, 'saldo intacto após recusa');
  perform tests.assert_eq((select count(*)::int from public.jobs where idempotency_key = 'poor-0000001'), 0, 'nenhuma tarefa criada');
  perform tests.logout();

  -- orçamento mensal da plataforma
  update public.credit_accounts set available = 1000 where user_id = v_u;
  update public.app_settings set value = '0.1' where key = 'monthly_budget_usd';
  perform tests.login(v_u);
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'budget-000001', 30)$q$, v_video), 'orçamento mensal');
  perform tests.logout();

  -- integração desabilitada
  update public.app_settings set value = '0' where key = 'monthly_budget_usd';
  update public.integrations set enabled = false where id = 'runway';
  perform tests.login(v_u);
  perform tests.assert_fails(format($q$select public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[%L]::uuid[], null, 'disabled-0001', 30)$q$, v_video), 'integração desabilitada');
  perform tests.logout();
  raise notice 'créditos ok';
end $$;
rollback;

-- montagem com o mesmo clipe repetido: duração e validação contam cada ocorrência
begin;
do $$
declare v_u uuid := tests.create_user('concat@teste.com'); v_a uuid := tests.make_video(v_u, 10); v_est jsonb;
begin
  perform tests.login(v_u);
  v_est := public.estimate_job('media.concat', '{}', array[v_a, v_a]);
  perform tests.assert_eq((v_est -> 'items' -> 0 ->> 'units')::numeric, 20::numeric, 'duração soma as repetições');
  perform public.create_job('media.concat', '{}', array[v_a, v_a], null, 'concat-dup-001', 2);
  perform tests.logout();
  raise notice 'montagem ok';
end $$;
rollback;

-- fal.ai
begin;
do $$
declare
  v_u uuid := tests.create_user('fal@teste.com');
  v_video uuid := tests.make_video(v_u, 6);
  v_img uuid := gen_random_uuid(); v_aud uuid := gen_random_uuid();
  v_est jsonb;
begin
  insert into public.assets (id, user_id, kind, category, path, probe_status, duration_s) values
    (v_img, v_u, 'image', 'generated', v_u || '/g/i.jpg', 'ok', null), (v_aud, v_u, 'audio', 'generated', v_u || '/g/a.mp3', 'ok', 3.2);
  update public.credit_accounts set available = 500 where user_id = v_u;
  update public.app_settings set value = '0' where key = 'monthly_budget_usd';
  perform tests.login(v_u);
  v_est := public.estimate_job('ai.transform', '{"engine":"fal","mode":"full_body","resolution":"720p"}', array[v_video]);
  perform tests.assert_eq(v_est ->> 'provider', 'fal', 'troca de personagem pela fal');
  perform tests.assert_eq((v_est ->> 'credits')::int, 48, '6 s × 8 créditos (720p)');
  v_est := public.estimate_job('ai.transform', '{"engine":"fal","mode":"stylized"}', array[v_video]);
  perform tests.assert(jsonb_array_length(v_est -> 'errors') > 0, 'modo sem suporte na fal');
  v_est := public.estimate_job('ai.video', '{"engine":"fal","resolution":"480p"}', '{}');
  perform tests.assert_eq((v_est ->> 'credits')::int, 5, 'vídeo de 5 s em 480p');
  v_est := public.estimate_job('ai.talk', '{"resolution":"480p"}', array[v_img, v_aud]);
  perform tests.assert_eq((v_est ->> 'credits')::int, 32, '4 s (3,2 arredondado) × 8');
  perform public.create_job('ai.talk', '{"resolution":"480p"}', array[v_img, v_aud], null, 'talk-000001', 32);
  perform tests.assert_fails(format($q$select public.create_job('ai.talk', '{}', array[%L]::uuid[], null, 'talk-000002', 100)$q$, v_img), 'falar exige imagem e áudio');
  perform tests.logout();
  perform tests.assert((select count(*) = 0 from public.provider_secrets), 'cofre vazio');
  insert into public.provider_secrets (name, value) values ('FAL_KEY', 'chave-fal-123456');
  raise notice 'fal ok';
end $$;
rollback;

-- GPU grátis (Hugging Face), Pollinations e modelos animados
begin;
do $$
declare
  v_u uuid := tests.create_user('gratis@teste.com');
  v_video uuid := tests.make_video(v_u, 6);
  v_long uuid := tests.make_video(v_u, 20);
  v_img uuid := gen_random_uuid(); v_aud uuid := gen_random_uuid();
  v_est jsonb;
  v_job public.jobs;
begin
  insert into public.assets (id, user_id, kind, category, path, probe_status, duration_s) values
    (v_img, v_u, 'image', 'generated', v_u || '/g/i.jpg', 'ok', null), (v_aud, v_u, 'audio', 'generated', v_u || '/g/a.mp3', 'ok', 3.2);
  update public.app_settings set value = '0' where key = 'monthly_budget_usd';
  perform tests.login(v_u);
  v_est := public.estimate_job('ai.transform', '{"engine":"hf","mode":"full_body"}', array[v_video]);
  perform tests.assert_eq(v_est ->> 'provider', 'hf', 'troca grátis pelo Hugging Face');
  perform tests.assert_eq((v_est ->> 'credits')::int, 0, 'troca grátis custa 0');
  perform tests.assert_eq(jsonb_array_length(v_est -> 'errors'), 0, 'trecho de 6 s cabe no limite grátis de 8 s');
  v_est := public.estimate_job('ai.transform', '{"engine":"hf","mode":"full_body","trim_start":0,"trim_end":5}', array[v_long]);
  perform tests.assert_eq(jsonb_array_length(v_est -> 'errors'), 0, 'trecho de 5 s aceito no grátis');
  v_est := public.estimate_job('ai.transform', '{"engine":"hf","mode":"full_body"}', array[v_long]);
  perform tests.assert(jsonb_array_length(v_est -> 'errors') > 0, 'trecho de 20 s recusado no grátis');
  v_est := public.estimate_job('ai.transform', '{"engine":"hf","mode":"stylized"}', array[v_video]);
  perform tests.assert(jsonb_array_length(v_est -> 'errors') > 0, 'modo sem suporte no grátis');
  v_est := public.estimate_job('ai.video', '{"engine":"hf"}', '{}');
  perform tests.assert_eq((v_est ->> 'credits')::int, 0, 'vídeo grátis custa 0');
  v_est := public.estimate_job('ai.video', '{"engine":"pollinations"}', '{}');
  perform tests.assert_eq((v_est ->> 'credits')::int, 5, 'Pollinations: 5 créditos por vídeo');
  perform tests.assert_eq(v_est ->> 'provider', 'pollinations', 'provedor pollinations');
  v_est := public.estimate_job('ai.talk', '{"engine":"hf"}', array[v_img, v_aud]);
  perform tests.assert_eq((v_est ->> 'credits')::int, 0, 'falar grátis custa 0');
  v_job := public.create_job('ai.talk', '{"engine":"hf"}', array[v_img, v_aud], null, 'talk-hf-0001', 0);
  perform tests.assert_eq(v_job.provider, 'hf', 'tarefa grátis registrada no hf');
  v_job := public.create_job('media.motion', '{"template":"kinetic"}', array[v_img, v_aud], null, 'motion-00001', 0);
  perform tests.assert_eq(v_job.provider, 'motion', 'modelo animado no servidor');
  perform tests.assert_eq(v_job.estimated_credits, 0, 'modelo animado grátis');
  perform tests.assert_fails(format($q$select public.create_job('media.motion', '{}', array[%L]::uuid[], null, 'motion-00002', 0)$q$, v_video), 'modelo animado não aceita vídeo');
  perform tests.logout();
  insert into public.provider_secrets (name, value) values ('HF_TOKEN', 'hf_123456789'), ('POLLINATIONS_KEY', 'sk_123456789');
  raise notice 'gratis ok';
end $$;
rollback;
