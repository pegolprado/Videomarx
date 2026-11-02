# Motor próprio (IA no nosso servidor)

Funções que rodam na nossa máquina, sem pagar provedor por uso.

| Função | Programa | Licença do programa | Modelo/voz | Licença do modelo |
|---|---|---|---|---|
| Legendas automáticas (fala → .srt) | whisper.cpp v1.9.5 | MIT | Whisper `base` multilíngue (OpenAI) | MIT |
| Voz em português | Piper 2023.11.14-2 | MIT | `pt_BR-faber-medium` | **conferir** o `MODEL_CARD` em huggingface.co/rhasspy/piper-voices (pt/pt_BR/faber/medium) antes do uso comercial |

## Como é instalado
O `worker/Dockerfile` compila o whisper.cpp e baixa o Piper, o modelo e as vozes. Na Oracle, a atualização automática de hora em hora faz isso sozinha; a primeira compilação numa máquina pequena (E2.1.Micro) pode levar de 30 a 60 minutos, e o worker antigo continua funcionando enquanto isso. Essas etapas ficam em cache: as atualizações seguintes do app não recompilam o Whisper.

Quando estiver pronto, o worker informa `local_transcribe`, `local_tts` e `local_voices`, e a página **Integrações** mostra "Motor próprio" como **Ativa**.

## Ajustes
- **Modelo do Whisper**: `base` (padrão, leve). Em máquina com 4 GB de RAM ou mais, use `small` (melhor em português): `--build-arg WHISPER_MODEL=small`.
- **Vozes**: `--build-arg PIPER_VOICES="pt_BR-faber-medium pt_BR-cadu-medium"` (a primeira é obrigatória).
- **Limites e preço**: Administração → Preços (`local.transcribe`, `local.tts`). Padrão: 0 créditos e até 300 s por legenda.
- **Threads**: variável `LOCAL_AI_THREADS` (padrão 2).

## Opções gratuitas externas
| Função | Serviço | Limite gratuito (conferir no provedor) |
|---|---|---|
| Roteiros e cenas | Google Gemini (`gemini-flash-latest`, variável `GEMINI_MODEL`) | limite diário de pedidos do plano gratuito; o Google pode usar o conteúdo para melhorar os produtos |
| Imagens | Cloudflare Workers AI — FLUX.1 schnell (Apache 2.0) | 10.000 neurons/dia; sem imagens de referência (usa só a descrição do personagem) |
| Vídeo animado | FFmpeg no nosso servidor | sem limite |

## Próximas fases
- Fase 2: vídeo e imagem com modelos abertos (Wan 2.2, Wan-Animate, FLUX.1 schnell) numa GPU alugada por uso.
- Fase 3: treinamento de personagens (LoRA) para consistência própria.
