import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Field, Input, Notice } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { siteUrl, supabase } from '@/lib/supabase';
import { AuthShell } from './AuthShell';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell title="Recuperar senha">
      {sent ? (
        <Notice tone="success">Se houver uma conta com este e-mail, você receberá um link para criar uma nova senha.</Notice>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${siteUrl}/redefinir-senha` });
            setBusy(false);
            if (error) return toast.error(errorMessage(error));
            setSent(true);
          }}
        >
          <Field label="E-mail">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" loading={busy}>
            Enviar link
          </Button>
        </form>
      )}
      <Link to="/entrar" className="mt-6 block text-sm text-muted">
        Voltar ao login
      </Link>
    </AuthShell>
  );
}
