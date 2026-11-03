import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { integrationStatus, TRANSFORM_MODES } from '@shared/transform';
import { Badge, Card, Notice, PageHeader, Spinner } from '@/components/ui';
import { useCapabilities } from '@/lib/hooks';

const FEATURES: { feature: string; provider: string | null; note?: string }[] = [
  { feature: 'Validação, cortes, conversão, montagem e exportação', provider: 'ffmpeg' },
  { feature: 'Corte automático de pausas', provider: 'ffmpeg' },
  { feature: 'Legendas incorporadas (.srt)', provider: 'ffmpeg' },
  { feature: 'Vídeo animado a partir de imagens (grátis)', provider: 'ffmpeg' },
  { feature: 'Imagens de personagens e cenas — Cloudflare FLUX (grátis, cota diária)', provider: 'cloudflare' },
  { feature: 'Imagens de personagens e cenários — Runway', provider: 'runway' },
  { feature: 'Vídeo por texto e por imagem', provider: 'runway' },
  ...TRANSFORM_MODES.flatMap((m) =>
    m.providers.length
      ? m.providers.map((p) => ({ feature: `Transformar vídeo — Modo ${m.letter}: ${m.title} (${p === 'fal' ? 'fal.ai' : p === 'hf' ? 'GPU grátis do Hugging Face' : 'Runway'})`, provider: p as string | null, note: undefined as string | undefined }))
      : [{ feature: `Transformar vídeo — Modo ${m.letter}: ${m.title}`, provider: null, note: m.how }],
  ),
  { feature: 'Vídeo com movimento — Wan 2.2 GRÁTIS (GPU do Hugging Face, limite diário)', provider: 'hf' },
  { feature: 'Vídeo com movimento a partir de imagem — Wan 2.2 (fal.ai)', provider: 'fal' },
  { feature: 'Vídeo com movimento por texto ou imagem — Wan 2.2 (Pollinations)', provider: 'pollinations' },
  { feature: 'Personagem falando GRÁTIS — experimental (GPU do Hugging Face)', provider: 'hf' },
  { feature: 'Modelos animados: textos e imagens em vídeo (HyperFrames, grátis)', provider: 'motion' },
  { feature: 'Personagem falando (imagem + voz, boca sincronizada) — VEED Fabric (fal.ai)', provider: 'fal' },
  { feature: 'Texto para fala — motor próprio (Piper, grátis)', provider: 'local' },
  { feature: 'Texto para fala — Runway (vozes ElevenLabs)', provider: 'runway' },
  { feature: 'Roteiros, ganchos, legendas, hashtags e divisão em cenas — Gemini (grátis)', provider: 'gemini' },
  { feature: 'Roteiros, ganchos, legendas, hashtags e divisão em cenas — Claude', provider: 'anthropic' },
  { feature: 'Detecção automática de pessoas no vídeo', provider: null, note: 'Requer um modelo de detecção/segmentação; o usuário confirma a pessoa pela prévia.' },
  { feature: 'Legendas automáticas a partir da fala (Whisper, grátis)', provider: 'local' },
  { feature: 'Clonagem de voz', provider: null, note: 'Desabilitada por política: somente vozes sintéticas originais.' },
  { feature: 'Dados de tendências para conteúdo viral', provider: null, note: 'Nenhuma fonte de dados real conectada; nada é inventado.' },
  { feature: 'Pagamentos e assinaturas', provider: null, note: 'Serão habilitados após validar o processamento real.' },
];

export default function Integrations() {
  const caps = useCapabilities();
  if (caps.isLoading) return <Spinner />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Integrações" subtitle="O que está funcionando agora e o que ainda depende de configuração." />
      {!caps.data?.worker_online && <Notice tone="danger" title="Servidor de processamento offline">Nenhum worker enviou sinal nos últimos 2 minutos. Tarefas ficam na fila até ele voltar.</Notice>}
      <div className="grid gap-3 md:grid-cols-3">
        {Object.entries(caps.data?.integrations ?? {}).map(([id, i]) => {
          const st = integrationStatus(caps.data, id);
          return (
            <Card key={id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2"><p className="font-medium">{i.label}</p>{st.ok ? <Badge tone="success">Ativa</Badge> : <Badge tone="warning">Pendente</Badge>}</div>
              <p className="text-sm text-muted">{i.description}</p>
              {!st.ok && <p className="text-xs text-warning">{st.reason}</p>}
            </Card>
          );
        })}
      </div>
      <Card>
        <ul className="divide-y divide-line text-sm">
          {FEATURES.map((f) => {
            const st = f.provider ? integrationStatus(caps.data, f.provider) : { ok: false, reason: 'Sem integração' };
            return (
              <li key={f.feature} className="flex items-start gap-3 py-2.5">
                {st.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : f.provider ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-warning" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-muted" />}
                <div>
                  <p>{f.feature}</p>
                  <p className="text-xs text-muted">{st.ok ? 'Disponível' : f.note ?? st.reason}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="text-xs text-muted">Nenhum resultado de demonstração é exibido como geração real. Funções sem integração aparecem bloqueadas e não consomem créditos.</p>
    </div>
  );
}
