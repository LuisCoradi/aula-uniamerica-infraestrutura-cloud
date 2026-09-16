# Roteiro de testes — as 7 evidências exigidas

Cada teste tem o comando pronto, o resultado esperado e o que fotografar.
Tire print **do comando junto com a saída**, ou use o navegador com o DevTools aberto.

---

## Teste 1 — Front-end acessível pelo domínio

**Navegador:** abra `https://app.trabaidafacul.site`

Esperado: a Lista de Tarefas carrega com as 3 tarefas do seed, cadeado de HTTPS na barra.

**Print:** a página inteira, com a URL e o cadeado visíveis.

Complemento por terminal:

```bash
curl.exe -I https://app.trabaidafacul.site
```

Esperado: `HTTP/2 200`, e os headers `x-served-by`, `x-proxy` e `strict-transport-security`.

---

## Teste 2 — Back-end acessível pelo domínio/API

```bash
curl.exe -i https://api.trabaidafacul.site/todos
```

Esperado: `HTTP/2 200` e o JSON com as tarefas. Repare no header
`x-upstream: service-binding` — é a prova de que a requisição foi encaminhada
pelo proxy ao Back-end por ligação interna.

**Print:** o comando e a resposta completa com os headers.

---

## Teste 3 — Front-end conseguindo acessar o Back-end

**Navegador:** em `https://app.trabaidafacul.site`, abra o DevTools (F12) na aba
**Network**, digite uma tarefa nova e clique em Adicionar.

Esperado: aparece um `POST` para `api.trabaidafacul.site/todos` com status `201`,
e a tarefa surge na tela.

**Print:** o DevTools mostrando a requisição, o status 201 e os headers de resposta
com `access-control-allow-origin: https://app.trabaidafacul.site`.

---

## Teste 4 — Back-end conseguindo acessar o Banco

```bash
curl.exe -s https://api.trabaidafacul.site/health
```

Esperado:

```json
{
  "status": "ok",
  "servico": "back-end",
  "banco": "D1 (acesso por binding, sem rede publica)",
  "total_tarefas": 4
}
```

O `total_tarefas` só existe porque o Back-end conseguiu executar `SELECT COUNT(*)`
no D1. Se o banco estivesse inacessível, a resposta seria 500.

Complemento — mostre o mesmo dado direto no banco:

```bash
wrangler d1 execute trabaidafacul-db --remote --command="SELECT COUNT(*) FROM todos"
```

**Print:** as duas saídas lado a lado, com o mesmo número.

---

## Teste 5 — Acesso direto ao Back-end bloqueado

Este é o teste mais forte da entrega: **não existe endereço para atacar**.

```bash
# A URL padrão de um Worker não foi criada (workers_dev = false)
curl.exe -i https://trabaidafacul-api.workers.dev/todos
```

Esperado: falha de resolução de DNS ou `HTTP 404` — o hostname não existe.

```bash
# Confirmando que nenhuma rota pública aponta para o Back-end
wrangler deployments list --name trabaidafacul-api
```

Esperado: nenhuma rota/domínio listado.

**Bônus — o que o proxy bloqueia de fato:**

```bash
# Origem não autorizada
curl.exe -i -H "Origin: https://site-malicioso.com" https://api.trabaidafacul.site/todos
# Esperado: 403 {"message":"Origin ... nao autorizada","bloqueado_por":"proxy-reverso"}

# Rota fora da allowlist
curl.exe -i https://api.trabaidafacul.site/admin
# Esperado: 403 {"message":"Rota nao permitida","bloqueado_por":"proxy-reverso"}

# Método não permitido
curl.exe -i -X PUT https://api.trabaidafacul.site/todos
# Esperado: 405
```

**Print:** as quatro saídas.

---

## Teste 6 — Acesso direto ao Banco bloqueado

O D1 **não possui endpoint de rede**. Não há host, porta nem string de conexão.
A prova é demonstrar que não existe superfície para conectar:

```bash
# Não existe hostname público do D1 para resolver
nslookup trabaidafacul-db.d1.cloudflare.com
# Esperado: NXDOMAIN / can't find

# Portas de banco de dados não respondem em nenhum host do domínio
nmap -Pn -p 3306,5432,27017,1433 api.trabaidafacul.site
# Esperado: todas filtradas ou fechadas
```

Se não tiver `nmap`:

```bash
# Mongo (banco do projeto original)
curl.exe -m 5 -v telnet://api.trabaidafacul.site:27017
# Esperado: Connection timed out / refused

# Postgres
curl.exe -m 5 -v telnet://api.trabaidafacul.site:5432
# Esperado: Connection timed out / refused
```

**Print:** as saídas de timeout/NXDOMAIN.

**Frase para a apresentação:** *"O acesso da Internet ao banco não é bloqueado por
regra de firewall — ele é impossível por arquitetura. O D1 só é alcançável por um
binding declarado no Worker, dentro do runtime da Cloudflare. Não existe socket
de rede exposto."*

---

## Teste 7 — Aplicação continua no ar com uma origem fora

Estado inicial — descubra qual origem está te atendendo:

```powershell
curl.exe -sI https://app.trabaidafacul.site | Select-String "x-served-by|x-failover"
# Esperado: x-served-by: trabaidafacul.pages.dev  /  x-failover: nao
```

Agora derrube essa origem. Edite `infra\proxy-worker\wrangler.toml` e troque o
hostname da origem que apareceu acima por um que não existe:

```toml
[vars]
ORIGIN_1 = "origem-fora-do-ar.pages.dev"
ORIGIN_2 = "trabaidafacul-b.pages.dev"
```

```powershell
cd infra\proxy-worker
wrangler deploy
```

Teste de novo:

```powershell
curl.exe -sI https://app.trabaidafacul.site | Select-String "x-served-by|x-failover"
# Esperado:
#   x-served-by: trabaidafacul-b.pages.dev
#   x-failover: sim
```

**Navegador:** recarregue `https://app.trabaidafacul.site` — o site continua
funcionando normalmente, com as tarefas carregando.

Confirme o failover nos logs. Abra uma segunda janela e rode:

```powershell
wrangler tail trabaidafacul-proxy
```

Deixe rodando e recarregue o site. Esperado, a cada requisição:

```
Origem origem-fora-do-ar.pages.dev indisponivel: ...
```

**Print:** o `x-served-by` antes e depois, o site funcionando, e a linha do log.

**Não esqueça de reverter** o `ORIGIN_1` para `trabaidafacul.pages.dev` e rodar
`wrangler deploy` de novo.

---

## Teste extra — distribuição entre as origens

O requisito pede um "mecanismo responsável por distribuir o acesso". A
distribuição é **por visitante**, não por requisição: o proxy escolhe a origem
pelo hash do IP do cliente, então o mesmo computador cai sempre na mesma origem.
É de propósito — se alternasse a cada requisição, o HTML viria de um servidor e o
CSS de outro, e a página quebraria.

Para evidenciar, use dois pontos de rede diferentes:

1. No computador: `curl.exe -sI https://app.trabaidafacul.site | Select-String "x-served-by"`
2. No celular, **com dados móveis** (Wi-Fi desligado, para ter outro IP): abra
   `https://app.trabaidafacul.site`, e no navegador do celular veja o cabeçalho —
   ou simplesmente peça a um colega para acessar e mandar print.

Como são dois visitantes distintos, há 50% de chance de caírem em origens
diferentes a cada tentativa. Se der a mesma nas duas, tente de outra rede.

**Print:** as duas saídas com `x-served-by` diferentes. Se não conseguir capturar
a divergência, o print do teste 7 (failover) mais o trecho do código que faz a
escolha já demonstram o mecanismo.

---

## Checklist final antes de entregar

- [ ] `https://app.trabaidafacul.site` abre e funciona
- [ ] `https://api.trabaidafacul.site/todos` responde JSON
- [ ] Adicionar, concluir e excluir tarefa funcionam pelo site
- [ ] Os 7 prints estão salvos e nomeados (`teste-1.png`, `teste-2.png`, ...)
- [ ] `ORIGIN_1` foi revertido para `trabaidafacul.pages.dev`
- [ ] O fork no GitHub tem a pasta `infra/` commitada
- [ ] Diagrama e documentação anexados
