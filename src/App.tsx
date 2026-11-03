import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './app/auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { isConfigured } from './lib/supabase';
import { useProfile } from './lib/hooks';
import { SetupScreen } from './pages/SetupScreen';
import { TermsGate } from './pages/TermsGate';

const Login = lazy(() => import('./pages/auth/Login'));
const Signup = lazy(() => import('./pages/auth/Signup'));
const Forgot = lazy(() => import('./pages/auth/Forgot'));
const Reset = lazy(() => import('./pages/auth/Reset'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const CharacterList = lazy(() => import('./pages/characters/CharacterList'));
const CharacterEditor = lazy(() => import('./pages/characters/CharacterEditor'));
const Transform = lazy(() => import('./pages/Transform'));
const Generate = lazy(() => import('./pages/Generate'));
const FreeVideo = lazy(() => import('./pages/FreeVideo'));
const Motion = lazy(() => import('./pages/Motion'));
const Images = lazy(() => import('./pages/Images'));
const Viral = lazy(() => import('./pages/Viral'));
const Voice = lazy(() => import('./pages/Voice'));
const Editor = lazy(() => import('./pages/Editor'));
const Library = lazy(() => import('./pages/Library'));
const Jobs = lazy(() => import('./pages/Jobs'));
const Credits = lazy(() => import('./pages/Credits'));
const Account = lazy(() => import('./pages/Account'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Admin = lazy(() => import('./pages/Admin'));
const Legal = lazy(() => import('./pages/Legal'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  const profile = useProfile();
  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/entrar" replace state={{ from: location.pathname }} />;
  if (profile.isLoading) return <Spinner />;
  if (profile.data?.suspended) return <div className="p-8 text-center">Sua conta está suspensa. Entre em contato com o suporte.</div>;
  if (profile.data && !profile.data.terms_accepted_at) return <TermsGate />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const profile = useProfile();
  if (profile.isLoading) return <Spinner />;
  if (profile.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  return session ? <Navigate to="/" replace /> : <>{children}</>;
}

export function App() {
  if (!isConfigured) return <SetupScreen />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/entrar" element={<PublicOnly><Login /></PublicOnly>} />
              <Route path="/cadastro" element={<PublicOnly><Signup /></PublicOnly>} />
              <Route path="/recuperar" element={<Forgot />} />
              <Route path="/redefinir-senha" element={<Reset />} />
              <Route path="/termos" element={<Legal />} />
              <Route element={<RequireAuth><Layout /></RequireAuth>}>
                <Route index element={<Dashboard />} />
                <Route path="personagens" element={<CharacterList />} />
                <Route path="personagens/:id" element={<CharacterEditor />} />
                <Route path="transformar" element={<Transform />} />
                <Route path="gerar" element={<Generate />} />
                <Route path="video-gratis" element={<FreeVideo />} />
                <Route path="animados" element={<Motion />} />
                <Route path="imagens" element={<Images />} />
                <Route path="viral" element={<Viral />} />
                <Route path="voz" element={<Voice />} />
                <Route path="editor" element={<Editor />} />
                <Route path="biblioteca" element={<Library />} />
                <Route path="tarefas" element={<Jobs />} />
                <Route path="creditos" element={<Credits />} />
                <Route path="conta" element={<Account />} />
                <Route path="integracoes" element={<Integrations />} />
                <Route path="admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
      <Toaster richColors position="top-right" closeButton />
    </QueryClientProvider>
  );
}
