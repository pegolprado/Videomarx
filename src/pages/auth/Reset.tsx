import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { AuthShell } from './AuthShell';

export default function Reset() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  return (
    <AuthShell title="Nova senha">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase.auth.updateUser({ password });
          setBusy(false);
          if (error) return toast.error(errorMessage(error));
          toast.success('Senha alterada.');
          navigate('/', { replace: true });
        }}
      >
        <Field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Salvar
        </Button>
      </form>
    </AuthShell>
  );
}
