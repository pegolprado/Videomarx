import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme, type Theme } from '@/app/theme';
import { Button, Card, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { usePlan, useProfile } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';

export default function Account() {
  const profile = useProfile();
  const plan = usePlan();
  const [name, setName] = useState('');
  const [theme, setTheme] = useTheme();
  const qc = useQueryClient();
  useEffect(() => setName(profile.data?.display_name ?? ''), [profile.data?.display_name]);

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <PageHeader title="Minha conta" />
      <Card className="flex flex-col gap-4">
        <Field label="E-mail">{(i) => <Input id={i} value={profile.data?.email ?? ''} disabled />}</Field>
        <Field label="Nome">{(i) => <Input id={i} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <p className="text-sm text-muted">Plano: <strong>{plan.data?.name}</strong></p>
        <Button className="self-start" onClick={async () => {
          const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', profile.data!.id);
          if (error) return toast.error(errorMessage(error));
          toast.success('Salvo.');
          qc.invalidateQueries({ queryKey: ['profile'] });
        }}>Salvar</Button>
      </Card>
      <Card className="flex flex-col gap-4">
        <Field label="Tema">{(i) => <Select id={i} value={theme} onChange={(e) => setTheme(e.target.value as Theme)} options={[{ value: 'system', label: 'Automático (sistema)' }, { value: 'dark', label: 'Escuro' }, { value: 'light', label: 'Claro' }]} />}</Field>
        <Field label="Idioma" hint="Outros idiomas serão adicionados no futuro.">{(i) => <Select id={i} value="pt-BR" disabled options={[{ value: 'pt-BR', label: 'Português (Brasil)' }]} />}</Field>
      </Card>
      <Card className="flex flex-col gap-3">
        <p className="font-medium">Senha</p>
        <Button className="self-start" onClick={async () => {
          const { error } = await supabase.auth.resetPasswordForEmail(profile.data!.email!, { redirectTo: `${window.location.origin}/redefinir-senha` });
          if (error) return toast.error(errorMessage(error));
          toast.success('Enviamos um link para o seu e-mail.');
        }}>Enviar link para trocar a senha</Button>
      </Card>
      <Card className="flex flex-col gap-3 border-danger/40">
        <p className="font-medium text-danger">Excluir conta</p>
        {profile.data?.deletion_requested_at ? (
          <Notice tone="warning">Exclusão solicitada. Seus arquivos e dados serão apagados em alguns minutos.</Notice>
        ) : (
          <>
            <p className="text-sm text-muted">Apaga definitivamente sua conta, personagens, projetos, arquivos e histórico. Não pode ser desfeito.</p>
            <Button variant="danger" className="self-start" onClick={async () => {
              if (prompt('Digite EXCLUIR para confirmar') !== 'EXCLUIR') return;
              const { error } = await supabase.rpc('request_account_deletion');
              if (error) return toast.error(errorMessage(error));
              toast.success('Exclusão solicitada.');
              await supabase.auth.signOut();
            }}>Excluir minha conta</Button>
          </>
        )}
      </Card>
    </div>
  );
}
