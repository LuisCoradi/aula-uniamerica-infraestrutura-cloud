# Infraestrutura Cloud — UniAmérica

Trabalho da disciplina de Infraestrutura Cloud, a partir do repositório original
da atividade. A aplicação é a mesma lista de tarefas; o que foi construído é a
infraestrutura serverless em volta dela e, na segunda entrega, a observabilidade.

**Integrantes:** Luis Felipe Coradi · Rubens Prado · Guilherme Royer

| | |
|---|---|
| Aplicação | https://app.trabaidafacul.site |
| API | https://api.trabaidafacul.site |
| Painéis | Grafana Cloud — acesso autenticado, demonstrado na apresentação |

---

## O que foi construído

**Primeira entrega — a infraestrutura.** Domínio próprio com HTTPS, proxy reverso
como único ponto de entrada, front-end redundante em duas origens com
distribuição de acesso e failover, back-end sem endereço público e banco de dados
sem acesso de rede.

**Segunda entrega — a observabilidade.** Instrumentação dos Workers com logs
estruturados em JSON, uma sonda de disponibilidade executando a cada minuto, e um
dashboard com sete painéis alimentados por dados reais do ambiente.

---

## Arquitetura

Existe um único ponto de entrada. Todo o tráfego vindo da Internet passa pelo
Worker de proxy reverso, que atende dois hostnames e decide o que fazer conforme
qual deles foi chamado.

- **`app.trabaidafacul.site`** — o proxy escolhe uma das duas origens do
  Cloudflare Pages por hash do IP do visitante (afinidade de sessão, equivalente
  ao `ip_hash` do nginx). Se a origem escolhida falhar, ele reencaminha para a
  outra automaticamente.
- **`api.trabaidafacul.site`** — o proxy aplica as regras de acesso (allowlist de
  métodos, allowlist de rotas e CORS restrito) e só então encaminha para o
  back-end por Service Binding, uma invocação interna que não passa pela
  Internet.

O back-end acessa o banco por binding declarado na configuração. Nem o back-end
nem o banco possuem hostname, porta ou string de conexão.

O diagrama técnico completo, com portas, protocolos, fluxos permitidos e
bloqueados e o caminho da observabilidade, está em `diagrama/`.

## Recursos na Cloudflare

```
Domínio           trabaidafacul.site
Hostnames         app.trabaidafacul.site · api.trabaidafacul.site
Worker proxy      trabaidafacul-proxy      único exposto
Worker back-end   trabaidafacul-api        sem URL pública (service binding)
Worker monitor    trabaidafacul-monitor    cron de 1 minuto, checagem de disponibilidade
Banco             trabaidafacul-db         Cloudflare D1
Origens do front  trabaidafacul.pages.dev · trabaidafacul-b.pages.dev
```

---

## Observabilidade

Cada evento é uma linha JSON, gerada pelo módulo único `infra/shared/log.js` e
enviada por dois caminhos:

```
Worker (proxy | api | monitor)
   ├─ console.log(JSON)  ──────────────►  Cloudflare Workers Logs  (conferência)
   └─ POST /loki/api/v1/push  ─────────►  Grafana Cloud / Loki     (fonte dos painéis)
                                                │
                                                └──►  Dashboard no Grafana
```

O envio acontece em lote, depois que a resposta já foi devolvida ao usuário, de
modo que o registro não atrasa nenhuma requisição. As credenciais ficam como
secret, fora do repositório.

**Os painéis:**

1. Disponibilidade pelo domínio
2. Checagens por alvo (front e API, sucesso e falha)
3. Latência por rota (p95 e mediana)
4. Erros e bloqueios
5. Uso da aplicação por operação
6. Banco de dados: duração e falhas das consultas
7. Redundância do front-end e eventos de failover

---

## Estrutura do repositório

```
infra/
  shared/log.js          geração e envio dos logs estruturados
  proxy-worker/          proxy reverso, distribuição de acesso e regras de acesso
  api-worker/            back-end e schema do banco
  monitor-worker/        sonda de disponibilidade (Cron Trigger)
  teste-local.mjs        testes automatizados

observabilidade/
  dashboard-*.json       definição completa do dashboard, exportada do Grafana
  formato-do-log.md      campos do evento, coleta, armazenamento e retenção
  consultas-logql.md     as consultas de cada painel

diagrama/
  diagrama-entrega2.drawio   arquivo-fonte editável
  diagrama-entrega2.pdf      versão legível
  *.png                      as duas visões em imagem

docs/
  FUNDAMENTACAO-PAINEIS.pdf  fundamentação completa dos painéis
  TESTES-E-EVIDENCIAS.pdf    os seis cenários de teste com evidências
  DOCUMENTACAO.md            documentação da primeira entrega
  ARQUITETURA-CONCEITUAL.md  explicação conceitual da arquitetura

backend/  frontend/  banco-de-dados/
  aplicação original da atividade, mantida como referência
```

---

## Testes automatizados

Trinta e cinco verificações cobrindo as rotas da API, as regras de acesso do
proxy, o failover entre origens, o formato dos eventos de observabilidade e o
payload de envio dos logs. Rodam contra um SQLite em memória, sem tocar no
ambiente publicado.

```bash
node --experimental-sqlite infra/teste-local.mjs
```

Saída esperada: `Todos os testes passaram.`
