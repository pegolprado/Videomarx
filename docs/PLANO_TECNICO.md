# Plano técnico

## 1. Decisões de plataforma

| Necessidade | Escolha | Motivo |
|---|---|---|
| Interface | React 19 + Vite + Tailwind 4 (site estático) | rápido, barato de hospedar, mesmo stack do seu outro projeto |
| Hospedagem do site | Cloudflare Pages + domínio `iamarx.com.br` | HTTPS e CDN grátis, deploy pelo GitHub |
| Login, banco, arquivos | Supabase (Auth, PostgreSQL, Storage privado) | RLS no banco: cada usuário só acessa os próprios dados |
| Processamento pesado | Worker Node.js + FFmpeg em contêiner Docker | vídeo **nunca** é processado no navegador; escala horizontal |
| Fila de tarefas | tabela `jobs` + `FOR UPDATE SKIP LOCKED` | sem serviço extra; estado sobrevive a quedas |
| IA visual e voz | Runway API (SDK oficial `@runwayml/sdk`) | uma conta cobre imagem, vídeo, transferência de atuação, vídeo→vídeo e voz |
| Textos | Claude (SDK oficial `@anthropic-ai/sdk`, saída estruturada) | roteiros em PT-BR, divisão em cenas, instruções para os modelos |

Nenhum modelo próprio é treinado no MVP.

## 2. Recursos nativos (sem custo de IA)

Feitos com FFmpeg no worker: validação de formato/tamanho/duração, leitura de resolução e proporção, miniaturas e quadros de prévia, extração e preparação de trechos, corte, conversão 9:16/16:9/1:1 (recorte ou barras), 720p/1080p, qualidade econômica/alta, velocidade, volume, fade, ajustes de cor, texto na tela, legenda incorporada (.srt), montagem com transição e trilha, corte automático de pausas (silencedetect). Metadado de conteúdo sintético é gravado no MP4.

## 3. Integrações externas e como cada função é executada

Endpoints e parâmetros foram conferidos contra os tipos do SDK oficial da Runway (v4.22) e o código compila contra eles — nada foi inventado. **Nenhuma chamada real foi testada ainda** (não havia chaves neste ambiente).

| Função | Provedor / modelo | Observações reais |
|---|---|---|
| Imagens do personagem (vistas, poses, cenários, capas) | Runway `text_to_image` — `gen4_image` / `gen4_image_turbo` | até 3 imagens de referência com tag (`@char`) |
| Vídeo por texto | Runway `text_to_video` — `gen4.5`, `veo3.1`, `veo3.1_fast` | Gen-4.5: 2–10 s, só 16:9/9:16 por texto; Veo: 4/6/8 s |
| Vídeo por imagem | Runway `image_to_video` — `gen4.5`, `gen4_turbo`, Veo | imagem principal do personagem como quadro inicial |
| Modo C — corpo inteiro | Runway `character_performance` — `act_two` (`bodyControl`) | vídeo de referência de 3–30 s, rosto visível; o resultado usa o cenário da imagem do personagem |
| Modo F — recriação | `gen4_image` (cena) → `act_two` | |
| Modos D/E — aparência/estilo | quadro inicial editado com `gen4_image` → `video_to_video` `aleph2` com keyframe | limite de duração configurável |
| Modos A/B — troca de rosto/cabeça | **sem integração** | exige provedor dedicado com licença comercial |
| Texto para fala | Runway `text_to_speech` — `eleven_v3` (vozes predefinidas, `languageCode: pt`) | sem clonagem de voz |
| Roteiros, ganchos, legendas, hashtags, cenas | Claude `claude-opus-5-5` | não inventa tendências/estatísticas (regra do sistema) |
| Detecção de pessoas, lip sync, transcrição | **sem integração** | usuário confirma a pessoa pela prévia |

### Antes de ativar cada integração, confira
- API pública e **uso comercial** permitido nos termos do provedor;
- formatos aceitos e limites (Runway: imagens/vídeos por URL HTTPS; data URI até 5 MB);
- preço atual (ajuste na tabela de preços do painel admin);
- política de retenção dos arquivos enviados (a Runway expira as URLs de saída em 24–48 h — o worker baixa e guarda no seu Storage imediatamente).

## 4. Custos previsíveis

- **Site**: Cloudflare Pages grátis.
- **Supabase**: plano Free serve para testes (500 MB de banco, 1 GB de arquivos, uploads até 50 MB). Para vídeos maiores e uso real, plano Pro (US$ 25/mês, 100 GB de arquivos, uploads maiores).
- **Worker**: 1 instância pequena com 1–2 GB de RAM (~US$ 5–15/mês em Fly.io/Railway/Render/VPS).
- **IA (por uso)**: valores padrão da tabela (1 crédito ≈ US$ 0,01 = 1 crédito Runway): vídeo Gen-4.5 ~12/s, Act-Two ~5/s, Aleph ~15/s, imagem ~8, voz ~1 a cada 50 caracteres, roteiro ~10 (cobrado pelo consumo real de tokens). **Confirme os preços atuais antes de abrir para clientes.**
- **Proteções**: estimativa antes de cada tarefa, reserva de créditos, cobrança do custo real (nunca acima do estimado), teto mensal de gastos da plataforma, limite diário e por tarefa por plano, cancelamento automático se o provedor estimar acima da reserva.

## 5. Etapas

| Etapa | Situação |
|---|---|
| 1. Aplicação básica (cadastro, login, dashboard, biblioteca, personagens) | pronta |
| 2. Geração visual (imagens, referências, estilos) | pronta — depende da chave Runway |
| 3. Geração de vídeo (API real, assíncrona, prévia, exportação) | pronta — depende da chave Runway |
| 4. Transformação (modos C–F; A/B pendentes de provedor) | pronta para teste com modelo real |
| 5. Áudio e edição (voz, legendas, editor, pausas) | pronta; lip sync e transcrição pendentes |
| 6. Conteúdo para redes | pronto — depende da chave Anthropic |
| 7. Comercialização (créditos, planos, admin, custos) | créditos/planos/admin prontos; **pagamentos ainda não** |
