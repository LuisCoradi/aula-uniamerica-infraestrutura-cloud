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
check('Front faz failover quando a origem preferida cai',
  r.status === 200 && r.headers.get('X-Served-By') === 'origem-2.exemplo' && r.headers.get('X-Failover') === 'sim',
  `tentou: ${tentativas.join(' -> ')}`);


// 10. Regressao: 304 (Not Modified) NAO pode ser tratado como origem doente
{
  const vistos = [];
  globalThis.fetch = async (req) => {
    vistos.push(new URL(req.url).hostname);
    return new Response(null, { status: 304, headers: { ETag: '"abc"' } });
  };
  const r304 = await call(`${FRONT}/static/css/main.css`);
  check('304 da origem passa direto para o navegador',
    r304.status === 304 && r304.headers.get('ETag') === '"abc"',
    `status ${r304.status}, origens tentadas: ${vistos.length}`);
  check('304 nao dispara failover', vistos.length === 1);
}

// 11. Redirecionamento de verdade continua derrubando a origem
{
  const vistos = [];
  globalThis.fetch = async (req) => {
    const host = new URL(req.url).hostname;
    vistos.push(host);
    if (host === 'origem-1.exemplo') {
      return new Response(null, { status: 301, headers: { Location: 'https://outro.site/' } });
    }
    return new Response('<h1>ok</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  const r301 = await call(`${FRONT}/`);
  check('301 da origem ainda dispara failover',
    r301.status === 200 && r301.headers.get('X-Failover') === 'sim',
    `origens tentadas: ${vistos.join(' -> ')}`);
}

// ---------------------------------------------------------------------------
// OBSERVABILIDADE (entrega 2)
// ---------------------------------------------------------------------------

const fetchOriginal = globalThis.fetch;

/** Captura as linhas JSON que os Workers escrevem no console durante uma acao. */
async function capturarLogs(acao) {
  const original = console.log;
  const linhas = [];
  console.log = (msg) => {
    try { linhas.push(JSON.parse(msg)); } catch { /* linha nao estruturada */ }
  };
  try {
    const resultado = await acao();
    return { linhas, resultado };
  } finally {
    console.log = original;
  }
}

// 12. Requisicao valida gera evento no proxy e no back-end, com correlacao
{
  globalThis.fetch = fetchOriginal;
  const { linhas, resultado } = await capturarLogs(() =>
    call(`${API}/todos`, { headers: { Origin: FRONT } }));

  const evProxy = linhas.find((l) => l.evento === 'requisicao_api');
  const evNegocio = linhas.find((l) => l.evento === 'operacao_negocio');
  const evBanco = linhas.find((l) => l.evento === 'consulta_banco');

  check('Proxy registra evento requisicao_api', !!evProxy && evProxy.servico === 'proxy',
    evProxy && JSON.stringify({ rota: evProxy.rota, status: evProxy.status }));
  check('Back-end registra operacao de negocio e consulta ao banco',
    !!evNegocio && !!evBanco && evBanco.ok === true,
    evBanco && `operacao=${evBanco.operacao}`);
  check('req_id correlaciona os eventos do proxy e do back-end',
    !!evProxy && !!evBanco && evProxy.req_id === evBanco.req_id,
    evProxy && evProxy.req_id);
  check('Evento tem os campos obrigatorios do formato',
    !!evProxy && ['ts', 'servico', 'ambiente', 'nivel', 'evento', 'req_id'].every((c) => c in evProxy));
  check('Resposta devolve o X-Req-Id para evidencia',
    resultado.headers.get('X-Req-Id') === evProxy.req_id);
}

// 13. Rota com id vira rota padronizada (senao cada tarefa vira uma serie)
{
  const { linhas } = await capturarLogs(() =>
    call(`${API}/todos/1`, { method: 'PATCH', headers: { Origin: FRONT } }));
  const ev = linhas.find((l) => l.evento === 'requisicao_api');
  check('Rota /todos/1 e registrada como /todos/:id', ev && ev.rota === '/todos/:id', ev && ev.rota);
  await call(`${API}/todos/1`, { method: 'PATCH', headers: { Origin: FRONT } }); // desfaz
}

// 14. Bloqueio proposital e registrado com o motivo (separa erro de bloqueio)
{
  const { linhas } = await capturarLogs(() =>
    call(`${API}/admin`, { headers: { Origin: FRONT } }));
  const ev = linhas.find((l) => l.evento === 'requisicao_api');
  check('Bloqueio registra motivo_bloqueio',
    ev && ev.status === 403 && ev.motivo_bloqueio === 'rota_nao_permitida',
    ev && ev.motivo_bloqueio);
}

// 15. Trafego do monitor nao se mistura com trafego de usuario
{
  const { linhas } = await capturarLogs(() =>
    call(`${API}/health`, { headers: { 'X-Origem-Trafego': 'monitor' } }));
  const ev = linhas.find((l) => l.evento === 'requisicao_api');
  check('Requisicao do monitor e marcada como trafego=monitor',
    ev && ev.trafego === 'monitor', ev && ev.trafego);
}

// 16. Failover gera evento origem_indisponivel para o painel de redundancia
{
  globalThis.fetch = async (req) => {
    const host = new URL(req.url).hostname;
    if (host === 'origem-1.exemplo') throw new Error('origem 1 fora do ar');
    return new Response('<h1>ok</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  const { linhas } = await capturarLogs(() => call(`${FRONT}/`));
  const queda = linhas.find((l) => l.evento === 'origem_indisponivel');
  const front = linhas.find((l) => l.evento === 'requisicao_front');
  check('Queda de origem gera evento origem_indisponivel',
    !!queda && queda.nivel === 'warn', queda && queda.erro_tipo);
  check('Evento do front registra origem servida e failover',
    front && front.failover === true && front.origem_servida === 'origem-2.exemplo',
    front && `${front.origem_servida} / tentativas=${front.tentativas}`);
  globalThis.fetch = fetchOriginal;
}

// 17. Envio para o Loki: formato que o Grafana Cloud exige
{
  const { criarLogger } = await import('./shared/log.js');
  let enviado = null;
  globalThis.fetch = async (url, init) => {
    enviado = { url, init };
    return new Response(null, { status: 204 });
  };

  const envLoki = {
    LOKI_URL: 'https://logs-prod-000.grafana.net/loki/api/v1/push',
    LOKI_USER: '123456',
    LOKI_TOKEN: 'token-de-teste',
  };
  const log = criarLogger('proxy', envLoki, 'req-teste');
  await capturarLogs(async () => {
    log.registrar('requisicao_api', { rota: '/todos', status: 200, duracao_ms: 12 });
    log.registrar('consulta_banco', { operacao: 'listar_tarefas', ok: true, duracao_ms: 3 });
    await log.enviar();
  });

  const corpo = enviado && JSON.parse(enviado.init.body);
  const valores = corpo && corpo.streams[0].values;

  check('Envia para a URL do Loki com Content-Type json',
    !!enviado && enviado.init.headers['Content-Type'] === 'application/json');
  check('Usa Basic Auth com usuario e token',
    !!enviado && enviado.init.headers.Authorization === 'Basic ' + btoa('123456:token-de-teste'));
  check('Timestamp vai como STRING em nanossegundos (numero devolve 400 no Loki)',
    !!valores && typeof valores[0][0] === 'string' && valores[0][0].length >= 19,
    valores && valores[0][0]);
  check('Labels do stream so com baixa cardinalidade',
    corpo && Object.keys(corpo.streams[0].stream).sort().join(',') === 'ambiente,aplicacao,servico',
    corpo && JSON.stringify(corpo.streams[0].stream));
  check('Os dois eventos vao no mesmo lote', valores && valores.length === 2);

  globalThis.fetch = fetchOriginal;
}

// 18. Sem credenciais configuradas, nada e enviado e nada quebra
{
  const { criarLogger } = await import('./shared/log.js');
  let chamou = false;
  globalThis.fetch = async () => { chamou = true; return new Response(null); };
  const log = criarLogger('proxy', {}, 'req-teste');
  await capturarLogs(async () => {
    log.registrar('requisicao_api', { rota: '/todos', status: 200 });
    await log.enviar();
  });
  check('Sem LOKI_URL o envio e ignorado em silencio', chamou === false);
  globalThis.fetch = fetchOriginal;
}

console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
