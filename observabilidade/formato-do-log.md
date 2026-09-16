# Formato do log e caminho do dado

## Onde o registro é gerado

Os três Workers geram os eventos. O módulo `infra/shared/log.js` é o único lugar
que monta e envia a linha — os Workers só chamam `registrar(evento, campos)`.

| Serviço | Eventos que gera |
|---|---|
| `proxy` | `requisicao_front`, `requisicao_api`, `origem_indisponivel`, `erro_proxy` |
| `api` | `operacao_negocio`, `consulta_banco`, `erro_api` |
| `monitor` | `checagem_disponibilidade` |

## Como é coletado e encaminhado

Cada evento sai por dois caminhos, de propósito:

1. `console.log(JSON)` → **Cloudflare Workers Logs**. É a fonte do próprio
   provedor. Retenção de 3 dias no plano free. Serve de comparação e prova de
   que o dado do painel é o mesmo que a Cloudflare registrou.
2. `POST` HTTPS → **Grafana Cloud (Loki)**. É a fonte dos painéis. Os eventos de
   uma invocação são acumulados e enviados em um único POST dentro de
   `ctx.waitUntil()`, ou seja, depois da resposta já ter sido devolvida ao
   usuário. Retenção de 14 dias no plano free.

Se as credenciais do Loki não estiverem configuradas, o caminho 2 é ignorado em
silêncio. Nenhuma requisição do usuário falha por causa de log.

```
Worker (proxy | api | monitor)
      │  console.log(JSON)  ─────────────►  Cloudflare Workers Logs   (3 dias)
      └─ POST /loki/api/v1/push  ────────►  Grafana Cloud / Loki      (14 dias)
                                                    │
                                                    └──► painéis no Grafana
```

## Onde fica armazenado, por quanto tempo e quem consulta

| | Workers Logs | Grafana Cloud (Loki) |
|---|---|---|
| Armazenamento | Cloudflare, conta do grupo | Grafana Cloud, stack do grupo |
| Retenção | 3 dias (plano free) | 14 dias (plano free) |
| Quem consulta | quem tem acesso à conta Cloudflare | quem tem login no stack do Grafana |
| Controle de acesso | login da conta Cloudflare | login do Grafana Cloud; a escrita usa token de Access Policy com permissão apenas de `logs:write` |

## Campos do evento

Uma linha JSON por evento. Os campos comuns valem para os três serviços.

| Campo | Significado |
|---|---|
| `ts` | data e hora em UTC, formato ISO 8601 |
| `servico` | `proxy`, `api` ou `monitor` |
| `ambiente` | `producao` |
| `nivel` | `info`, `warn` ou `error` |
| `evento` | nome do evento (tabela acima) |
| `req_id` | identificador de correlação, criado no proxy e repassado ao back-end |
| `trafego` | `usuario` ou `monitor` — separa tráfego real de sonda |
| `pais` | país da requisição (`CF-IPCountry`). O IP completo não é registrado |
| `metodo` | método HTTP |
| `rota` | rota padronizada: `/todos/42` é registrado como `/todos/:id` |
| `status` | código de resposta |
| `duracao_ms` | duração da operação |
| `origem_servida` | qual origem do Pages atendeu |
| `failover` | se houve troca de origem |
| `motivo_bloqueio` | `origem_nao_autorizada`, `rota_nao_permitida`, `metodo_nao_permitido` |
| `operacao` | operação de negócio (`listar`, `criar`, `concluir`, `reabrir`, `excluir`) ou de banco |
| `ok` | resultado da consulta ao banco |
| `erro_tipo` | motivo técnico da falha |

Não são registrados: senha, token, credencial, string de conexão, corpo da
requisição e IP completo do visitante.

## Exemplo real de uma requisição

Uma única ação do usuário — marcar uma tarefa como concluída — gera três linhas,
ligadas pelo mesmo `req_id`:

```json
{"ts":"2026-09-18T20:14:03.118Z","servico":"proxy","ambiente":"producao","nivel":"info","evento":"requisicao_api","req_id":"8f2c…","trafego":"usuario","pais":"BR","metodo":"PATCH","rota":"/todos/:id","status":200,"duracao_ms":84,"upstream":"service-binding"}
{"ts":"2026-09-18T20:14:03.092Z","servico":"api","ambiente":"producao","nivel":"info","evento":"consulta_banco","req_id":"8f2c…","operacao":"alternar_tarefa","banco":"trabaidafacul-db","ok":true,"duracao_ms":37}
{"ts":"2026-09-18T20:14:03.095Z","servico":"api","ambiente":"producao","nivel":"info","evento":"operacao_negocio","req_id":"8f2c…","operacao":"concluir","metodo":"PATCH","rota":"/todos/:id","status":200}
```

O mesmo `req_id` aparece no cabeçalho `X-Req-Id` da resposta HTTP. É o que
permite pegar uma ação feita no navegador e encontrar exatamente as linhas dela
no painel.

## Limitações conhecidas

- Dentro de um Worker o relógio só avança depois de uma operação de entrada e
  saída. Como a busca na origem e a consulta ao D1 são operações desse tipo, a
  medição de duração funciona, mas é grossa: serve para comparar ordens de
  grandeza e detectar degradação, não para cravar milissegundos.
- A checagem de disponibilidade parte de dentro da rede da Cloudflare. Ela prova
  que o domínio responde e que o caminho interno está de pé, mas não mede a
  experiência de rede de um usuário em casa.
- Período sem dados no painel não significa "sem erro". Significa que não houve
  coleta: ou não houve tráfego, ou o envio falhou. O painel de disponibilidade,
  que recebe uma checagem por minuto independentemente de haver usuário, é o que
  distingue os dois casos — se ele tem pontos e os outros não, não houve uso; se
  nem ele tem, a coleta parou.
