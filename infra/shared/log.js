/**
 * OBSERVABILIDADE — geracao e envio dos logs estruturados
 *
 * Um evento = uma linha JSON. Os mesmos campos valem para os tres Workers
 * (proxy, back-end e monitor), para os paineis poderem cruzar os dados.
 *
 * O evento sai por dois caminhos, de proposito:
 *
 *   1. console.log(JSON)  -> Cloudflare Workers Logs. E a fonte do proprio
 *      provedor: serve de comparacao e prova de que o dado do painel e o mesmo
 *      que a Cloudflare registrou. Retencao de 3 dias no plano free.
 *
 *   2. POST HTTP          -> Grafana Cloud (Loki). E a fonte dos paineis:
 *      retencao maior e a definicao do dashboard pode ser exportada em JSON.
 *
 * Se as credenciais do Loki nao estiverem configuradas, o caminho 2 e ignorado
 * em silencio e o caminho 1 continua funcionando. Nenhuma requisicao do usuario
 * quebra por causa de log.
 *
 * O que NAO entra no log: senha, token, credencial, string de conexao, corpo da
 * requisicao e IP completo do visitante.
 */

const AMBIENTE = 'producao';

/**
 * Normaliza a rota para virar dimensao de painel.
 * Sem isso cada id de tarefa viraria uma serie diferente no grafico.
 */
export function normalizarRota(pathname) {
  if (/^\/todos\/\d+$/.test(pathname)) return '/todos/:id';
  if (pathname === '/todos' || pathname === '/health') return pathname;
  if (pathname === '/' || pathname === '/index.html') return '/ (pagina)';
  if (/\.(js|mjs)$/.test(pathname)) return '/estatico/js';
  if (/\.css$/.test(pathname)) return '/estatico/css';
  if (/\.(png|jpg|jpeg|svg|ico|webp)$/.test(pathname)) return '/estatico/imagem';
  if (/\.(json|txt|webmanifest)$/.test(pathname)) return '/estatico/manifesto';
  return '/outros';
}

/**
 * Cria o coletor de eventos de uma invocacao.
 *
 * @param {string} servico  'proxy' | 'api' | 'monitor'
 * @param {object} env      bindings e variaveis do Worker
 * @param {string} reqId    identificador para correlacionar os eventos da mesma
 *                          requisicao entre o proxy e o back-end
 */
export function criarLogger(servico, env, reqId, base = {}) {
  const eventos = [];

  const registrar = (evento, campos = {}) => {
    const linha = {
      ts: new Date().toISOString(),
      servico,
      ambiente: AMBIENTE,
      nivel: campos.nivel || (campos.status >= 500 || campos.erro_tipo ? 'error'
        : campos.status >= 400 ? 'warn' : 'info'),
      evento,
      req_id: reqId,
      ...base,
      ...campos,
    };
    delete linha.nivel_extra;

    // Caminho 1 — Workers Logs (a Cloudflare indexa cada campo do JSON)
    console.log(JSON.stringify(linha));

    eventos.push(linha);
    return linha;
  };

  /**
   * Caminho 2 — envia o lote para o Loki do Grafana Cloud.
   *
   * Detalhes que o Loki exige e que quebram silenciosamente se errados:
   *   - Content-Type: application/json (o padrao dele e protobuf)
   *   - timestamp em NANOSSEGUNDOS e como STRING (numero devolve 400)
   *   - labels do stream so com baixa cardinalidade. Os campos de alta
   *     cardinalidade (req_id, rota, status) ficam DENTRO da linha JSON e sao
   *     extraidos no painel com o parser | json do LogQL.
   */
  const enviar = async () => {
    const url = env.LOKI_URL;
    const usuario = env.LOKI_USER;
    const token = env.LOKI_TOKEN;
    if (!url || !usuario || !token || eventos.length === 0) return;

    const base = Date.now() * 1_000_000;
    const corpo = {
      streams: [
        {
          stream: { servico, ambiente: AMBIENTE, aplicacao: 'trabaidafacul' },
          values: eventos.map((e, i) => [String(base + i), JSON.stringify(e)]),
        },
      ],
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa(`${usuario}:${token}`),
        },
        body: JSON.stringify(corpo),
      });
      if (!res.ok) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(), servico, ambiente: AMBIENTE, nivel: 'warn',
          evento: 'falha_envio_observabilidade', status: res.status,
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), servico, ambiente: AMBIENTE, nivel: 'warn',
        evento: 'falha_envio_observabilidade', erro_tipo: String(err && err.message),
      }));
    }
  };

  /**
   * Agenda o envio para depois da resposta ja ter sido devolvida ao usuario.
   * Sem ctx (teste local), envia na hora.
   */
  const despachar = (ctx) => {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(enviar());
    else return enviar();
  };

  return { reqId, registrar, enviar, despachar, eventos };
}

/** Identificador de correlacao. */
export const novoReqId = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `r${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
