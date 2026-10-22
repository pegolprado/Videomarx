import { clsx } from 'clsx';
import {
  Clapperboard, Coins, FolderOpen, Gauge, Image as ImageIcon, LayoutDashboard, ListChecks, LogOut, Menu, Mic, Moon, Plug,
  Scissors, Shield, Sparkles, Sun, UserRound, Users, Wand2, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTheme } from '@/app/theme';
import { useCredits, useProfile } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';

const NAV: { to: string; label: string; icon: ReactNode; admin?: boolean }[] = [
  { to: '/', label: 'Início', icon: <LayoutDashboard className="size-4" /> },
  { to: '/transformar', label: 'Transformar vídeo', icon: <Wand2 className="size-4" /> },
  { to: '/gerar', label: 'Gerar vídeo com IA', icon: <Clapperboard className="size-4" /> },
  { to: '/personagens', label: 'Personagens', icon: <Users className="size-4" /> },
  { to: '/imagens', label: 'Imagens', icon: <ImageIcon className="size-4" /> },
  { to: '/viral', label: 'Conteúdo viral', icon: <Sparkles className="size-4" /> },
  { to: '/voz', label: 'Voz', icon: <Mic className="size-4" /> },
  { to: '/editor', label: 'Editor', icon: <Scissors className="size-4" /> },
  { to: '/biblioteca', label: 'Biblioteca', icon: <FolderOpen className="size-4" /> },
  { to: '/tarefas', label: 'Tarefas', icon: <ListChecks className="size-4" /> },
  { to: '/creditos', label: 'Créditos e planos', icon: <Coins className="size-4" /> },
  { to: '/integracoes', label: 'Integrações', icon: <Plug className="size-4" /> },
  { to: '/admin', label: 'Administração', icon: <Shield className="size-4" />, admin: true },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const profile = useProfile();
  const credits = useCredits();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  const isAdmin = profile.data?.role === 'admin';
  const dark = theme === 'dark' || (theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition', isActive ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')
          }
        >
          {n.icon}
          {n.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface p-4 lg:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <AccountBox />
      </aside>

      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur lg:hidden">
        <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Abrir menu">
          <Menu className="size-5" />
        </button>
        <Brand />
        <CreditPill credits={credits.data?.available} onClick={() => navigate('/creditos')} />
      </header>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setOpen(false)}>
          <div className="flex h-full w-72 flex-col gap-6 overflow-y-auto bg-surface p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted" aria-label="Fechar menu">
                <X className="size-5" />
              </button>
            </div>
            {nav}
            <AccountBox />
          </div>
        </div>
      )}

      <div className="min-w-0">
        <div className="hidden items-center justify-end gap-2 border-b border-line px-8 py-3 lg:flex">
          <CreditPill credits={credits.data?.available} onClick={() => navigate('/creditos')} />
          <button onClick={() => setTheme(dark ? 'light' : 'dark')} className="rounded-xl p-2 text-muted hover:bg-surface-2" aria-label="Alternar tema">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2">
      <span className="gradient-bg grid size-8 place-items-center rounded-xl text-white">
        <Gauge className="size-4" />
      </span>
      <span className="font-display text-lg font-semibold">
        VideoAI <span className="gradient-text">Studio</span>
      </span>
    </NavLink>
  );
}

function CreditPill({ credits, onClick }: { credits?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-sm hover:border-accent/60">
      <Coins className="size-4 text-warning" />
      <span className="font-medium">{credits?.toLocaleString('pt-BR') ?? '—'}</span>
      <span className="hidden text-muted sm:inline">créditos</span>
    </button>
  );
}

function AccountBox() {
  const profile = useProfile();
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line p-2">
      <NavLink to="/conta" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 hover:bg-surface-2">
        <UserRound className="size-5 shrink-0 text-muted" />
        <span className="truncate text-sm">{profile.data?.display_name || profile.data?.email || 'Minha conta'}</span>
      </NavLink>
      <button onClick={() => supabase.auth.signOut()} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Sair" title="Sair">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
