#!/usr/bin/env node
// Gera supabase/setup.sql juntando todas as migrações (instalação colando um único arquivo).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'supabase', 'migrations');
let out = '-- VideoAI Studio — instalação completa do banco em um único arquivo.\n-- Cole tudo no SQL Editor do Supabase e clique em Run. Gerado a partir de supabase/migrations.\n';
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  out += `\n-- ===== ${f} =====\n${readFileSync(join(dir, f), 'utf8')}`;
}
writeFileSync(join(root, 'supabase', 'setup.sql'), out);
console.log('supabase/setup.sql atualizado');
