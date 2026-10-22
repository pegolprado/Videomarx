#!/usr/bin/env node
/**
 * Testes do banco: aplica o stub do Supabase + TODAS as migrações num
 * PostgreSQL limpo e executa supabase/tests/*.test.sql.
 *
 * - Com DATABASE_URL (CI), usa esse servidor.
 * - Sem ele, cria um cluster temporário com initdb/pg_ctl.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const testsDir = join(root, 'supabase', 'tests');

function findPgBin() {
  const candidates = ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'];
  return candidates.find((c) => existsSync(join(c, 'initdb')));
}

let cleanup = () => {};
let baseUrl = process.env.DATABASE_URL;

if (!baseUrl) {
  const bin = findPgBin();
  if (!bin) {
    console.error('PostgreSQL não encontrado. Defina DATABASE_URL ou instale o PostgreSQL 15+.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'videoai-pg-'));
  const port = String(54000 + Math.floor(Math.random() * 900));
  const asPg = process.getuid?.() === 0 ? ['-u', 'postgres'] : null;
  const run = (cmd, args) => {
    if (asPg) {
      execFileSync('chown', ['-R', 'postgres', dir]);
      return execFileSync('runuser', [...asPg, '--', join(bin, cmd), ...args], { stdio: 'pipe' });
    }
    return execFileSync(join(bin, cmd), args, { stdio: 'pipe' });
  };
  run('initdb', ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C.UTF-8']);
  run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=''`, '-w', '-l', join(dir, 'log'), 'start']);
  baseUrl = `postgresql://postgres@/postgres?host=${dir}&port=${port}`;
  cleanup = () => {
    try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  };
}

function psql(url, args, input) {
  return spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args], { encoding: 'utf8', input });
}

const dbName = `videoai_test_${Date.now()}`;
let failed = 0;
let total = 0;
try {
  const r = psql(baseUrl, ['-c', `create database ${dbName}`]);
  if (r.status !== 0) throw new Error(r.stderr);
  const url = baseUrl.includes('/postgres?')
    ? baseUrl.replace('/postgres?', `/${dbName}?`)
    : baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

  const step = (label, file) => {
    const res = psql(url, ['-f', file]);
    if (res.status !== 0) {
      console.error(`✗ ${label}\n${res.stderr}`);
      return false;
    }
    console.log(`✓ ${label}`);
    return true;
  };

  if (!step('stub do Supabase', join(testsDir, '00_supabase_stub.sql'))) throw new Error('stub');
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (!step(`migração ${f}`, join(migrationsDir, f))) throw new Error(`migração ${f}`);
  }
  if (!step('helpers de teste', join(testsDir, '01_helpers.sql'))) throw new Error('helpers');

  const tests = readdirSync(testsDir).filter((f) => f.endsWith('.test.sql')).sort();
  total = tests.length;
  for (const t of tests) {
    // cada arquivo abre e reverte a própria transação (begin … rollback)
    const res = psql(url, ['-f', join(testsDir, t)]);
    if (res.status !== 0) {
      failed++;
      console.error(`✗ ${t}\n${res.stderr.split('\n').filter(Boolean).slice(0, 8).join('\n')}`);
    } else {
      const notes = (res.stderr.match(/NOTICE:\s+(.*)/g) || []).length;
      console.log(`✓ ${t}${notes ? ` (${notes} verificações)` : ''}`);
    }
  }
  psql(baseUrl, ['-c', `drop database if exists ${dbName} with (force)`]);
  console.log(`\n${total - failed}/${total} arquivos de teste do banco passaram${failed ? ' (com falhas)' : ''}.`);
} catch (e) {
  failed = failed || 1;
  console.error(String(e.message || e));
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
