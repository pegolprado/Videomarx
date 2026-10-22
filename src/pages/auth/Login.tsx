import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { AuthShell } from './AuthShell';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <AuthShell title="Entrar" subtitle="Bem-vindo de volta ao VideoAI Studio.">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          setBusy(false);
          if (error) return toast.error(errorMessage(error));
          navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
        }}
      >
        <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Senha">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" loading={busy}>
          Entrar
        </Button>
      </form>
      <div className="mt-6 flex justify-between text-sm">
        <Link to="/recuperar" className="text-muted hover:text-fg">
          Esqueci a senha
        </Link>
        <Link to="/cadastro" className="font-medium text-accent">
          Criar conta
        </Link>
      </div>
    </AuthShell>
  );
}
