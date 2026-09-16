/**
 * BACK-END — API de tarefas (Cloudflare Worker + D1)
 *
 * Equivalente serverless do backend/index.js original (Express + Mongoose).
 * As mesmas 4 rotas, o mesmo contrato de resposta.
 *
 * SEGURANÇA — este Worker NAO tem endereco publico:
 *   - workers_dev = false  -> nao existe *.workers.dev
 *   - sem "routes"         -> nenhum hostname do dominio aponta para ele
 *   Ele so pode ser invocado por Service Binding, vindo do Worker de proxy
 *   reverso. Nao existe URL na Internet capaz de alcancar este codigo.
 *
 * O acesso ao banco (D1) e feito por binding (env.DB). O D1 nao expoe
 * endpoint de rede: nao ha host, porta ou string de conexao para vazar.
 *
 * OBSERVABILIDADE (entrega 2): cada rota gera dois eventos — a operacao de
 * negocio (listar, criar, concluir, reabrir, excluir) e a consulta ao banco,
 * com duracao e resultado. Os dois carregam o req_id que veio do proxy.
 */

import { criarLogger } from '../../shared/log.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** Converte a linha do SQLite no formato que o front-end ja espera. */
const rowToTodo = (row) => ({
  _id: String(row.id),
  text: row.text,
  completed: row.completed === 1,
});

/**
 * Executa uma consulta no D1 medindo duracao e resultado.
 *
 * Limitacao conhecida, que vale documentar: dentro de um Worker o relogio so
 * avanca depois de uma operacao de entrada/saida. Como a consulta ao D1 e uma
 * operacao dessas, a medicao funciona, mas e grossa — serve para comparar
 * ordens de grandeza e detectar degradacao, nao para cravar milissegundos.
 */
async function consultar(log, operacao, executar) {
  const inicio = Date.now();
  try {
    const resultado = await executar();
    log.registrar('consulta_banco', {
      operacao,
      banco: 'trabaidafacul-db',
      ok: true,
      duracao_ms: Date.now() - inicio,
    });
    return resultado;
  } catch (err) {
    log.registrar('consulta_banco', {
      operacao,
      banco: 'trabaidafacul-db',
      ok: false,
      duracao_ms: Date.now() - inicio,
      nivel: 'error',
      erro_tipo: String(err && err.message),
    });
    throw err;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    // O req_id vem do proxy; se por algum motivo nao vier, o evento continua
    // sendo registrado, so nao da para correlacionar.
    const reqId = request.headers.get('X-Req-Id') || 'sem-correlacao';
    const log = criarLogger('api', env, reqId);

    const responder = async (resposta, operacao, extra = {}) => {
      log.registrar('operacao_negocio', {
        operacao,
        metodo: method,
        rota: path.replace(/\/\d+$/, '/:id'),
        status: resposta.status,
        ...extra,
      });
      await log.despachar(ctx);
      return resposta;
    };

    try {
      // Health check — usado pelo proxy, pelo monitor de disponibilidade e como
      // evidencia de que o Back-end alcanca o Banco.
      if (path === '/health') {
        const row = await consultar(log, 'contar_tarefas', () =>
          env.DB.prepare('SELECT COUNT(*) AS total FROM todos').first());
        return responder(json({
          status: 'ok',
          servico: 'back-end',
          banco: 'D1 (acesso por binding, sem rede publica)',
          total_tarefas: row.total,
        }), 'health');
      }

      // GET /todos — lista todas as tarefas
      if (path === '/todos' && method === 'GET') {
        const { results } = await consultar(log, 'listar_tarefas', () =>
          env.DB.prepare('SELECT id, text, completed FROM todos ORDER BY id').all());
        return responder(json(results.map(rowToTodo)), 'listar', {
          quantidade: results.length,
        });
      }

      // POST /todos — cria uma tarefa
      if (path === '/todos' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const text = typeof body.text === 'string' ? body.text.trim() : '';

        if (!text) {
          return responder(json({ message: 'O campo "text" e obrigatorio' }, 400),
            'criar', { erro_tipo: 'texto_vazio' });
        }
        if (text.length > 500) {
          return responder(json({ message: 'Texto muito longo' }, 400),
            'criar', { erro_tipo: 'texto_longo' });
        }

        const row = await consultar(log, 'inserir_tarefa', () =>
          env.DB
            .prepare('INSERT INTO todos (text, completed) VALUES (?, 0) RETURNING id, text, completed')
            .bind(text)
            .first());
        return responder(json(rowToTodo(row), 201), 'criar');
      }

      const match = path.match(/^\/todos\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);

        // PATCH /todos/:id — alterna concluida/nao concluida
        if (method === 'PATCH') {
          const row = await consultar(log, 'alternar_tarefa', () =>
            env.DB
              .prepare('UPDATE todos SET completed = 1 - completed WHERE id = ? RETURNING id, text, completed')
              .bind(id)
              .first());
          if (!row) {
            return responder(json({ message: 'Tarefa nao encontrada' }, 404),
              'alternar', { erro_tipo: 'nao_encontrada' });
          }
          return responder(json(rowToTodo(row)),
            row.completed === 1 ? 'concluir' : 'reabrir');
        }

        // DELETE /todos/:id — exclui
        if (method === 'DELETE') {
          const row = await consultar(log, 'excluir_tarefa', () =>
            env.DB
              .prepare('DELETE FROM todos WHERE id = ? RETURNING id')
              .bind(id)
              .first());
          if (!row) {
            return responder(json({ message: 'Tarefa nao encontrada' }, 404),
              'excluir', { erro_tipo: 'nao_encontrada' });
          }
          return responder(json({ message: 'Tarefa excluida com sucesso' }), 'excluir');
        }

        return responder(json({ message: 'Metodo nao permitido' }, 405),
          'metodo_invalido');
      }

      return responder(json({ message: 'Rota nao encontrada' }, 404), 'rota_invalida');
    } catch (err) {
      console.error('Erro no back-end:', err);
      log.registrar('erro_api', {
        rota: path, status: 500, nivel: 'error',
        erro_tipo: String(err && err.message),
      });
      await log.despachar(ctx);
      return json({ message: 'Erro interno no servidor' }, 500);
    }
  },
};
