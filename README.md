# Infraestrutura Cloud — UniAmérica

Trabalho da disciplina de Infraestrutura Cloud (Prof. Laércio), a partir do
repositório original da atividade. A aplicação é a mesma lista de tarefas; o que
foi construído é a infraestrutura serverless em volta dela e, na segunda entrega,
a observabilidade.

**Integrantes:** Luis Felipe Coradi · Rubens Prado · Guilherme Royer

## Endereços

| O quê | Onde |
|---|---|
| Aplicação (front-end) | https://app.trabaidafacul.site |
| API (pelo domínio) | https://api.trabaidafacul.site |
| Painéis de observabilidade | Grafana Cloud (acesso autenticado — demonstrado na apresentação) |

## Arquitetura em uma frase

Um único Worker de proxy reverso atende os dois hostnames: distribui os
visitantes entre duas origens do Cloudflare Pages com afinidade por IP e
failover, e encaminha as chamadas da API por Service Binding para o Worker do
back-end, que acessa o banco D1 por binding. Back-end e banco não têm endereço
público.

## Recursos na Cloudflare

```
Domínio           trabaidafacul.site
Hostnames         app.trabaidafacul.site · api.trabaidafacul.site
Worker proxy      trabaidafacul-proxy      único exposto
Worker back-end   trabaidafacul-api        sem URL pública (service binding)
Worker monitor    trabaidafacul-monitor    cron de 1 minuto, checagem de disponibilidade
Banco D1          trabaidafacul-db
Origens do front  trabaidafacul.pages.dev · trabaidafacul-b.pages.dev
```

## Estrutura do repositório

```
backend/            aplicação original (Express + Mongoose) — mantida como referência
frontend/           aplicação React original, com a URL da API em .env.production
banco-de-dados/     scripts originais do MongoDB — mantidos como referência
infra/              a infraestrutura de verdade (Cloudflare)
  shared/log.js       geração e envio dos logs estruturados
  proxy-worker/       proxy reverso, distribuição de acesso e regras de acesso
  api-worker/         back-end e schema do D1
  monitor-worker/     checagem de disponibilidade por Cron Trigger
  teste-local.mjs     testes automatizados (SQLite em memória simulando o D1)
observabilidade/    formato do log, consultas e definição dos painéis
diagrama/           diagrama técnico: fonte editável e versão legível
docs/               documentação das entregas
```

## Como rodar os testes

```bash
cd infra
node --experimental-sqlite teste-local.mjs
```

## Como publicar

```bash
cd infra/api-worker     && npx wrangler deploy
cd ../proxy-worker      && npx wrangler deploy
cd ../monitor-worker    && npx wrangler deploy
```

Credenciais não ficam no repositório. As do destino de logs entram como secret:

```bash
npx wrangler secret put LOKI_USER
npx wrangler secret put LOKI_TOKEN
```
