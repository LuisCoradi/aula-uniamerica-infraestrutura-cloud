# Consultas dos painéis (LogQL — Grafana Cloud / Loki)

Fonte de dados: Loki. Todos os painéis partem do stream
`{aplicacao="trabaidafacul"}` e usam o parser `| json` para extrair os campos da
linha. Fuso: os eventos são gravados em UTC; os painéis são exibidos no fuso do
navegador (America/Sao_Paulo).

Convenção usada abaixo: `$__interval` é o intervalo de agrupamento que o próprio
Grafana calcula a partir da janela escolhida no painel.

---

## Painel 1 — Disponibilidade pelo domínio

**Pergunta:** a aplicação responde pelo domínio configurado, agora e nas últimas horas?

Percentual de checagens bem-sucedidas (numerador: checagens com `ok=true`;
denominador: todas as checagens do período):

```logql
sum(count_over_time({aplicacao="trabaidafacul", servico="monitor"} | json | evento="checagem_disponibilidade" | ok="true" [$__interval]))
/
sum(count_over_time({aplicacao="trabaidafacul", servico="monitor"} | json | evento="checagem_disponibilidade" [$__interval]))
```

Separado por alvo (front e API):

```logql
sum by (alvo) (count_over_time({aplicacao="trabaidafacul", servico="monitor"} | json | evento="checagem_disponibilidade" | ok="false" [$__interval]))
```

Unidade: proporção (exibir como percentual). Uma checagem por minuto por alvo.

---

## Painel 2 — Latência por rota

**Pergunta:** quais rotas estão demorando mais e em que horário?

```logql
quantile_over_time(0.95, {aplicacao="trabaidafacul", servico="proxy"} | json | evento="requisicao_api" | unwrap duracao_ms [$__interval]) by (rota)
```

Mediana, para comparar com a cauda:

```logql
quantile_over_time(0.50, {aplicacao="trabaidafacul", servico="proxy"} | json | evento="requisicao_api" | unwrap duracao_ms [$__interval]) by (rota)
```

Unidade: milissegundos. O p95 é o que mostra o pior caso típico; a mediana
sozinha esconde degradação que atinge parte das requisições.

---

## Painel 3 — Erros e bloqueios

**Pergunta:** que falhas estão ocorrendo, qual a taxa, e quantas são bloqueio proposital?

Taxa de erro de servidor (numerador: respostas 5xx; denominador: todas as
respostas do proxy):

```logql
sum(count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | status >= 500 [$__interval]))
/
sum(count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | status != "" [$__interval]))
```

Bloqueios propositais, separados por motivo — isto **não** é falha, é a regra de
acesso funcionando:

```logql
sum by (motivo_bloqueio) (count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | motivo_bloqueio != "" [$__interval]))
```

Respostas por classe de status:

```logql
sum by (status) (count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | status >= 400 [$__interval]))
```

---

## Painel 4 — Uso da aplicação

**Pergunta:** quais operações da lista de tarefas são usadas e como o volume varia?

```logql
sum by (operacao) (count_over_time({aplicacao="trabaidafacul", servico="api"} | json | evento="operacao_negocio" [$__interval]))
```

O tráfego da sonda não entra aqui: o monitor só chama `/health`, e os eventos de
negócio vêm das rotas de tarefas. Para conferir, o filtro explícito é
`| trafego="usuario"` nos eventos do proxy.

Unidade: contagem de operações por intervalo.

---

## Painel 5 — Banco de dados

**Pergunta:** as operações do back-end com o banco estão funcionando e com qual duração?

Duração por tipo de operação:

```logql
quantile_over_time(0.95, {aplicacao="trabaidafacul", servico="api"} | json | evento="consulta_banco" | unwrap duracao_ms [$__interval]) by (operacao)
```

Falhas de consulta:

```logql
sum by (operacao) (count_over_time({aplicacao="trabaidafacul", servico="api"} | json | evento="consulta_banco" | ok="false" [$__interval]))
```

Volume de consultas, para relacionar duração com carga:

```logql
sum(count_over_time({aplicacao="trabaidafacul", servico="api"} | json | evento="consulta_banco" [$__interval]))
```

---

## Painel 6 — Redundância do front-end

**Pergunta:** como os dois pontos de atendimento se comportam, e quando houve failover?

Requisições por origem que atendeu:

```logql
sum by (origem_servida) (count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | evento="requisicao_front" [$__interval]))
```

Quedas de origem detectadas:

```logql
sum by (origem_servida) (count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | evento="origem_indisponivel" [$__interval]))
```

Requisições que precisaram de failover:

```logql
sum(count_over_time({aplicacao="trabaidafacul", servico="proxy"} | json | evento="requisicao_front" | failover="true" [$__interval]))
```

---

## Consulta de evidência (rastrear uma requisição)

Para mostrar o caminho completo de um evento — da ação no navegador até o painel
— basta pegar o `X-Req-Id` da resposta e procurar por ele:

```logql
{aplicacao="trabaidafacul"} | json | req_id="COLE_O_REQ_ID_AQUI"
```

Aparecem as linhas do proxy, do back-end e da consulta ao banco daquela única
ação.
