/**
 * PROXY REVERSO (Cloudflare Workers, executando na borda)
 *
 * Este Worker e o unico ponto de entrada da aplicacao. Ele atende dois
 * hostnames e nunca devolve nada diretamente do disco:
 *
 *   app.trabaidafacul.site  -> FRONT-END
 *        Distribui os visitantes entre DUAS origens independentes (afinidade
 *        de sessao por hash do IP) e, se a origem escolhida falhar, reencaminha
 *        para a outra (failover). E o "mecanismo responsavel por distribuir o
 *        acesso".
 *
 *   api.trabaidafacul.site  -> BACK-END
 *        Aplica as regras de acesso (CORS, metodos, rotas, headers) e so
 *        entao encaminha para o Worker do Back-end via Service Binding.
 *        A chamada Service Binding NAO passa pela Internet.
 *
 * Tudo entra por HTTPS/443. A Cloudflare termina o TLS aqui.
 *
 * OBSERVABILIDADE (entrega 2): cada requisicao gera um evento JSON com rota
 * padronizada, status, duracao, origem atendida e motivo de bloqueio. O
 * identificador de correlacao (req_id) e criado aqui e repassado ao Back-end,
 * para o evento da API e o do banco poderem ser ligados a esta requisicao.
 */

import { criarLogger, normalizarRota, novoReqId } from '../../shared/log.js';

const FRONT_HOST = 'app.trabaidafacul.site';
const API_HOST = 'api.trabaidafacul.site';

const ALLOWED_ORIGIN = `https://${FRONT_HOST}`;
const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_API_PATHS = [/^\/todos$/, /^\/todos\/\d+$/, /^\/health$/];

const ORIGIN_TIMEOUT_MS = 5000;

// Codigos que realmente sao redirecionamento. O 304 fica de fora de proposito:
// e revalidacao de cache, nao redirecionamento.
const REDIRECIONAMENTOS = [301, 302, 303, 307, 308];

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Proxy': 'cloudflare-worker-reverse-proxy',
};

/**
 * AFINIDADE DE SESSAO
 *
 * Um site React nao e uma requisicao: e o HTML mais o CSS, o JS, o manifest e
 * os icones. Se cada uma dessas requisicoes fosse para uma origem diferente, a
 * pagina quebraria — nao seria balanceamento, seria mistura.
 *
 * Por isso a origem e escolhida pelo hash do IP do cliente: o mesmo visitante
 * cai sempre na mesma origem, e visitantes diferentes se distribuem entre as
 * duas. E a mesma tecnica do ip_hash do nginx, do balance source do HAProxy e
 * do sticky session do AWS ALB.
 */
function indiceDaOrigem(request, total) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = (hash * 31 + ip.charCodeAt(i)) >>> 0;
  }
  return hash % total;
}

const withHeaders = (response, extra) => {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
};

const deny = (motivo, status) =>
  new Response(JSON.stringify({ message: motivo, bloqueado_por: 'proxy-reverso' }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });

// ---------------------------------------------------------------------------
// FRONT-END: rodizio entre origens + failover
// ---------------------------------------------------------------------------

async function buscarOrigem(host, request, url) {
  const alvo = new URL(url.pathname + url.search, `https://${host}`);

  // Os headers do cliente sao repassados, menos o Host — que amarra a
  // requisicao ao hostname publico e faz a origem responder com redirecionamento
  // para o proprio dominio, vazando o endereco interno para o navegador.
  // Nada de X-Forwarded-*: provedores de hospedagem estatica usam esses headers
  // para decidir qual site servir, e um valor que eles nao reconhecem vira 401.
  const headers = new Headers(request.headers);
  headers.delete('host');

  const req = new Request(alvo, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    // 'follow': se a origem ainda assim redirecionar, o proxy resolve
    // internamente e devolve o conteudo final. O navegador continua em
    // app.trabaidafacul.site e nunca ve o endereco da origem.
    redirect: 'follow',
  });

  // O timeout vale APENAS ate a origem comecar a responder.
  //
  // Um AbortSignal.timeout() simples continuaria armado durante a transmissao
  // do corpo da resposta: numa carga lenta o timer dispararia no meio do envio
  // e o navegador receberia o HTML cortado — pagina em branco. Por isso o timer
  // e desarmado assim que os cabecalhos chegam, antes de repassar o corpo.
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(req, { signal: controle.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tratarFrontend(request, url, env, log) {
  const rota = normalizarRota(url.pathname);
  const inicio = Date.now();

  const origens = [env.ORIGIN_1, env.ORIGIN_2].filter(Boolean);
  if (origens.length === 0) {
    log.registrar('requisicao_front', {
      metodo: request.method, rota, status: 503, duracao_ms: 0,
      erro_tipo: 'sem_origem_configurada',
    });
    return deny('Nenhuma origem configurada', 503);
  }

  // Origem preferida deste visitante; as demais ficam como reserva na ordem.
  const escolhida = indiceDaOrigem(request, origens.length);
  const ordem = origens.map((_, i) => origens[(escolhida + i) % origens.length]);

  for (let i = 0; i < ordem.length; i++) {
    const host = ordem[i];
    try {
      const res = await buscarOrigem(host, request, url);

      // 5xx conta como origem doente -> tenta a proxima
      if (res.status >= 500) throw new Error(`origem respondeu ${res.status}`);

      // Redirecionamento que sobrou apos o follow tambem conta como origem
      // doente: nunca devolvemos ao navegador um Location apontando para fora.
      //
      // Atencao: nem todo 3xx e redirecionamento. O 304 (Not Modified) e a
      // resposta normal de revalidacao de cache — o navegador pergunta se o
      // arquivo que ele ja tem continua valido e a origem responde que sim.
      // Tratar 304 como falha derrubava as duas origens e devolvia 503 em
      // arquivos que estavam apenas em cache.
      if (REDIRECIONAMENTOS.includes(res.status)) {
        throw new Error(`origem redirecionou (${res.status})`);
      }

      log.registrar('requisicao_front', {
        metodo: request.method,
        rota,
        status: res.status,
        duracao_ms: Date.now() - inicio,
        origem_servida: host,
        failover: i > 0,
        tentativas: i + 1,
      });

      return withHeaders(res, {
        ...SECURITY_HEADERS,
        'X-Served-By': host,                       // qual origem atendeu
        'X-Failover': i === 0 ? 'nao' : 'sim',     // houve troca de origem?
        'X-Req-Id': log.reqId,
      });
    } catch (err) {
      // Evento por tentativa: e o que alimenta o painel de redundancia.
      log.registrar('origem_indisponivel', {
        rota,
        origem_servida: host,
        tentativa: i + 1,
        nivel: 'warn',
        erro_tipo: String(err && err.message),
      });
    }
  }

  log.registrar('requisicao_front', {
    metodo: request.method, rota, status: 503,
    duracao_ms: Date.now() - inicio,
    failover: true, tentativas: ordem.length,
    erro_tipo: 'todas_origens_indisponiveis',
  });

  return new Response('Todas as origens do Front-end estao indisponiveis.', {
    status: 503,
    headers: { ...SECURITY_HEADERS, 'X-Req-Id': log.reqId },
  });
}

// ---------------------------------------------------------------------------
// BACK-END: regras de acesso + encaminhamento por Service Binding
// ---------------------------------------------------------------------------

async function tratarApi(request, url, env, log) {
  const origin = request.headers.get('Origin');
  const rota = normalizarRota(url.pathname);
  const inicio = Date.now();

  const CORS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  // Registra e devolve uma resposta de bloqueio, com o motivo que o painel de
  // erros usa para separar falha de verdade de bloqueio proposital.
  const bloquear = (motivo_bloqueio, mensagem, status) => {
    log.registrar('requisicao_api', {
      metodo: request.method, rota, status,
      duracao_ms: Date.now() - inicio,
      motivo_bloqueio,
    });
    return withHeaders(deny(mensagem, status), { 'X-Req-Id': log.reqId });
  };

  // 1. Preflight
  if (request.method === 'OPTIONS') {
    if (origin && origin !== ALLOWED_ORIGIN) {
      return bloquear('origem_nao_autorizada', 'Origin nao autorizada', 403);
    }
    log.registrar('requisicao_api', {
      metodo: 'OPTIONS', rota, status: 204, duracao_ms: Date.now() - inicio,
    });
    return new Response(null, {
      status: 204,
      headers: { ...CORS, ...SECURITY_HEADERS, 'X-Req-Id': log.reqId },
    });
  }

  // 2. Allowlist de metodos
  if (!ALLOWED_METHODS.includes(request.method)) {
    return bloquear('metodo_nao_permitido', `Metodo ${request.method} nao permitido`, 405);
  }

  // 3. Allowlist de rotas — o que nao esta na lista nem chega no Back-end
  const rotaPermitida = ALLOWED_API_PATHS.some((re) => re.test(url.pathname));
  if (!rotaPermitida) return bloquear('rota_nao_permitida', 'Rota nao permitida', 403);

  // 4. CORS restrito: no navegador, so o Front-end oficial pode chamar a API.
  //    Requisicoes sem header Origin (curl, Postman) seguem permitidas — sao
  //    elas que comprovam o requisito "acesso ao Back-end atraves do dominio".
  if (origin && origin !== ALLOWED_ORIGIN) {
    return bloquear('origem_nao_autorizada', `Origin ${origin} nao autorizada`, 403);
  }

  // 5. Encaminha por Service Binding. Esta chamada nao passa pela Internet:
  //    e uma invocacao interna Worker -> Worker dentro da Cloudflare.
  //    O req_id vai junto, para o Back-end registrar os eventos dele com o
  //    mesmo identificador desta requisicao.
  const headers = new Headers(request.headers);
  headers.set('X-Req-Id', log.reqId);
  // Clona a requisicao trocando so os headers — assim o corpo continua sendo o
  // mesmo stream, sem precisar ser lido e remontado aqui.
  const interna = new Request(request, { headers });

  const res = await env.API.fetch(interna);

  log.registrar('requisicao_api', {
    metodo: request.method, rota, status: res.status,
    duracao_ms: Date.now() - inicio,
    upstream: 'service-binding',
  });

  return withHeaders(res, {
    ...CORS, ...SECURITY_HEADERS,
    'X-Upstream': 'service-binding',
    'X-Req-Id': log.reqId,
  });
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reqId = novoReqId();

    // Separa trafego de sonda de trafego de gente de verdade, para o painel de
    // uso nao contar as checagens do monitor como uso da aplicacao.
    const trafego = request.headers.get('X-Origem-Trafego') === 'monitor'
      ? 'monitor'
      : 'usuario';

    const log = criarLogger('proxy', env, reqId, {
      trafego,
      pais: request.headers.get('CF-IPCountry') || null, // sem IP completo
    });

    let resposta;
    try {
      if (url.hostname === API_HOST) {
        resposta = await tratarApi(request, url, env, log);
      } else if (url.hostname === FRONT_HOST) {
        resposta = await tratarFrontend(request, url, env, log);
      } else {
        // Dominio raiz -> manda para o Front-end
        resposta = Response.redirect(
          `https://${FRONT_HOST}${url.pathname}${url.search}`,
          301,
        );
      }
    } catch (err) {
      log.registrar('erro_proxy', {
        rota: normalizarRota(url.pathname), status: 500,
        erro_tipo: String(err && err.message), nivel: 'error',
      });
      resposta = new Response('Erro interno no proxy.', {
        status: 500, headers: SECURITY_HEADERS,
      });
    }

    // Envio dos eventos depois da resposta ja ter saido.
    await log.despachar(ctx);
    return resposta;
  },
};
