export function SetupScreen() {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-display text-2xl font-semibold">VideoAI Studio — configuração pendente</h1>
      <p className="mt-3 text-sm text-muted">
        O site não encontrou as variáveis <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_ANON_KEY</code>. Configure-as no ambiente de build (ou em
        <code> .env.local</code> no desenvolvimento) e publique novamente. O passo a passo está em <code>docs/DEPLOY.md</code>.
      </p>
    </div>
  );
}
