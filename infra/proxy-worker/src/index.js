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
 */

const FRONT_HOST = 'app.trabaidafacul.site';
const API_HOST = 'api.trabaidafacul.site';

const ALLOWED_ORIGIN = `https://${FRONT_HOST}`;
const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_API_PATHS = [/^\/todos$/, /^\/todos\/\d+$/, /^\/health$/];

const ORIGIN_TIMEOUT_MS = 5000;

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
  return fetch(req, { signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS) });
}

async function tratarFrontend(request, url, env) {
  const origens = [env.ORIGIN_1, env.ORIGIN_2].filter(Boolean);
  if (origens.length === 0) return deny('Nenhuma origem configurada', 503);

  // Origem preferida deste visitante; as demais ficam como reserva na ordem.
  const inicio = indiceDaOrigem(request, origens.length);
  const ordem = origens.map((_, i) => origens[(inicio + i) % origens.length]);

  for (let i = 0; i < ordem.length; i++) {
    const host = ordem[i];
    try {
      const res = await buscarOrigem(host, request, url);

      // 5xx conta como origem doente -> tenta a proxima
      if (res.status >= 500) throw new Error(`origem respondeu ${res.status}`);

      // Redirecionamento que sobrou apos o follow tambem conta como origem
      // doente: nunca devolvemos ao navegador um Location apontando para fora.
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`origem redirecionou (${res.status})`);
      }

      return withHeaders(res, {
        ...SECURITY_HEADERS,
        'X-Served-By': host,                       // qual origem atendeu
        'X-Failover': i === 0 ? 'nao' : 'sim',     // houve troca de origem?
      });
    } catch (err) {
      console.warn(`Origem ${host} indisponivel: ${err.message}`);
    }
  }

  return new Response('Todas as origens do Front-end estao indisponiveis.', {
    status: 503,
    headers: SECURITY_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// BACK-END: regras de acesso + encaminhamento por Service Binding
// ---------------------------------------------------------------------------

async function tratarApi(request, url, env) {
  const origin = request.headers.get('Origin');

  const CORS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  // 1. Preflight
  if (request.method === 'OPTIONS') {
    if (origin && origin !== ALLOWED_ORIGIN) return deny('Origin nao autorizada', 403);
    return new Response(null, { status: 204, headers: { ...CORS, ...SECURITY_HEADERS } });
  }

  // 2. Allowlist de metodos
  if (!ALLOWED_METHODS.includes(request.method)) {
    return deny(`Metodo ${request.method} nao permitido`, 405);
  }

  // 3. Allowlist de rotas — o que nao esta na lista nem chega no Back-end
  const rotaPermitida = ALLOWED_API_PATHS.some((re) => re.test(url.pathname));
  if (!rotaPermitida) return deny('Rota nao permitida', 403);

  // 4. CORS restrito: no navegador, so o Front-end oficial pode chamar a API.
  //    Requisicoes sem header Origin (curl, Postman) seguem permitidas — sao
  //    elas que comprovam o requisito "acesso ao Back-end atraves do dominio".
  if (origin && origin !== ALLOWED_ORIGIN) {
    return deny(`Origin ${origin} nao autorizada`, 403);
  }

  // 5. Encaminha por Service Binding. Esta chamada nao passa pela Internet:
  //    e uma invocacao interna Worker -> Worker dentro da Cloudflare.
  const res = await env.API.fetch(request);

  return withHeaders(res, { ...CORS, ...SECURITY_HEADERS, 'X-Upstream': 'service-binding' });
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === API_HOST) return tratarApi(request, url, env);
    if (url.hostname === FRONT_HOST) return tratarFrontend(request, url, env);

    // Dominio raiz -> manda para o Front-end
    return Response.redirect(`https://${FRONT_HOST}${url.pathname}${url.search}`, 301);
  },
};
