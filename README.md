# VideoAI Studio

Plataforma web para criar personagens digitais originais, gerar vídeos por texto e imagem, transformar vídeos autorizados com esses personagens e preparar conteúdo para TikTok, Reels e Shorts. Interface em português, responsiva, tema escuro. Domínio: **iamarx.com.br**.

> Estado atual: MVP com processamento **real** (FFmpeg local + Runway + Claude). As integrações de IA ficam ativas assim que as chaves forem configuradas no worker; o que ainda não tem integração aparece **bloqueado** na interface e não consome créditos. Veja [docs/STATUS.md](docs/STATUS.md).

## Arquitetura em uma imagem

```
Navegador (React/Vite, Cloudflare Pages — iamarx.com.br)
   │  login, dados e arquivos — sempre com RLS (anon key pública)
   ▼
Supabase: Auth · PostgreSQL (regras de crédito em SQL) · Storage privado
   ▲  fila de tarefas (jobs) — service_role, só no servidor
   │
Worker Node.js + FFmpeg (Docker: Fly.io, Railway, Render ou VPS)
   ├─ FFmpeg: validação, cortes, conversão, montagem, legendas, pausas
   ├─ Runway API: imagens, vídeo, Act-Two, Aleph, voz
   └─ Claude API: roteiros, ganchos, legendas, divisão em cenas
```

## Começo rápido

```bash
npm install && npm --prefix worker install
cp .env.example .env.local            # URL e anon key do Supabase
cp worker/.env.example worker/.env    # service role + chaves de IA (opcionais)
npm run dev                           # site em http://localhost:5173
npm --prefix worker run dev           # worker (precisa de ffmpeg instalado)
```

Passo a passo completo (Supabase, domínio, worker, variáveis): [docs/DEPLOY.md](docs/DEPLOY.md).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` / `npm run build` | site em desenvolvimento / build de produção |
| `npm run lint` · `npm run typecheck` | ESLint e TypeScript |
| `npm test` | testes das regras compartilhadas (prompts, legendas, FFmpeg, modos) |
| `npm run test:db` | aplica todas as migrações num PostgreSQL limpo e testa RLS, créditos e fila |
| `npm run test:worker` | testes do worker, incluindo FFmpeg real e adaptador Runway |
| `npm run check` | tudo acima |

## Documentação

- [docs/PLANO_TECNICO.md](docs/PLANO_TECNICO.md) — plano técnico: recursos nativos, integrações, limites e custos
- [docs/DEPLOY.md](docs/DEPLOY.md) — configuração e publicação (variáveis de ambiente, domínio)
- [docs/BANCO.md](docs/BANCO.md) — esquema do banco e regras de créditos
- [docs/SEGURANCA.md](docs/SEGURANCA.md) — segurança, privacidade, direitos e LGPD
- [docs/STATUS.md](docs/STATUS.md) — o que está pronto, o que está pendente
- [docs/TESTES.md](docs/TESTES.md) — testes executados

## Estrutura

```
src/          site (React + TypeScript + Tailwind)
shared/       regras puras usadas pelo site e pelo worker (prompts, FFmpeg, modos, legendas)
worker/       processamento assíncrono (Node + FFmpeg + SDKs oficiais da Runway e Anthropic)
supabase/     migrações SQL (fonte da verdade do esquema) e testes do banco
scripts/      utilitários (teste do banco)
```
