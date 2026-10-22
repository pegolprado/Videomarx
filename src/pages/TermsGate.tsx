import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Card, Checkbox } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

export function TermsGate() {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <h1 className="font-display text-xl font-semibold">Antes de começar</h1>
        <p className="mt-2 text-sm text-muted">Para usar a plataforma é necessário aceitar os termos de uso e a política de uso aceitável.</p>
        <div className="mt-4">
          <Checkbox checked={ok} onChange={setOk}>
            Li e aceito os{' '}
            <Link to="/termos" target="_blank" className="text-accent underline">
              termos de uso e a política de uso aceitável
            </Link>
            .
          </Checkbox>
        </div>
        <Button
          className="mt-4 w-full"
          variant="primary"
          disabled={!ok}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            const { error } = await supabase.rpc('accept_terms');
            setBusy(false);
            if (error) return toast.error(errorMessage(error));
            qc.invalidateQueries({ queryKey: ['profile'] });
          }}
        >
          Continuar
        </Button>
        <Button className="mt-2 w-full" variant="ghost" onClick={() => supabase.auth.signOut()}>
          Sair
        </Button>
      </Card>
    </div>
  );
}
