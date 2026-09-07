/**
 * Teste local do Worker da API contra um SQLite em memoria, simulando o D1.
 * Uso: node --experimental-sqlite teste-local.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import api from './api-worker/src/index.js';
import proxy from './proxy-worker/src/index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync('./api-worker/schema.sql', 'utf8'));

// Stub minimo da API do D1
const D1 = {
  prepare(sql) {
    const stmt = { sql, args: [] };
    stmt.bind = (...a) => { stmt.args = a; return stmt; };
    stmt.first = async () => {
      const s = db.prepare(sql);
      const r = sql.trim().toUpperCase().startsWith('SELECT')
        ? s.get(...stmt.args)
        : s.all(...stmt.args)[0];
      return r ?? null;
    };
    stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args) });
    return stmt;
  },
};

const env = {
  DB: D1,
  API: { fetch: (req) => api.fetch(req, { DB: D1 }) },
  ORIGIN_1: 'origem-1.exemplo',
  ORIGIN_2: 'origem-2.exemplo',
};

let falhas = 0;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FALHA'}  ${nome}${extra ? '  ->  ' + extra : ''}`);
  if (!ok) falhas++;
};

const call = (url, init) => proxy.fetch(new Request(url, init), env);
const API = 'https://api.trabaidafacul.site';
const FRONT = 'https://app.trabaidafacul.site';

// 1. GET /todos com o seed
let r = await call(`${API}/todos`);
let body = await r.json();
check('GET /todos retorna as 3 tarefas do seed', r.status === 200 && body.length === 3, JSON.stringify(body[0]));
check('GET /todos aplica CORS restrito',
  r.headers.get('Access-Control-Allow-Origin') === FRONT);
check('GET /todos passa por Service Binding', r.headers.get('X-Upstream') === 'service-binding');

// 2. POST /todos
r = await call(`${API}/todos`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: FRONT },
  body: JSON.stringify({ text: 'Entregar o trabalho' }),
});
const criada = await r.json();
check('POST /todos cria tarefa', r.status === 201 && criada.text === 'Entregar o trabalho', JSON.stringify(criada));

// 3. POST sem texto
r = await call(`${API}/todos`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
check('POST sem "text" retorna 400', r.status === 400);

// 4. PATCH alterna
r = await call(`${API}/todos/${criada._id}`, { method: 'PATCH' });
let patched = await r.json();
check('PATCH alterna completed para true', r.status === 200 && patched.completed === true);
r = await call(`${API}/todos/${criada._id}`, { method: 'PATCH' });
patched = await r.json();
check('PATCH alterna completed de volta para false', patched.completed === false);

// 5. DELETE
r = await call(`${API}/todos/${criada._id}`, { method: 'DELETE' });
check('DELETE remove a tarefa', r.status === 200);
r = await call(`${API}/todos/${criada._id}`, { method: 'DELETE' });
check('DELETE em id inexistente retorna 404', r.status === 404);

// 6. Regras de acesso do proxy
r = await call(`${API}/todos`, { headers: { Origin: 'https://site-malicioso.com' } });
check('Origin nao autorizada e bloqueada com 403', r.status === 403);

r = await call(`${API}/admin`);
check('Rota fora da allowlist e bloqueada com 403', r.status === 403);

r = await call(`${API}/todos`, { method: 'PUT' });
check('Metodo PUT e bloqueado com 405', r.status === 405);

r = await call(`${API}/todos`, { method: 'OPTIONS', headers: { Origin: FRONT } });
check('Preflight OPTIONS da origem valida retorna 204', r.status === 204);

// 7. Health (prova de que o Back-end alcanca o Banco)
r = await call(`${API}/health`);
const health = await r.json();
check('GET /health confirma acesso ao banco', r.status === 200 && typeof health.total_tarefas === 'number', JSON.stringify(health));

// 8. Headers de seguranca
check('HSTS presente na resposta', !!r.headers.get('Strict-Transport-Security'));

// 9. Redundancia do front: rodizio e failover
const tentativas = [];
globalThis.fetch = async (req) => {
  const host = new URL(req.url).hostname;
  tentativas.push(host);
  if (host === 'origem-1.exemplo') throw new Error('origem 1 fora do ar');
  return new Response('<h1>Lista de Tarefas</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
r = await call(`${FRONT}/`);
check('Front faz failover quando a origem 1 cai',
  r.status === 200 && r.headers.get('X-Served-By') === 'origem-2.exemplo' && r.headers.get('X-Failover') === 'sim',
  `tentou: ${tentativas.join(' -> ')}`);

console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
