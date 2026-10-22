import { useState } from 'react';
import { JobCard } from '@/components/JobCard';
import { Empty, PageHeader, Spinner, Tabs } from '@/components/ui';
import { useJobs } from '@/lib/hooks';
import { ACTIVE_STATUSES } from '@shared/jobs';

type F = 'all' | 'active' | 'done' | 'failed';

export default function Jobs() {
  const [f, setF] = useState<F>('all');
  const jobs = useJobs({ limit: 100 });
  const list = (jobs.data ?? []).filter((j) => f === 'all' || (f === 'active' ? ACTIVE_STATUSES.includes(j.status) : f === 'done' ? j.status === 'succeeded' : j.status === 'failed' || j.status === 'canceled'));
  return (
    <div>
      <PageHeader title="Tarefas" subtitle="Acompanhe o processamento. Você pode sair da página: as tarefas continuam no servidor." />
      <Tabs<F> value={f} onChange={setF} tabs={[{ value: 'all', label: 'Todas' }, { value: 'active', label: 'Em andamento' }, { value: 'done', label: 'Concluídas' }, { value: 'failed', label: 'Falhas e cancelamentos' }]} />
      {jobs.isLoading ? <Spinner /> : list.length ? <div className="grid gap-3 lg:grid-cols-2">{list.map((j) => <JobCard key={j.id} job={j} />)}</div> : <Empty title="Nenhuma tarefa" />}
    </div>
  );
}
