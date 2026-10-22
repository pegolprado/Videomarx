import type { ReactNode } from 'react';
import { Gauge } from 'lucide-react';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="relative hidden overflow-hidden lg:block">
        <div className="gradient-bg absolute inset-0 opacity-90" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-2 font-display text-xl font-semibold">
            <Gauge className="size-6" /> VideoAI Studio
          </div>
          <div>
            <p className="font-display text-4xl font-semibold leading-tight">Personagens originais. Vídeos com IA. Do roteiro à exportação.</p>
            <p className="mt-4 max-w-md text-white/80">Crie personagens consistentes, gere cenas por texto, transforme vídeos autorizados e prepare conteúdo para Reels, TikTok e Shorts.</p>
          </div>
          <p className="text-sm text-white/70">iamarx.com.br</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
