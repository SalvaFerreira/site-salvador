# Site pessoal do Salvador Ferreira — Lisboa à noite

Este ficheiro é o briefing do projeto. Lê-o antes de qualquer tarefa e segue-o.

## O conceito

"A personal website should feel like you've briefly left the rest of the internet."

O site é Lisboa vista de cima, à noite, em 3D. Quem entra está a sobrevoar a cidade. Os projetos do Salvador são sítios acesos na cidade; clicar num deles faz a câmara voar até lá e abre um painel com o projeto. A cidade vive sozinha: trânsito em rasto de luz na Ponte 25 de Abril, um elétrico de vez em quando, janelas que acendem e apagam, ciclo de luz segundo a hora real de Lisboa (Europe/Lisbon).

Referência de ambiente: a cidade noturna vista de cima do @internetphysics (autor do infinite.games). Não copiar: a nossa é Lisboa, com geografia real.

## Mapa da cidade → conteúdo

| Na cidade | Conteúdo |
|---|---|
| Vista inicial | Canto superior esquerdo: nome + frase-tese numa linha. Canto inferior: hora em Lisboa + botão "List" |
| Baixa Pombalina | Correntes de Memória: dois edifícios acesos — (1) agente dos ofícios, case study principal; (2) automações + operação financeira |
| Campolide / Cidade Universitária | Formação (ISCTE, NOVA IMS) + um case study da ISCTE Junior Consulting |
| Avenidas Novas, um edifício às escuras | Deloitte: "Confidential — lights off by company policy" + uma linha sobre o cargo |
| Projetos pessoais | LearnVestor (e mais tarde Ninho) como pontos acesos noutros bairros. Opcional na fase 5: botão "Plan" com uma camada do PDM por cima da cidade |
| Ponte 25 de Abril | /now — o que o Salvador está a fazer este mês |
| Margem sul | Contacto ("cross the river") — email e LinkedIn |
| Botão "List" (sempre visível) | Versão em texto simples com tudo, incluindo o CV em PDF |

A primeira coisa que a câmara mostra é a Baixa. Trabalho real no centro; projetos pessoais na camada do plano.

## Regras de conteúdo (importantes)

- **Não escrevas textos de conteúdo.** Bio, case studies e /now são escritos pelo Salvador. Usa `TODO: texto do Salvador` como placeholder, nunca texto inventado.
- **Nunca inventes números, métricas, testemunhos ou projetos.**
- Conteúdo em Markdown em `src/content/` (uma coleção Astro): cada projeto é um ficheiro com frontmatter (title, place, coordinates, order, date, stack) + corpo. A cidade e a Lista leem dos mesmos ficheiros.
- Língua do site: inglês.
- Nenhum dado pessoal de utentes, cuidadoras ou clientes. Sem número de telefone em lado nenhum.

## Visual (anti-AI-slop)

- Luz de Lisboa, não de Nova Iorque: candeeiros de sódio laranja-quente (#FFB15C aprox.), janelas em amarelo quente. Nada de néon ciano/roxo, glassmorphism, gradientes de "startup de IA".
- Rio Tejo escuro, quase preto, com reflexos subtis. Luzes vermelhas no topo dos pilares da ponte. Nevoeiro leve sobre o rio.
- Edifícios procedurais extrudidos a partir das plantas reais; janelas geradas por shader (não por textura); bloom suave.
- UI mínima: tipografia sóbria (uma serifada para o nome/títulos + uma sans neutra), texto pequeno, nada de ícones de biblioteca genéricos, nada de emojis, nada de texto a escrever-se sozinho.
- Painéis dos projetos: fundo escuro opaco, coluna de leitura estreita (~65 caracteres).

## Stack

- Astro + React island para a cena; TypeScript.
- Three.js com React Three Fiber, @react-three/drei, @react-three/postprocessing (bloom).
- Edifícios: InstancedMesh ou geometria fundida por bairro; LOD por distância.
- Pipeline de dados em Python (`scripts/`, GeoPandas): plantas dos edifícios de Lisboa do OpenStreetMap (ODbL — atribuição visível obrigatória no site) e/ou Lisboa Aberta; altura a partir de `building:levels` × ~3 m, ou estimada. Simplificar polígonos, cortar à área visível, agrupar por bairro, exportar num formato binário compacto para `public/data/`.
- Dados do PDM: não há ficheiros locais. Só na fase 5: procurar as camadas do PDM (ou equivalentes: zonas verdes, riscos, freguesias) no portal de dados abertos da CML (dadosabertos.cm-lisboa.pt / geodados-cml.hub.arcgis.com), confirmar a licença e mostrar-me o que existe antes de usar.
- Alojamento: Vercel ou Netlify. Analytics sem cookies.

## Requisitos não negociáveis

- Orçamento: < 5 MB de dados da cidade; 60 fps num portátil médio; primeira imagem em < 2 s em 4G.
- Sem WebGL ou telemóvel fraco: imagem/vídeo da cidade + a Lista.
- `prefers-reduced-motion`: cidade parada, sem voos de câmara.
- Tudo acessível por teclado através da Lista. Som (se existir) desligado por defeito.
- Cada projeto tem URL própria e partilhável; meta tags + imagem de pré-visualização para o LinkedIn.
- Atribuição do OpenStreetMap visível.

## Forma de trabalhar

- Uma fase de cada vez. Antes de cada fase, apresenta um plano curto e espera aprovação.
- Faz commit no fim de cada passo que funciona.
- Se algo for muito mais difícil ou pesado do que o previsto (ex.: número de edifícios), pára e diz, com opções — não simplifiques em silêncio.

## Fases

1. **Pipeline de dados** — descarregar e processar os edifícios de Lisboa; relatório: quantos edifícios, tamanho do ficheiro, área coberta.
2. **Protótipo da cena** — cidade renderizada, câmara orbital, rio, janelas acesas, bloom. Medir fps.
3. **Interação** — a Baixa clicável: câmara voa até lá e abre o painel do case study (com placeholder).
4. **Restantes sítios + Lista + fallback + deploy.**
5. **Polimento** — hora real, ponte com trânsito, elétrico, nevoeiro, camada do PDM.
