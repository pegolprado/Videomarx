# Configuração e publicação

Você vai precisar de: conta no **Supabase**, conta no **Cloudflare** (onde o domínio `iamarx.com.br` será apontado), um lugar para rodar o **worker** (Docker) e, para as funções de IA, chaves da **Runway** (dev.runwayml.com) e da **Anthropic** (console.anthropic.com).

## 1. Supabase

1. Crie um projeto **novo** (não reaproveite o do ATLAS), região São Paulo.
2. SQL Editor → New query → cole **todo** o conteúdo de `supabase/setup.sql` → Run. (Equivale a aplicar `supabase/migrations/` em ordem.) Em um banco já instalado, rode só as migrações novas, em ordem (a mais recente: `20261106001000_free_gpu.sql`).
3. Authentication → URL Configuration: Site URL `https://video.iamarx.com.br`; Redirect URLs `https://video.iamarx.com.br/**` e o endereço `*.workers.dev` do site.
4. Os e-mails em `admin_emails` (Admin → Configurações) viram administradores automaticamente no cadastro.
5. Plano Free: arquivos de até 50 MB (já configurado). No plano Pro, aumente `max_upload_mb` e o limite do bucket `media`.

## 2. Variáveis de ambiente

### Site (públicas)
`VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` ficam no arquivo `.env.production` do repositório (são públicas; a segurança vem do RLS). `VITE_SITE_URL` é opcional (padrão: o próprio endereço do site).

### Worker (SECRETAS — só no servidor, nunca no site)
| Variável | Obrigatória | Para quê |
|---|---|---|
| `SUPABASE_URL` | sim | mesmo URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | acesso à fila e ao Storage |
| `RUNWAYML_API_SECRET` | não | imagens, vídeo, transformação, voz |
| `ANTHROPIC_API_KEY` | não | roteiros e textos |
| `ANTHROPIC_MODEL` | não | padrão `claude-opus-5-5` |
| `WORKER_CONCURRENCY` | não | tarefas simultâneas (padrão 2) |

## 3. Site no Cloudflare (Workers) em video.iamarx.com.br

O ATLAS continua em `iamarx.com.br`; o VideoAI Studio usa o subdomínio `video.iamarx.com.br`.

1. Workers & Pages → Create → Import a repository → `pegolprado/Videomarx`. O nome do Worker precisa ser `videomarx` (igual ao `name` de `wrangler.jsonc`).
2. Build command: deixe vazio. Deploy command: `npx wrangler deploy`. O `wrangler.jsonc` já instala, compila (`npm ci && npm run build`) e publica `dist` com roteamento de SPA; `public/_headers` aplica os cabeçalhos de segurança.
3. Settings → Domains & Routes → Add → Custom domain → `video.iamarx.com.br`. Não altere os registros DNS do domínio principal (ATLAS).

## 4. Worker

A imagem é publicada pelo workflow `Deploy` em `ghcr.io/pegolprado/videoai-worker:latest`, ou construa localmente:

```bash
docker build -f worker/Dockerfile -t videoai-worker .
docker run --env-file worker/.env videoai-worker
```

Exemplo Fly.io: `fly launch --dockerfile worker/Dockerfile --no-deploy`, `fly secrets set SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… RUNWAYML_API_SECRET=… ANTHROPIC_API_KEY=…`, `fly deploy`. Use ao menos 1 GB de RAM. O worker não expõe portas: ele só faz conexões de saída.

Para conferir: no site, **Integrações** deve mostrar o servidor online e as integrações ativas; no painel **Administração → Visão geral** aparece o worker com suas capacidades.

## 5. Primeiros testes com IA real (recomendado antes de abrir ao público)

1. Ajuste a **tabela de preços** (Admin → Preços) com os valores atuais da Runway/Anthropic.
2. Defina `monthly_budget_usd` baixo (ex.: 10) em Admin → Configurações.
3. Teste em ordem: imagem de personagem → vídeo de 5 s → transformação Modo C com trecho de 3 s → voz → roteiro.
4. Confira em Admin → Tarefas o custo real (`USD`) de cada tarefa comparado à estimativa.

## 6. Atualizações

Migrações são sempre aditivas e aplicadas antes do site. Publicar = push na `main`. Reverter o site = "Rollback" no Cloudflare Pages. O worker pode ser atualizado a qualquer momento: tarefas em andamento na Runway são retomadas pelo id salvo, sem nova cobrança.
