# A arquitetura do projeto, explicada por conceito

Este texto explica a ideia por tras da infraestrutura, e nao o passo a passo de
como ela foi montada. A intencao e que, lendo ele, de para entender o desenho
antes de olhar o diagrama.

## A ideia geral

A aplicacao e a mesma lista de tarefas do repositorio do professor: um front-end
em React e um back-end que le e grava as tarefas num banco. O que foi feito no
trabalho nao foi mexer na aplicacao, foi montar a infraestrutura em volta dela.

O desenho parte de uma regra simples: existe um unico ponto de entrada, e tudo o
que vem da Internet passa por ele. Esse ponto de entrada e o proxy reverso. O
usuario nunca fala com o front-end nem com o back-end diretamente; ele fala com
o proxy, e o proxy decide o que fazer com aquela requisicao.

Tudo roda sem servidor. Nao existe maquina virtual, nao existe sistema
operacional para atualizar, nao existe processo ligado esperando conexao. Cada
componente e uma funcao que a Cloudflare executa quando chega uma requisicao e
descarta quando termina.

## Os componentes e o papel de cada um

**DNS.** E o que traduz o nome do dominio para o endereco da Cloudflare. Foram
criados dois nomes: `app.trabaidafacul.site`, que e por onde o usuario entra, e
`api.trabaidafacul.site`, que e por onde o front-end chama a API. Os dois nomes
apontam para o mesmo proxy.

**Proxy reverso.** E um Worker, ou seja, codigo JavaScript que a Cloudflare
executa na borda da rede dela, no ponto de presenca mais perto do usuario. Ele
olha qual dos dois nomes foi chamado e trata a requisicao de um jeito diferente
em cada caso. Se foi `app`, ele busca a pagina numa das origens do front-end. Se
foi `api`, ele aplica as regras de acesso e repassa para o back-end. Ele tambem
e onde o HTTPS termina: o TLS e encerrado nele, e todo o resto do caminho e
interno.

**Front-end.** Sao dois sites estaticos publicados no Cloudflare Pages, cada um
com a mesma build do React. Sao dois porque o requisito pedia redundancia com no
minimo dois pontos de execucao. O proxy escolhe qual dos dois vai atender cada
visitante usando um hash do IP dele. Isso importa porque uma pagina React nao e
uma requisicao unica: e o HTML mais o CSS mais o JavaScript mais os icones. Se
cada um desses arquivos viesse de uma origem diferente, a pagina poderia quebrar.
Com o hash do IP, o mesmo visitante sempre cai na mesma origem, e visitantes
diferentes se dividem entre as duas. E a mesma tecnica do `ip_hash` do nginx.

Se a origem escolhida nao responder, ou responder com erro de servidor, o proxy
tenta a outra na hora e devolve a pagina vinda dela. O usuario nao percebe.

**Back-end.** E um segundo Worker, com as quatro rotas da aplicacao: listar
tarefas, criar, marcar como concluida e apagar. Ele nao tem endereco publico. O
`workers_dev` esta desligado e nenhuma rota de dominio aponta para ele, entao nao
existe URL na Internet que chegue nele. O proxy chama esse Worker por Service
Binding, que e uma invocacao de Worker para Worker resolvida dentro do proprio
runtime da Cloudflare. Nao ha socket, nao ha DNS, nao ha porta. Uma chamada
dessas nao pode partir de fora da Cloudflare, e por isso o back-end esta fechado
por construcao, e nao por uma regra de firewall que alguem poderia esquecer de
aplicar.

**Banco.** E o Cloudflare D1, um SQLite gerenciado. O back-end acessa ele por um
binding declarado na configuracao: no codigo se escreve `env.DB.prepare(...)` e
nada mais. Nao existe host, nao existe porta, nao existe string de conexao e nao
existe usuario e senha para vazar. O D1 nao e um Worker, e um servico gerenciado
de banco: ele so e alcancavel pelo Worker do back-end, que e o unico que declarou
aquele binding, e nem ele nem o banco recebem conexao pela Internet.

## O caminho de uma requisicao

Quando o usuario digita o endereco, o navegador pergunta ao DNS para onde ir e
recebe o endereco da Cloudflare. A requisicao chega no proxy por HTTPS na porta
443. O proxy calcula, pelo IP, qual origem atende aquele visitante, busca a
pagina nela e devolve para o navegador. A pagina carrega no navegador do usuario.

A partir dai, cada acao na lista e uma chamada do front-end para
`api.trabaidafacul.site`. Essa chamada tambem chega no proxy. O proxy confere o
metodo, confere a rota, confere de qual origem a chamada partiu e, se estiver
tudo dentro do permitido, repassa por Service Binding para o back-end. O back-end
consulta ou grava no D1 pelo binding e responde. A resposta volta pelo mesmo
caminho.

O ponto conceitual e que a requisicao entra em terreno publico e sai dele no
proxy. Do proxy para dentro, nada mais anda pela Internet.

## As regras de acesso

O criterio foi bloquear tudo e liberar o minimo necessario.

Da Internet, o unico destino alcancavel e o proxy, e so por HTTPS na porta 443.
Requisicao em HTTP simples e redirecionada para HTTPS antes de chegar na
aplicacao, e o TLS aceito e no minimo 1.2.

Na API, tres filtros sao aplicados antes de qualquer coisa chegar no back-end.
Um de metodo: so GET, POST, PATCH, DELETE e OPTIONS passam, o resto recebe 405.
Um de rota: so `/todos`, `/todos/{id}` e `/health` passam, o resto recebe 403 e
nem e encaminhado. E um de origem: no navegador, so o front-end oficial pode
chamar a API; qualquer outro site recebe 403. Chamadas sem cabecalho `Origin`,
como as feitas por curl, continuam permitidas, porque sao elas que comprovam nos
testes que o acesso ao back-end acontece pelo dominio.

Alem disso ha uma regra de rate limiting no WAF, que corta excesso de requisicoes
do mesmo IP, e os cabecalhos de seguranca na resposta, incluindo HSTS.

## O que substitui o que, em relacao ao modelo tradicional

Vale traduzir, porque a arquitetura serverless nao tem os mesmos nomes da
arquitetura com maquinas.

O proxy reverso faz o papel do nginx, mas em vez de rodar numa VM roda como
funcao na borda. O rodizio entre as duas origens faz o papel do load balancer,
com afinidade de sessao equivalente ao `ip_hash`. As allowlists de metodo, rota e
origem no proxy fazem o papel do security group ou do firewall de aplicacao. E o
isolamento do back-end e do banco, que numa arquitetura tradicional viria de uma
subnet privada sem rota para a Internet, aqui vem do Service Binding e do
binding do D1: nao ha endereco a proteger, porque nao ha endereco.
