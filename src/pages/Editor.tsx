import { ArrowLeft, ArrowRight, Film, Scissors, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Aspect, ExportParams } from '@shared/jobs';
import { estimateFileSizeBytes, formatBytes, formatDuration } from '@shared/format';
import { AssetGrid, AssetThumb, UploadBox } from '@/components/Assets';
import { CostConfirm } from '@/components/CostConfirm';
import { IntegrationGate } from '@/components/IntegrationGate';
import { JobCard } from '@/components/JobCard';
import { MediaPreview } from '@/components/MediaPreview';
import { Button, Card, Checkbox, Field, Input, Notice, PageHeader, Select, Tabs } from '@/components/ui';
import { useAssets, useJobs } from '@/lib/hooks';

type Mode = 'single' | 'sequence' | 'auto';

export default function Editor() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>('single');
  const [clipId, setClipId] = useState<string | null>(params.get('asset'));
  const [timeline, setTimeline] = useState<string[]>(params.get('asset') ? [params.get('asset')!] : []);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const videos = useAssets({ kind: 'video', categories: ['original', 'generated', 'transformed', 'export'] });
  const subtitles = useAssets({ kind: 'subtitle' });
  const audios = useAssets({ kind: 'audio' });
  const jobs = useJobs({ ids: jobIds });
  const clip = videos.data?.find((v) => v.id === clipId);
  const ok = (videos.data ?? []).filter((v) => v.probe_status === 'ok');
  const addJob = (id: string) => setJobIds((ids) => [id, ...ids]);

  const [exp, setExp] = useState<ExportParams>({ aspect: '9:16', resolution: 1080, fit: 'crop', quality: 'economy', speed: 1, volume: 1, fade_audio: false, mute: false, color: { brightness: 0, contrast: 1, saturation: 1 } });
  const [overlay, setOverlay] = useState({ text: '', position: 'bottom' as 'top' | 'center' | 'bottom' });
  const [seq, setSeq] = useState({ aspect: '9:16' as Aspect, resolution: 720 as 720 | 1080, transition: 'fade' as 'fade' | 'none', music_asset_id: '', music_volume: 0.3 });
  const [auto, setAuto] = useState({ noise_db: -35, min_silence: 0.6, padding: 0.15 });

  useEffect(() => {
    if (clip?.duration_s) setExp((e) => ({ ...e, trim_start: 0, trim_end: Number(clip.duration_s) }));
  }, [clip?.id, clip?.duration_s]);

  const outDuration = clip ? ((exp.trim_end ?? Number(clip.duration_s)) - (exp.trim_start ?? 0)) / (exp.speed || 1) : 0;
  const totalSeq = timeline.reduce((n, id) => n + Number(ok.find((v) => v.id === id)?.duration_s ?? 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Editor de vídeo" subtitle="Corte, ajuste de formato, velocidade, cor, texto, legendas, montagem e exportação (processado no servidor com FFmpeg)." />
      <IntegrationGate provider="ffmpeg" feature="Edição de vídeo" />
      <Tabs<Mode> value={mode} onChange={setMode} tabs={[{ value: 'single', label: 'Editar e exportar' }, { value: 'sequence', label: 'Montar clipes' }, { value: 'auto', label: 'Edição automática' }]} />

      {mode !== 'sequence' && (
        <Card className="flex flex-col gap-3">
          <p className="font-medium">Vídeo</p>
          {ok.length ? <AssetGrid assets={ok.slice(0, 16)} selected={clipId ? [clipId] : []} onSelect={(a) => setClipId(a.id)} /> : <p className="text-sm text-muted">Nenhum vídeo pronto.</p>}
          <UploadBox kind="video" compact onUploaded={(a) => setClipId(a.id)} />
        </Card>
      )}

      {mode === 'single' && clip && (
        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          <Card className="flex flex-col gap-3">
            <MediaPreview asset={clip} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Início (s)">{(i) => <Input id={i} type="number" step={0.1} min={0} value={exp.trim_start ?? 0} onChange={(e) => setExp({ ...exp, trim_start: Number(e.target.value) })} />}</Field>
              <Field label="Fim (s)">{(i) => <Input id={i} type="number" step={0.1} min={0} max={Number(clip.duration_s)} value={exp.trim_end ?? Number(clip.duration_s)} onChange={(e) => setExp({ ...exp, trim_end: Number(e.target.value) })} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={`Brilho: ${exp.color?.brightness}`}>{(i) => <input id={i} type="range" min={-0.3} max={0.3} step={0.02} value={exp.color?.brightness ?? 0} onChange={(e) => setExp({ ...exp, color: { ...exp.color, brightness: Number(e.target.value) } })} />}</Field>
              <Field label={`Contraste: ${exp.color?.contrast}`}>{(i) => <input id={i} type="range" min={0.6} max={1.6} step={0.05} value={exp.color?.contrast ?? 1} onChange={(e) => setExp({ ...exp, color: { ...exp.color, contrast: Number(e.target.value) } })} />}</Field>
              <Field label={`Saturação: ${exp.color?.saturation}`}>{(i) => <input id={i} type="range" min={0} max={2} step={0.05} value={exp.color?.saturation ?? 1} onChange={(e) => setExp({ ...exp, color: { ...exp.color, saturation: Number(e.target.value) } })} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Texto na tela">{(i) => <Input id={i} maxLength={80} value={overlay.text} onChange={(e) => setOverlay({ ...overlay, text: e.target.value })} />}</Field>
              <Field label="Posição">{(i) => <Select id={i} value={overlay.position} onChange={(e) => setOverlay({ ...overlay, position: e.target.value as 'top' })} options={[{ value: 'top', label: 'Topo' }, { value: 'center', label: 'Centro' }, { value: 'bottom', label: 'Rodapé' }]} />}</Field>
              <Field label="Legenda incorporada">
                {(i) => <Select id={i} value={exp.subtitle_asset_id ?? ''} onChange={(e) => setExp({ ...exp, subtitle_asset_id: e.target.value || undefined })} options={[{ value: '', label: 'Sem legenda' }, ...(subtitles.data ?? []).filter((s) => s.probe_status === 'ok').map((s) => ({ value: s.id, label: s.name }))]} />}
              </Field>
            </div>
            <p className="text-xs text-muted">Legendas automáticas a partir da fala exigem um serviço de transcrição (integração pendente). Use legendas geradas em Voz ou envie um .srt; o arquivo .srt também pode ser baixado separadamente na Biblioteca.</p>
          </Card>
          <Card className="flex flex-col gap-3">
            <Field label="Formato">{(i) => <Select id={i} value={exp.aspect} onChange={(e) => setExp({ ...exp, aspect: e.target.value as Aspect })} options={[{ value: '9:16', label: 'Vertical 9:16 (Reels, TikTok, Shorts)' }, { value: '16:9', label: 'Horizontal 16:9 (YouTube)' }, { value: '1:1', label: 'Quadrado 1:1' }]} />}</Field>
            <Field label="Ajuste">{(i) => <Select id={i} value={exp.fit} onChange={(e) => setExp({ ...exp, fit: e.target.value as 'crop' })} options={[{ value: 'crop', label: 'Preencher (recorta as bordas)' }, { value: 'pad', label: 'Caber (barras pretas)' }]} />}</Field>
            <Field label="Resolução">{(i) => <Select id={i} value={String(exp.resolution)} onChange={(e) => setExp({ ...exp, resolution: Number(e.target.value) as 1080 })} options={[{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }]} />}</Field>
            <Field label="Qualidade">{(i) => <Select id={i} value={exp.quality} onChange={(e) => setExp({ ...exp, quality: e.target.value as 'high' })} options={[{ value: 'economy', label: 'Econômica (arquivo menor)' }, { value: 'high', label: 'Alta qualidade' }]} />}</Field>
            <Field label={`Velocidade: ${exp.speed}×`}>{(i) => <input id={i} type="range" min={0.25} max={4} step={0.25} value={exp.speed} onChange={(e) => setExp({ ...exp, speed: Number(e.target.value) })} />}</Field>
            <Field label={`Volume: ${Math.round((exp.volume ?? 1) * 100)}%`}>{(i) => <input id={i} type="range" min={0} max={2} step={0.05} value={exp.volume} onChange={(e) => setExp({ ...exp, volume: Number(e.target.value) })} />}</Field>
            <Checkbox checked={!!exp.fade_audio} onChange={(v) => setExp({ ...exp, fade_audio: v })}>Fade de entrada e saída no áudio</Checkbox>
            <Checkbox checked={!!exp.mute} onChange={(v) => setExp({ ...exp, mute: v })}>Remover áudio</Checkbox>
            <div className="rounded-xl bg-surface-2 p-3 text-xs text-muted">
              Saída: MP4 (H.264/AAC) · {formatDuration(outDuration)} · ~{formatBytes(estimateFileSizeBytes(outDuration, exp.resolution, exp.quality))}
            </div>
            <CostConfirm kind="media.export" params={{ ...exp, text_overlay: overlay.text ? overlay : undefined }} inputs={[clip.id]} label="Exportar" onCreated={(j) => addJob(j.id)} />
          </Card>
        </div>
      )}

      {mode === 'auto' && clip && (
        <Card className="flex flex-col gap-4">
          <p className="flex items-center gap-2 font-medium"><Wand2 className="size-4" /> Remover pausas automaticamente</p>
          <p className="text-sm text-muted">Identifica silêncios e mantém as falas com uma pequena margem, sem cortar no meio das frases. Revise o resultado antes de publicar.</p>
          {!clip.has_audio && <Notice tone="warning">Este vídeo não tem áudio.</Notice>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`Sensibilidade: ${auto.noise_db} dB`} hint="Mais negativo = só silêncio absoluto.">{(i) => <input id={i} type="range" min={-60} max={-20} step={1} value={auto.noise_db} onChange={(e) => setAuto({ ...auto, noise_db: Number(e.target.value) })} />}</Field>
            <Field label={`Pausa mínima: ${auto.min_silence} s`}>{(i) => <input id={i} type="range" min={0.3} max={3} step={0.1} value={auto.min_silence} onChange={(e) => setAuto({ ...auto, min_silence: Number(e.target.value) })} />}</Field>
            <Field label={`Margem: ${auto.padding} s`}>{(i) => <input id={i} type="range" min={0} max={0.6} step={0.05} value={auto.padding} onChange={(e) => setAuto({ ...auto, padding: Number(e.target.value) })} />}</Field>
          </div>
          <CostConfirm kind="media.autocut" params={auto} inputs={[clip.id]} label="Cortar pausas" disabled={!clip.has_audio ? 'Vídeo sem áudio.' : false} onCreated={(j) => addJob(j.id)} />
        </Card>
      )}

      {mode === 'sequence' && (
        <>
          <Card className="flex flex-col gap-3">
            <p className="flex items-center gap-2 font-medium"><Film className="size-4" /> Linha do tempo ({timeline.length} clipes · {formatDuration(totalSeq)})</p>
            {timeline.length ? (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {timeline.map((id, i) => {
                  const a = ok.find((v) => v.id === id);
                  if (!a) return null;
                  return (
                    <div key={`${id}-${i}`} className="flex w-40 shrink-0 flex-col gap-1 rounded-xl border border-line p-1.5" style={{ width: `${Math.max(120, Math.min(260, Number(a.duration_s) * 18))}px` }}>
                      <AssetThumb asset={a} />
                      <span className="truncate text-xs">{i + 1}. {a.name}</span>
                      <div className="flex justify-between">
                        <Button size="sm" variant="ghost" disabled={i === 0} aria-label="Mover para a esquerda" onClick={() => setTimeline((t) => { const n = [...t]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}><ArrowLeft className="size-3.5" /></Button>
                        <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => setTimeline((t) => t.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></Button>
                        <Button size="sm" variant="ghost" disabled={i === timeline.length - 1} aria-label="Mover para a direita" onClick={() => setTimeline((t) => { const n = [...t]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}><ArrowRight className="size-3.5" /></Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted">Toque nos vídeos abaixo para adicioná-los à linha do tempo.</p>
            )}
            <AssetGrid assets={ok.slice(0, 24)} onSelect={(a) => setTimeline((t) => [...t, a.id])} />
          </Card>
          <Card className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Formato">{(i) => <Select id={i} value={seq.aspect} onChange={(e) => setSeq({ ...seq, aspect: e.target.value as Aspect })} options={[{ value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }, { value: '1:1', label: '1:1' }]} />}</Field>
            <Field label="Resolução">{(i) => <Select id={i} value={String(seq.resolution)} onChange={(e) => setSeq({ ...seq, resolution: Number(e.target.value) as 720 })} options={[{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }]} />}</Field>
            <Field label="Transição">{(i) => <Select id={i} value={seq.transition} onChange={(e) => setSeq({ ...seq, transition: e.target.value as 'fade' })} options={[{ value: 'fade', label: 'Fade' }, { value: 'none', label: 'Corte seco' }]} />}</Field>
            <Field label="Áudio extra (narração/música)">{(i) => <Select id={i} value={seq.music_asset_id} onChange={(e) => setSeq({ ...seq, music_asset_id: e.target.value })} options={[{ value: '', label: 'Nenhum' }, ...(audios.data ?? []).filter((a) => a.probe_status === 'ok').map((a) => ({ value: a.id, label: a.name }))]} />}</Field>
            <Field label={`Volume do áudio extra: ${Math.round(seq.music_volume * 100)}%`}>{(i) => <input id={i} type="range" min={0} max={1} step={0.05} value={seq.music_volume} onChange={(e) => setSeq({ ...seq, music_volume: Number(e.target.value) })} />}</Field>
            <div className="sm:col-span-2 lg:col-span-5">
              <CostConfirm kind="media.concat" params={{ ...seq, music_asset_id: seq.music_asset_id || undefined }} inputs={timeline} disabled={!timeline.length ? 'Adicione clipes à linha do tempo.' : false} label="Montar vídeo" onCreated={(j) => addJob(j.id)} />
            </div>
          </Card>
        </>
      )}

      {jobs.data?.map((j) => <JobCard key={j.id} job={j} />)}
      {mode !== 'sequence' && !clip && <p className="flex items-center gap-2 text-sm text-muted"><Scissors className="size-4" /> Escolha um vídeo para editar.</p>}
    </div>
  );
}
