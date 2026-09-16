/**
 * MONITOR DE DISPONIBILIDADE (Cloudflare Worker + Cron Trigger)
 *
 * A cada minuto este Worker faz uma checagem pelo DOMINIO PUBLICO — a mesma
 * porta de entrada que um usuario usaria — e registra o resultado como evento
 * JSON. E o que alimenta o painel "a aplicacao esta acessivel pelo dominio?".
 *
 * Por que existe: o Health Check gerenciado da Cloudflare so esta disponivel a
 * partir do plano Pro. Esta checagem faz o mesmo papel dentro do plano free,
 * com a vantagem de ficar versionada no repositorio junto com o resto.
 *
 * As requisicoes levam o header X-Origem-Trafego: monitor, para o proxy marcar
 * o evento e os paineis de uso nao confundirem trafego de sonda com trafego de
 * usuario.
 *
 * Limitacao a documentar: a checagem parte de dentro da rede da Cloudflare.
 * Ela prova que o dominio responde e que o caminho interno esta de pe, mas nao
 * mede a experiencia de rede de um usuario em casa.
 */

import { criarLogger, novoReqId } from '../../shared/log.js';

const TIMEOUT_MS = 8000;

async function checar(log, nome, url, esperado = 200) {
  const inicio = Date.now();
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controle.signal,
      headers: { 'X-Origem-Trafego': 'monitor' },
      cf: { cacheTtl: 0 },
    });
    // O corpo precisa ser consumido para a duracao refletir a resposta inteira.
    await res.text();

    log.registrar('checagem_disponibilidade', {
      alvo: nome,
      url,
      status: res.status,
      ok: res.status === esperado,
      duracao_ms: Date.now() - inicio,
      origem_servida: res.headers.get('X-Served-By') || null,
      failover: res.headers.get('X-Failover') === 'sim',
      nivel: res.status === esperado ? 'info' : 'error',
    });
  } catch (err) {
    log.registrar('checagem_disponibilidade', {
      alvo: nome,
      url,
      status: 0,
      ok: false,
      duracao_ms: Date.now() - inicio,
      nivel: 'error',
      erro_tipo: String(err && err.message),
    });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const log = criarLogger('monitor', env, novoReqId());

    await Promise.all([
      checar(log, 'front', env.ALVO_FRONT),
      checar(log, 'api', env.ALVO_API),
    ]);

    ctx.waitUntil(log.enviar());
  },

  // Permite disparar a checagem manualmente durante os testes, sem esperar o
  // cron. Este Worker nao tem hostname publico, entao so roda por
  // "wrangler dev" ou pelo botao de teste no painel da Cloudflare.
  async fetch(request, env, ctx) {
    const log = criarLogger('monitor', env, novoReqId());
    await Promise.all([
      checar(log, 'front', env.ALVO_FRONT),
      checar(log, 'api', env.ALVO_API),
    ]);
    await log.despachar(ctx);
    return new Response(JSON.stringify(log.eventos, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
