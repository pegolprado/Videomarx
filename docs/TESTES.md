# Testes

| Suíte | Comando | O que cobre |
|---|---|---|
| Banco (PostgreSQL 16 real) | `npm run test:db` | cadastro e bônus; isolamento entre contas (tabelas e Storage); tentativas de fraude (saldo, extrato, papel, plano, metadados); estimativas por modo; direitos obrigatórios; limites do plano; idempotência; liquidação pelo custo real e teto da estimativa; reembolso em falha e cancelamento; saldo insuficiente; orçamento mensal; integração desabilitada; fila (posse, retomada após queda, espera, limite de tentativas); capacidades; funções admin e auditoria |
| Regras compartilhadas | `npm test` | modos disponíveis conforme integrações; avisos de qualidade; prompts (limite de 1000 caracteres, referência `@char`); divisão de roteiro; legendas SRT; filtros FFmpeg; proporções por modelo |
| Worker | `npm run test:worker` | FFmpeg **real**: análise de vídeo/imagem/arquivo inválido, exportação 9:16 com legenda e texto, velocidade 2×, montagem com transição, corte de pausas, preparo de trecho; adaptador Runway (retomada sem recriar tarefa, cancelamento por preço, falhas, cancelamento); executor (falha temporária, cancelamento, sucesso) |
| Interface | Playwright (manual, ver abaixo) | todas as 16 telas renderizadas com backend simulado, sem erros de execução; celular sem rolagem horizontal |

Resultado na entrega: banco 5/5 arquivos, compartilhado 19/19, worker 19/19, lint e tipos sem erros, build de produção ok.

**Não testado**: chamadas reais à Runway e à Anthropic (dependem das suas chaves) e o fluxo completo contra um projeto Supabase real. Faça o roteiro da seção 5 de `DEPLOY.md` antes de abrir ao público.
