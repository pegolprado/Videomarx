import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RUNWAY_VOICE_PRESETS, TTS_LANGUAGES } from '@shared/voices';
import { CharacterSelect } from '@/components/CharacterSelect';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate, useIntegration } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { Card, Checkbox, Field, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useCharacters, useJobs } from '@/lib/hooks';
import { UploadBox } from '@/components/Assets';

export default function Voice() {
  const location = useLocation();
  const [text, setText] = useState((location.state as { text?: string } | null)?.text ?? '');
  const [characterId, setCharacterId] = useState('');
  const [voice, setVoice] = useState<string>('Maya');
  const [language, setLanguage] = useState('pt');
  const [speed, setSpeed] = useState(1);
  const [stability, setStability] = useState(0.5);
  const [subs, setSubs] = useState(true);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const jobs = useJobs({ ids: jobIds });
  const chars = useCharacters();
  const runway = useIntegration('runway');

  useEffect(() => {
    const c = chars.data?.find((x) => x.id === characterId);
    if (c?.voice.preset_id) setVoice(c.voice.preset_id);
    if (c?.voice.language) setLanguage(c.voice.language);
    if (c?.voice.speed) setSpeed(c.voice.speed);
  }, [characterId, chars.data]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Voz e áudio" subtitle="Texto para fala com vozes sintéticas, legendas e importação de áudio." />
      <IntegrationGate provider="runway" feature="Texto para fala" />
      <Card className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Texto" hint={`${text.length}/3000 caracteres. Pausas: use vírgulas, reticências ou [pause]. Emoção: [laughs], [whispers].`}>
            {(i) => <Textarea id={i} rows={6} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        </div>
        <Field label="Personagem (usa a voz salva)">{(i) => <CharacterSelect id={i} allowNone value={characterId} onChange={setCharacterId} />}</Field>
        <Field label="Voz sintética">{(i) => <Select id={i} value={voice} onChange={(e) => setVoice(e.target.value)} options={RUNWAY_VOICE_PRESETS.map((v) => ({ value: v, label: v }))} />}</Field>
        <Field label="Idioma">{(i) => <Select id={i} value={language} onChange={(e) => setLanguage(e.target.value)} options={TTS_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />}</Field>
        <Field label={`Velocidade: ${speed.toFixed(2)}×`}>{(i) => <input id={i} type="range" min={0.7} max={1.2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />}</Field>
        <Field label={`Estabilidade / entonação: ${stability.toFixed(2)}`} hint="Menor = mais expressiva; maior = mais estável.">
          {(i) => <input id={i} type="range" min={0} max={1} step={0.05} value={stability} onChange={(e) => setStability(Number(e.target.value))} />}
        </Field>
        <Checkbox checked={subs} onChange={setSubs}>Gerar também legenda .srt (tempos estimados a partir do texto)</Checkbox>
        <div className="md:col-span-2">
          <Notice>Somente vozes sintéticas originais estão disponíveis. Clonagem de vozes de pessoas reais não está habilitada.</Notice>
        </div>
        <div className="md:col-span-2">
          <CostConfirm kind="ai.tts" params={{ text, voice, language, speed, stability, character_id: characterId || undefined, make_subtitles: subs }} disabled={!runway.ok ? runway.reason : !text.trim() ? 'Escreva o texto.' : false} label="Gerar voz" onCreated={(j) => setJobIds((ids) => [j.id, ...ids])} />
        </div>
      </Card>
      {jobs.data?.map((j) => <JobCard key={j.id} job={j} />)}
      <Card className="flex flex-col gap-3">
        <p className="font-medium">Importar áudio ou legenda</p>
        <div className="grid gap-3 md:grid-cols-2">
          <UploadBox kind="audio" compact />
          <UploadBox kind="subtitle" compact />
        </div>
        <p className="text-xs text-muted">Use apenas músicas e efeitos sonoros licenciados ou autorais. Ajuste de volume, fade e sincronização são feitos no Editor.</p>
      </Card>
      <Notice title="Sincronização labial: integração pendente">
        Nenhum serviço de lip sync está conectado. A narração gerada pode ser combinada ao vídeo no Editor, sem sincronizar os lábios.
      </Notice>
    </div>
  );
}
