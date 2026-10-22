begin;
do $$
declare
  v_u uuid := tests.create_user('w@teste.com');
  v_video uuid := tests.make_video(v_u, 6);
  v_job public.jobs;
  v_claimed public.jobs;
  v_caps jsonb;
begin
  perform tests.login(v_u);
  v_job := public.create_job('ai.transform', '{"mode":"full_body","rights_confirmed":true}', array[v_video], null, 'worker-job-01', 1000);
  perform tests.logout();

  select * into v_claimed from public.worker_claim_jobs('w1', 5, array['ai.transform']);
  perform tests.assert_eq(v_claimed.id, v_job.id, 'worker pega a tarefa');
  perform tests.assert_eq(v_claimed.attempts, 1, 'primeira tentativa');
  perform tests.assert((select count(*) = 0 from public.worker_claim_jobs('w2', 5, array['ai.transform'])), 'outro worker não pega a mesma tarefa');

  -- progresso registra a tarefa externa (retomada sem recriar)
  v_claimed := public.worker_progress(v_job.id, 'w1', 0.4, '{"stage":"act_two"}', 'rw-task-1', 'Enviado ao provedor');
  perform tests.assert_eq(v_claimed.provider_task_ids, array['rw-task-1'], 'id externo salvo');
  v_claimed := public.worker_progress(v_job.id, 'w1', 0.5, null, 'rw-task-1', null);
  perform tests.assert_eq(cardinality(v_claimed.provider_task_ids), 1, 'id externo não duplica');
  perform tests.assert_fails(format($q$select public.worker_progress(%L, 'w2', 0.1, null, null, null)$q$, v_job.id), 'outro worker não atualiza');

  -- worker caiu: trava expira e a tarefa é retomada com o estado salvo
  update public.jobs set locked_at = now() - interval '11 minutes' where id = v_job.id;
  select * into v_claimed from public.worker_claim_jobs('w2', 5, array['ai.transform']);
  perform tests.assert_eq(v_claimed.locked_by, 'w2', 'retomada por outro worker');
  perform tests.assert_eq(v_claimed.state ->> 'stage', 'act_two', 'estado preservado');
  perform tests.assert_eq(v_claimed.provider_task_ids, array['rw-task-1'], 'tarefa externa preservada');

  -- falha temporária: volta para "aguardando" com espera
  v_claimed := public.worker_requeue(v_job.id, 'w2', 30, 'HTTP 503');
  perform tests.assert_eq(v_claimed.status, 'waiting', 'aguardando nova tentativa');
  perform tests.assert((select count(*) = 0 from public.worker_claim_jobs('w1', 5, array['ai.transform'])), 'respeita o tempo de espera');
  update public.jobs set next_attempt_at = now() where id = v_job.id;
  select * into v_claimed from public.worker_claim_jobs('w1', 5, array['ai.transform']);
  perform tests.assert_eq(v_claimed.attempts, 3, 'terceira tentativa');
  -- esgotou as tentativas: falha com reembolso
  v_claimed := public.worker_requeue(v_job.id, 'w1', 30, 'HTTP 503');
  perform tests.assert_eq(v_claimed.status, 'failed', 'falha após o limite de tentativas');
  perform tests.assert_eq(v_claimed.charged_credits, 0, 'reembolsada');
  perform tests.assert_eq((select reserved from public.credit_accounts where user_id = v_u), 0, 'nada preso em reserva');

  -- capacidades refletem workers online e o que o admin habilitou
  perform public.worker_heartbeat('w1', '1.0.0', '{"ffmpeg":true,"runway":true,"anthropic":false}');
  perform tests.login(v_u);
  v_caps := public.platform_capabilities();
  perform tests.assert((v_caps ->> 'worker_online')::boolean, 'worker online');
  perform tests.assert((v_caps -> 'integrations' -> 'runway' ->> 'configured')::boolean, 'runway configurada');
  perform tests.assert(not (v_caps -> 'integrations' -> 'anthropic' ->> 'configured')::boolean, 'anthropic pendente');
  perform tests.logout();
  update public.worker_status set last_seen = now() - interval '5 minutes';
  perform tests.login(v_u);
  v_caps := public.platform_capabilities();
  perform tests.assert(not (v_caps ->> 'worker_online')::boolean, 'worker parado aparece offline');
  perform tests.logout();
  raise notice 'worker ok';
end $$;
rollback;
