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
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** Converte a linha do SQLite no formato que o front-end ja espera. */
const rowToTodo = (row) => ({
  _id: String(row.id),
  text: row.text,
  completed: row.completed === 1,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    try {
      // Health check — usado pelo proxy e pela evidencia "Back-end acessa o Banco"
      if (path === '/health') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM todos').first();
        return json({
          status: 'ok',
          servico: 'back-end',
          banco: 'D1 (acesso por binding, sem rede publica)',
          total_tarefas: row.total,
        });
      }

      // GET /todos — lista todas as tarefas
      if (path === '/todos' && method === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT id, text, completed FROM todos ORDER BY id')
          .all();
        return json(results.map(rowToTodo));
      }

      // POST /todos — cria uma tarefa
      if (path === '/todos' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const text = typeof body.text === 'string' ? body.text.trim() : '';

        if (!text) return json({ message: 'O campo "text" e obrigatorio' }, 400);
        if (text.length > 500) return json({ message: 'Texto muito longo' }, 400);

        const row = await env.DB
          .prepare('INSERT INTO todos (text, completed) VALUES (?, 0) RETURNING id, text, completed')
          .bind(text)
          .first();
        return json(rowToTodo(row), 201);
      }

      const match = path.match(/^\/todos\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);

        // PATCH /todos/:id — alterna concluida/nao concluida
        if (method === 'PATCH') {
          const row = await env.DB
            .prepare('UPDATE todos SET completed = 1 - completed WHERE id = ? RETURNING id, text, completed')
            .bind(id)
            .first();
          if (!row) return json({ message: 'Tarefa nao encontrada' }, 404);
          return json(rowToTodo(row));
        }

        // DELETE /todos/:id — exclui
        if (method === 'DELETE') {
          const row = await env.DB
            .prepare('DELETE FROM todos WHERE id = ? RETURNING id')
            .bind(id)
            .first();
          if (!row) return json({ message: 'Tarefa nao encontrada' }, 404);
          return json({ message: 'Tarefa excluida com sucesso' });
        }

        return json({ message: 'Metodo nao permitido' }, 405);
      }

      return json({ message: 'Rota nao encontrada' }, 404);
    } catch (err) {
      console.error('Erro no back-end:', err);
      return json({ message: 'Erro interno no servidor' }, 500);
    }
  },
};
