# Configuração e publicação

Você vai precisar de: conta no **Supabase**, conta no **Cloudflare** (onde o domínio `iamarx.com.br` será apontado), um lugar para rodar o **worker** (Docker) e, para as funções de IA, chaves da **Runway** (dev.runwayml.com) e da **Anthropic** (console.anthropic.com).

## 1. Supabase

1. Crie um projeto (região São Paulo, `sa-east-1`).
2. Aplique as migrações: `npx supabase link --project-ref SEU_REF && npx supabase db push` — ou cole os arquivos de `supabase/migrations/` em ordem no SQL Editor.
3. **Authentication → URL Configuration**: Site URL `https://iamarx.com.br`; Redirect URLs `https://iamarx.com.br/**` e `http://localhost:5173/**`.
4. **Authentication → Providers → Email**: confirmação de e-mail ligada. Para produção configure SMTP próprio (o envio padrão do Supabase é limitado).
5. **Storage**: o bucket privado `media` é criado pela migração. No plano Free o limite por arquivo é 50 MB — ajuste `max_upload_mb` no painel admin para ≤ 50, ou use o plano Pro.
6. Torne-se administrador (uma vez, no SQL Editor, depois de criar sua conta pelo site):
   ```sql
   update public.profiles set role = 'admin' where email = 'seu@email.com';
   ```

## 2. Variáveis de ambiente

### Site (públicas — vão para o navegador)
| Variável | Exemplo |
|---|---|
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon key (Settings → API) |
| `VITE_SITE_URL` | `https://iamarx.com.br` |

### Worker (SECRETAS — só no servidor, nunca no site)
| Variável | Obrigatória | Para quê |
|---|---|---|
| `SUPABASE_URL` | sim | mesmo URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | acesso à fila e ao Storage |
| `RUNWAYML_API_SECRET` | não | imagens, vídeo, transformação, voz |
| `ANTHROPIC_API_KEY` | não | roteiros e textos |
| `ANTHROPIC_MODEL` | não | padrão `claude-opus-5-5` |
| `WORKER_CONCURRENCY` | não | tarefas simultâneas (padrão 2) |

Sem uma chave, a integração correspondente aparece como **pendente** no site e as funções dela ficam bloqueadas.

## 3. Site no Cloudflare Pages com iamarx.com.br

1. Cloudflare → Workers & Pages → Create → Pages → conectar ao GitHub `pegolprado/Videomarx`.
2. Build command `npm run build`, output `dist`, variável `NODE_VERSION=22` e as três variáveis `VITE_*`.
3. Custom domains → adicionar `iamarx.com.br` (e `www.iamarx.com.br`). Se o domínio está registrado no Registro.br, troque os servidores DNS para os do Cloudflare (o painel mostra quais) ou crie um CNAME conforme indicado.
4. `public/_redirects` já faz o roteamento SPA e `public/_headers` aplica cabeçalhos de segurança (CSP restrita ao Supabase).

Alternativa via GitHub Actions: configure em *Settings → Secrets and variables → Actions* os segredos `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` e as variáveis `SUPABASE_PROJECT_REF`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `CLOUDFLARE_PROJECT`. O workflow `Deploy` publica a cada push na `main` com CI verde.

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
