import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Checkbox, Field, Input, Notice } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { siteUrl, supabase } from '@/lib/supabase';
import { AuthShell } from './AuthShell';

export default function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const weak = password.length > 0 && (password.length < 8 || !/\d/.test(password) || !/[a-z]/i.test(password));

  if (sent)
    return (
      <AuthShell title="Confirme seu e-mail">
        <Notice tone="success">Enviamos um link de confirmação para {email}. Abra o link para ativar a conta e depois entre.</Notice>
        <Link to="/entrar" className="mt-6 block text-sm text-accent">
          Ir para o login
        </Link>
      </AuthShell>
    );

  return (
    <AuthShell title="Criar conta" subtitle="Comece com créditos de boas-vindas para testar.">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (weak) return toast.error('A senha precisa ter pelo menos 8 caracteres, com letras e números.');
          setBusy(true);
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: `${siteUrl}/`, data: { display_name: name, terms_accepted: terms } },
          });
          setBusy(false);
          if (error) return toast.error(errorMessage(error));
          if (!data.session) setSent(true);
        }}
      >
        <Field label="Nome">{(id) => <Input id={id} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Senha" error={weak ? 'Mínimo de 8 caracteres, com letras e números.' : undefined}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Checkbox checked={terms} onChange={setTerms}>
          Li e aceito os{' '}
          <Link to="/termos" target="_blank" className="text-accent underline">
            termos de uso e a política de uso aceitável
          </Link>
          .
        </Checkbox>
        <Button type="submit" variant="primary" loading={busy} disabled={!terms}>
          Criar conta
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Já tem conta?{' '}
        <Link to="/entrar" className="font-medium text-accent">
          Entrar
        </Link>
      </p>
    </AuthShell>
  );
}
