# O que está pronto e o que falta

## Funcionando (com código real, testado localmente)
- Cadastro, login, recuperação de senha, aceite de termos, exclusão de conta.
- Dashboard (ações, créditos, consumo, tarefas, projetos, favoritos, estimativas, alertas).
- Personagens: criação detalhada, versões alternativas (o original é mantido), referências, imagem principal, voz associada.
- Upload com barra de progresso, validação de formato/tamanho, análise automática (duração, resolução, proporção, miniaturas, quadros de prévia, arquivo inválido).
- Editor: corte, formato, resolução, qualidade, velocidade, volume, fade, cor, texto, legenda incorporada, montagem com transição e trilha, corte automático de pausas, exportação MP4.
- Fila assíncrona com estados Aguardando/Na fila/Processando/Concluído/Falhou/Cancelado, cancelamento, tentativas limitadas, retomada sem recobrança.
- Créditos: estimativa, reserva, liquidação pelo custo real, reembolso, idempotência, limites, orçamento mensal.
- Biblioteca (categorias, busca, favoritos, renomear, duplicar, baixar, excluir), roteiros salvos.
- Painel admin (visão geral, custos por modelo, usuários, créditos, planos, preços, integrações, configurações, auditoria).

## Implementado, aguardando chave para o primeiro teste real
Nunca executado contra os provedores neste ambiente (sem chaves e sem acesso de rede a eles). O código usa os SDKs oficiais e compila contra os tipos deles, mas **só deve ser considerado funcionando depois do teste real**:
- Runway: imagens de personagem, vídeo por texto/imagem, transformação Modos C, D, E e F, voz.
- Claude: pacote de conteúdo viral, divisão de roteiro em cenas.

## Pendente (aparece bloqueado na interface)
- Modos A (troca de rosto) e B (cabeça/rosto): falta provedor com API e licença comercial.
- Detecção/segmentação automática de pessoas (hoje o usuário confirma pela prévia).
- Sincronização labial.
- Legendas automáticas a partir da fala (transcrição).
- Regenerar só um trecho problemático de um vídeo transformado (hoje: ajustar o trecho e gerar outra variação).
- Pagamentos/assinaturas (planos e créditos já existem; cobrança só após validar o processamento real).
- Renovação mensal automática de créditos por plano.
- Gestão de equipes do plano Business.
- Identificação C2PA de conteúdo sintético (hoje: selo + metadado no MP4).
- Outros idiomas da interface.
