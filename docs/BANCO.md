# Esquema do banco

Fonte da verdade: `supabase/migrations/*.sql`. Todas as tabelas têm RLS.

| Tabela | Conteúdo | Acesso |
|---|---|---|
| `profiles` | usuário, papel (`user`/`admin`), plano, aceite de termos, suspensão | dono lê/edita nome; admin via funções |
| `plans` | limites por plano (projetos, personagens, upload, duração, créditos/tarefa/dia) | todos leem; admin edita |
| `subscriptions` | estrutura para assinaturas (pagamentos ainda não implementados) | dono lê |
| `characters` | personagem, aparência, voz, imagem principal, versões (`parent_id`) | só o dono |
| `assets` | arquivos (vídeo, imagem, áudio, legenda) com metadados técnicos e marca de conteúdo sintético | só o dono; metadados só pelo worker |
| `projects` | projetos (cenas, linha do tempo) | só o dono |
| `scripts` | roteiros gerados | só o dono |
| `jobs` / `job_events` | tarefas assíncronas, estado, custo estimado/real, ids externos, erros | dono lê; escrita só por funções |
| `credit_accounts` / `credit_ledger` | saldo disponível/reservado e extrato | dono lê; escrita só por funções |
| `price_catalog` | preços em créditos por modelo/unidade e limites de duração | todos leem; admin edita |
| `integrations` / `worker_status` | integrações habilitadas e capacidades de cada worker | — |
| `app_settings` | configurações (orçamento, reembolso, limites) | admin edita |
| `audit_log` | ações administrativas | admin lê |

## Fluxo de créditos

1. `estimate_job(kind, params, inputs)` calcula o custo a partir do catálogo (e da duração real do arquivo, lida pelo worker).
2. `create_job(..., idempotency_key, confirmed_credits)` valida dono dos arquivos, direitos (transformação), limites do plano, orçamento da plataforma e se a estimativa não subiu; **reserva** os créditos e enfileira. A mesma chave devolve a mesma tarefa (sem cobrança dupla).
3. O worker pega a tarefa (`worker_claim_jobs`), salva progresso e ids externos (`worker_progress`), reenfileira falhas temporárias com espera (`worker_requeue`) e liquida (`worker_finish`).
4. A liquidação acontece uma única vez: cobra `min(estimativa, custo real convertido)`, devolve a diferença; falhas são reembolsadas conforme `refund_failed_full`.
