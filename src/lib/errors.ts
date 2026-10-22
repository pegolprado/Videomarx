/** Mensagens compreensíveis para erros do Supabase/rede. */
export function errorMessage(e: unknown): string {
  if (!e) return 'Erro desconhecido.';
  const err = e as { message?: string; code?: string; status?: number };
  const msg = err.message ?? String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Falha de conexão. Verifique sua internet e tente novamente.';
  if (/JWT expired|invalid JWT/i.test(msg)) return 'Sua sessão expirou. Entre novamente.';
  if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(msg)) return 'Confirme seu e-mail pelo link enviado antes de entrar.';
  if (/User already registered/i.test(msg)) return 'Já existe uma conta com este e-mail.';
  if (/Password should be/i.test(msg)) return 'A senha precisa ter pelo menos 8 caracteres, com letras e números.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para esta ação.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(msg)) return 'Arquivo maior que o limite permitido.';
  if (/mime type .* is not supported/i.test(msg)) return 'Formato de arquivo não aceito.';
  return msg;
}
