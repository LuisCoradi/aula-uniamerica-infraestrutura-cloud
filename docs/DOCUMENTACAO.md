# Documentação da infraestrutura

Trabalho de Infraestrutura Cloud - UniAmérica
Aplicação: lista de tarefas do repositório aula-uniamerica-infraestrutura-cloud
Domínio: trabaidafacul.site
Acesso: https://app.trabaidafacul.site

## 1. Serviços utilizados

Usei a Cloudflare para tudo. Os serviços foram:

Cloudflare Registrar e Cloudflare DNS para registrar o domínio trabaidafacul.site e gerenciar a zona de DNS.

Cloudflare Workers para o proxy reverso e também para o back-end. São dois Workers separados.

Cloudflare Pages para o front-end. Criei dois projetos, trabaidafacul e trabaidafacul-b, que são as duas origens da redundância.

Cloudflare D1 para o banco de dados. É um SQLite serverless.

WAF e rate limiting da Cloudflare para a segurança na borda.

Tudo funciona no plano gratuito. O único gasto foi o registro do domínio.

## 2. Por que escolhi esses serviços

Escolhi Workers para o back-end porque dá para publicar um Worker sem nenhum endereço público. Basta colocar workers_dev = false e não declarar nenhuma rota. Assim o requisito de o back-end não ficar exposto na Internet deixa de ser uma regra de firewall e passa a ser uma característica da própria arquitetura. Não existe URL para alguém tentar acessar.

A escolha mais importante foi o banco. O projeto original usa MongoDB, mas os bancos gerenciados gratuitos (MongoDB Atlas M0, Neon, Supabase) só permitem restringir o acesso por IP nos planos pagos. No plano gratuito o banco fica com um endereço público protegido só por senha, o que não atende o requisito de não ter acesso público. O D1 não tem endereço de rede nenhum. Ele é acessado por um binding declarado no Worker e resolvido dentro da Cloudflare. Não existe host, porta ou string de conexão.

O custo dessa escolha foi reescrever as quatro rotas do back-end de Mongoose para SQL. Mantive o formato das respostas igual ao original, inclusive o campo _id, então o front-end só precisou mudar o endereço da API.

Usei dois projetos no Pages para o front-end porque o enunciado pede pelo menos dois pontos de execução. São dois deployments independentes.

Tentei primeiro usar a Netlify como segunda origem, para ter dois provedores diferentes. Não deu certo: a Netlify responde 401 quando recebe requisições com cabeçalhos X-Forwarded-* apontando para um domínio que ela não reconhece, que é justamente o que um proxy reverso envia. Descobri isso depois de um tempo debugando, porque no navegador o site abria normal e só quebrava através do proxy. Resolvi tirando os cabeçalhos X-Forwarded-* do proxy (a origem não precisa deles) e trocando a segunda origem para o Pages.

Não usei AWS por causa do banco. O Aurora Serverless v2 tem custo mínimo mensal fora do free tier, e o DynamoDB mudaria bastante o modelo de dados da aplicação.

## 3. Como a segurança foi implementada

Segui a regra do enunciado: bloquear tudo e liberar só o necessário. A proteção está em quatro camadas.

Transporte: TLS 1.2 como versão mínima, HSTS de 12 meses, e Always Use HTTPS ligado, que redireciona qualquer acesso na porta 80 para a 443. Todas as respostas levam os cabeçalhos X-Content-Type-Options, X-Frame-Options e Referrer-Policy.

Borda: WAF da Cloudflare ativo na zona e uma regra de rate limiting de 100 requisições por minuto por IP no hostname api.trabaidafacul.site.

Aplicação: o proxy reverso faz três verificações antes de encaminhar qualquer coisa para o back-end. Primeiro, o cabeçalho Origin: só https://app.trabaidafacul.site é aceito, qualquer outra origem recebe 403. Requisições sem Origin, como as feitas por curl, continuam permitidas, porque são elas que comprovam o requisito de acessar a API pelo domínio. Segundo, o método: só GET, POST, PATCH, DELETE e OPTIONS, o resto recebe 405. Terceiro, a rota: só /todos, /todos/{id} e /health, o resto recebe 403.

No back-end, o campo text é obrigatório e limitado a 500 caracteres, e todas as consultas usam prepared statements com parâmetros, então não tem concatenação de SQL.

Isolamento: o back-end não tem URL e o banco não tem endereço de rede. Nessa camada não existe regra para burlar, porque não existe caminho.

Vale citar que o backend/index.js original tinha a senha do MongoDB escrita direto no código e versionada no Git (mongodb://root:rootpassword@...). Na arquitetura nova não existe credencial de banco, porque a autorização vem do binding que a plataforma concede ao Worker.

## 4. Como funciona a redundância do front-end

O front-end está publicado em dois lugares, trabaidafacul.pages.dev e trabaidafacul-b.pages.dev. Ninguém acessa esses endereços direto. Todo mundo entra por app.trabaidafacul.site, que é o proxy.

O proxy escolhe a origem pelo hash do IP do visitante. Isso significa que o mesmo visitante cai sempre na mesma origem, e visitantes diferentes se distribuem entre as duas.

Na primeira versão eu tinha feito rodízio a cada requisição, e estava errado. Uma página React não é uma requisição, é o HTML mais o CSS mais o JavaScript mais o manifest. Alternando a origem a cada uma, o navegador montava a página com pedaços vindos de servidores diferentes, e a folha de estilo acabava sendo recusada. O erro apareceu na prática durante os testes.

A forma certa se chama afinidade de sessão, e existe com esse nome em todos os balanceadores: ip_hash no nginx, balance source no HAProxy, sticky sessions no AWS Application Load Balancer.

O failover funciona assim: o proxy chama a origem escolhida com um limite de 5 segundos. Se der timeout, se a conexão for recusada, se o DNS falhar, se vier um erro 5xx ou se a origem responder com um redirecionamento inesperado, o proxy tenta a outra origem na mesma requisição. O usuário não vê erro e não precisa recarregar. Só se as duas falharem é que ele recebe um 503.

Toda resposta leva dois cabeçalhos que deixam isso verificável: X-Served-By diz qual origem atendeu, e X-Failover diz se houve troca.

Uma coisa que preciso registrar: os endereços .pages.dev das duas origens continuam acessíveis direto, porque são endereços públicos do provedor. Isso não quebra nenhum requisito, já que o front-end precisa ser público, mas significa que dá para contornar o proxy se a pessoa souber essas URLs. Contornar não dá acesso a nada, porque a API recusa qualquer origem que não seja app.trabaidafacul.site, então o site abre mas não consegue ler nem gravar dados.

## 5. Como funciona o proxy reverso

É um Worker só, que atende os dois hostnames e decide o que fazer olhando o hostname da requisição.

Em app.trabaidafacul.site ele repassa a requisição para a origem escolhida, com o método, os cabeçalhos e o corpo, e devolve a resposta ao navegador com os cabeçalhos de segurança. O navegador nunca fica sabendo qual origem respondeu.

Em api.trabaidafacul.site ele aplica as três verificações da seção 3 e só depois encaminha para o Worker do back-end usando um service binding.

O service binding é a parte central da arquitetura. É uma chamada de Worker para Worker resolvida dentro da Cloudflare. Não abre socket, não passa pela Internet, não usa DNS e não pode partir de fora. É por causa dele que o back-end consegue existir sem endereço público e mesmo assim ser alcançado pelo proxy.

O código do proxy tem cerca de 150 linhas e está em infra/proxy-worker/src/index.js.

## 6. Como o domínio foi configurado

Registrei o trabaidafacul.site no Cloudflare Registrar, então ele já nasceu com a zona hospedada na Cloudflare e não precisei esperar propagação de nameserver.

Os dois subdomínios foram criados como Custom Domains do Worker do proxy, declarados no wrangler.toml:

    routes = [
      { pattern = "app.trabaidafacul.site", custom_domain = true },
      { pattern = "api.trabaidafacul.site", custom_domain = true },
    ]

No deploy a Cloudflare cria o registro de DNS e emite o certificado TLS de cada um automaticamente. Os dois ficam com o proxy da Cloudflare ativo, então o IP de origem não fica exposto e o tráfego é obrigado a passar pela borda. O domínio raiz redireciona com 301 para app.trabaidafacul.site.

Sobre o pedido de IP público que está no enunciado: infraestrutura serverless não tem IP fixo. O serviço responde por anycast a partir de vários pontos de presença, e o endereço muda conforme a região. O jeito certo de apontar nesse modelo é por CNAME ou delegando os nameservers. Como registrei domínio próprio, isso acabou não sendo necessário.

## 7. Acessos permitidos e bloqueados

Permitidos:

Qualquer usuário pode acessar app.trabaidafacul.site na porta 443 por HTTPS. Acessos na porta 80 são redirecionados com 301 para 443.

O proxy pode acessar as duas origens do front-end na porta 443 por HTTPS.

O front-end em app.trabaidafacul.site pode chamar api.trabaidafacul.site na porta 443 por HTTPS.

O proxy pode chamar o Worker do back-end por service binding, sem porta e sem rede.

O back-end pode acessar o banco D1 por binding, sem porta e sem rede.

Bloqueados:

Qualquer origem web diferente de app.trabaidafacul.site chamando a API recebe 403, pela validação de Origin no proxy.

Qualquer rota fora de /todos, /todos/{id} e /health recebe 403, pela allowlist de rotas.

Qualquer método fora de GET, POST, PATCH, DELETE e OPTIONS recebe 405, pela allowlist de métodos.

Mais de 100 requisições por minuto vindas do mesmo IP para a API são bloqueadas pela regra do WAF.

A Internet não consegue chegar no back-end, porque não existe hostname para resolver.

A Internet não consegue chegar no banco nas portas 3306, 5432 ou 27017, porque o D1 não expõe socket de rede.

Vale separar essas duas categorias. Os quatro primeiros são bloqueios ativos: existe um caminho e uma regra interrompe. Os dois últimos são impossibilidades: não existe caminho para interromper. A segunda categoria é melhor, porque não depende de uma configuração continuar certa com o tempo.

## 8. Limitações conhecidas

As URLs .pages.dev das origens são públicas, como expliquei na seção 4.

As duas origens estão no mesmo provedor. São deployments independentes e atendem o requisito, mas se a Cloudflare inteira cair, as duas caem junto. A tentativa de usar outro provedor está na seção 2.

O failover é reativo. O proxy descobre que a origem caiu quando tenta usar, então a primeira requisição afetada espera o timeout. Um balanceador de verdade faz health check periódico e tira a origem da rotação antes de alguém ser atingido. Na Cloudflare isso é recurso pago.

Não tem autenticação de usuário. A aplicação original não tem login e o escopo do trabalho é infraestrutura, então qualquer pessoa que abra o site pode criar e apagar tarefas.
