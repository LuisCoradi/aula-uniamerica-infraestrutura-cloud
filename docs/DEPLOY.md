# Guia de deploy — do zero ao ar

Domínio: **trabaidafacul.site** (Cloudflare Registrar)
Tempo estimado: 60–90 minutos.

Execute os passos **na ordem**. Cada bloco é copiar e colar.

---

## Passo 0 — Preparação (5 min)

```bash
# Node 18+ é necessário
node --version

# Instale o Wrangler (CLI da Cloudflare)
npm install -g wrangler

# Faça login — abre o navegador para autorizar
wrangler login
wrangler whoami
```

Copie a pasta `infra/` e o conteúdo de `frontend-patch/` para dentro do seu fork:

```bash
cp -r infra/ SEU-FORK/
cp frontend-patch/App.js        SEU-FORK/frontend/src/App.js
cp frontend-patch/.env.production SEU-FORK/frontend/.env.production
```

---

## Passo 1 — Banco de dados D1 (10 min)

```bash
cd SEU-FORK/infra/api-worker

# Cria o banco serverless
wrangler d1 create trabaidafacul-db
```

A saída traz um `database_id`. **Cole esse valor** em `wrangler.toml`, na linha
`database_id = "COLE_AQUI_O_DATABASE_ID"`.

```bash
# Cria a tabela e insere o seed no banco remoto
wrangler d1 execute trabaidafacul-db --remote --file=./schema.sql

# Confere
wrangler d1 execute trabaidafacul-db --remote --command="SELECT * FROM todos"
```

> **Print para a evidência:** essa última saída, mostrando as 3 tarefas.

---

## Passo 2 — Back-end (5 min)

```bash
cd SEU-FORK/infra/api-worker
wrangler deploy
```

A saída deve dizer algo como `No publish routes` / nenhuma URL. **Isso é o esperado** —
o Back-end não tem endereço público. Se aparecer uma URL `.workers.dev`, confira se
`workers_dev = false` está no `wrangler.toml`.

> **Print para a evidência:** a saída do deploy sem URL pública.

---

## Passo 3 — Front-end, origem 1: Cloudflare Pages (10 min)

```bash
cd SEU-FORK/frontend
npm install
npm run build

wrangler pages project create trabaidafacul --production-branch=main
wrangler pages deploy build --project-name=trabaidafacul
```

Anote a URL gerada (algo como `https://trabaidafacul.pages.dev`).

---

## Passo 4 — Front-end, origem 2: Netlify (10 min)

Segunda origem, em **outro provedor** — é o que caracteriza redundância real.

```bash
npm install -g netlify-cli
netlify login
netlify deploy --dir=build --prod
```

Quando ele perguntar, crie um site novo com o nome `trabaidafacul`.
Anote a URL (algo como `https://trabaidafacul.netlify.app`).

**Alternativa sem criar conta na Netlify:** crie um segundo projeto no Pages.

```bash
wrangler pages project create trabaidafacul-b --production-branch=main
wrangler pages deploy build --project-name=trabaidafacul-b
```

Nesse caso, use `trabaidafacul-b.pages.dev` como `ORIGIN_2`. Funciona, mas as duas
origens ficam no mesmo provedor — se o professor questionar, a resposta honesta é
que são dois deployments independentes, com builds e ciclos de vida separados.

---

## Passo 5 — Proxy reverso (15 min)

Edite `infra/proxy-worker/wrangler.toml` e confira se `ORIGIN_1` e `ORIGIN_2`
batem com as URLs dos passos 3 e 4 (sem `https://`, só o hostname).

```bash
cd SEU-FORK/infra/proxy-worker
wrangler deploy
```

O `custom_domain = true` faz a Cloudflare criar sozinha:
- o registro DNS de `app.trabaidafacul.site` e `api.trabaidafacul.site`
- o certificado TLS de cada um

A emissão do certificado leva de 1 a 15 minutos. Se der erro de SSL, espere e recarregue.

> Se o deploy reclamar que a zona não foi encontrada, confirme no dashboard que
> `trabaidafacul.site` aparece em **Websites** — domínios comprados na Cloudflare
> entram automaticamente.

---

## Passo 6 — Endurecer no dashboard (10 min)

No painel da Cloudflare, em `trabaidafacul.site`:

**SSL/TLS → Overview**
- Modo de criptografia: **Full (strict)**

**SSL/TLS → Edge Certificates**
- `Always Use HTTPS`: **ligado** (redireciona 80 → 443)
- `Minimum TLS Version`: **TLS 1.2**
- `HTTP Strict Transport Security (HSTS)`: **ligado**

**Security → WAF → Rate limiting rules** → `Create rule`
- Nome: `Limite de requisicoes na API`
- Se: `Hostname` igual a `api.trabaidafacul.site`
- Then: `Block`, com limite de **100 requisições por 1 minuto** por IP

> **Print para a evidência:** a tela de cada uma dessas configurações.

---

## Passo 7 — Teste tudo

Siga o arquivo `TESTES.md`.

---

## Comandos úteis para depurar

```bash
# Logs ao vivo do proxy
wrangler tail trabaidafacul-proxy

# Logs ao vivo do back-end (mostra o service binding chegando)
wrangler tail trabaidafacul-api

# Consultar o banco direto
wrangler d1 execute trabaidafacul-db --remote --command="SELECT * FROM todos"
```

---

## Se algo der errado

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Error 1016` ou `DNS_PROBE` | Custom domain ainda provisionando | Espere 5 min |
| Erro de certificado SSL | Certificado ainda não emitido | Espere até 15 min |
| API retorna 403 no navegador | CORS: origem errada | Confira se está acessando por `app.trabaidafacul.site` e não pela URL do Pages |
| API retorna 503 | Service binding não encontrou o Back-end | Rode `wrangler deploy` no `api-worker` primeiro |
| Front carrega mas a lista vem vazia | `REACT_APP_API_URL` não entrou no build | Rebuild com o `.env.production` presente e redeploy |
| `binding DB not found` | `database_id` não foi colado | Edite o `wrangler.toml` do api-worker |
