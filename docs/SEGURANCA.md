# Segurança, privacidade e direitos

- **Autenticação** Supabase (e-mail + senha, confirmação de e-mail, PKCE, senha mínima de 8 com letras e números).
- **Isolamento por usuário**: RLS em todas as tabelas; gatilhos impedem referenciar personagens/arquivos/projetos de outra conta; o caminho de cada arquivo começa com o id do dono (verificado no banco e nas políticas do Storage).
- **Armazenamento privado**: bucket `media` não público; o site usa URLs temporárias (1 h); o worker envia aos provedores URLs temporárias de até 4 h.
- **Segredos**: chaves da Runway, Anthropic e a service role ficam só no worker (variáveis de ambiente). O site recebe apenas a anon key. O painel admin nunca exibe chaves.
- **Integridade financeira**: usuário não escreve em saldo, extrato ou tarefas — apenas funções do banco; testes cobrem tentativa de fraude.
- **Metadados confiáveis**: duração/resolução vêm do FFmpeg no worker; o usuário não pode marcar arquivo como "gerado" nem forjar duração.
- **Direitos**: envio de vídeo exige confirmação de direitos/autorização (gravada no arquivo); transformação exige nova confirmação; personagens fictícios são a opção padrão; idades só adultas para humanos; sem clonagem de voz.
- **Uso aceitável**: termos aceitos no cadastro proíbem fraude, falsificação enganosa, assédio e exploração sexual não consentida. Os provedores aplicam moderação própria; recusas aparecem com mensagem clara e reembolso.
- **Conteúdo sintético**: arquivos de IA são marcados na plataforma (selo "IA") e recebem comentário nos metadados do MP4. (C2PA ainda não implementado.)
- **Auditoria**: alterações de créditos, planos, papéis, preços, integrações e configurações ficam em `audit_log`.
- **LGPD**: exclusão de arquivos a qualquer momento; exclusão de conta apaga Storage e dados (processada pelo worker); temporários expiram automaticamente (`temp_retention_days`).
- **Cabeçalhos**: CSP restrita, HSTS, `X-Frame-Options: DENY`, `nosniff` (`public/_headers`).
- **Abuso**: limites por plano (tamanho, duração, créditos por tarefa e por dia), teto global de gastos, suspensão de contas pelo admin.
