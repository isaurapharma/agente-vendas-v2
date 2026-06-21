// src/agent/admin.js
// Agente administrativo: roda no grupo Admin, entende linguagem natural
// do Luiz humano e executa ações de gestão do negócio.

const Anthropic = require('@anthropic-ai/sdk');
const catalogo      = require('../stock/catalogo');
const estoqueAdmin  = require('../stock/estoque-admin');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
const { adicionarContato, removerContato, listarContatos } = require('../stock/contatos');
const fs   = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Persistência do estado administrativo (regras, bloqueios, etc) ──
// Tudo isso precisa sobreviver a redeploys, senão toda mudança que o
// Luiz humano fizer pelo Admin se perde na próxima vez que subirmos
// código novo.
function getEstadoAdminFilePath() {
  return path.resolve(process.env.ESTADO_ADMIN_FILE_PATH || './data/estado-admin.json');
}

function carregarEstadoAdminDoDisco() {
  try {
    const arquivo = getEstadoAdminFilePath();
    if (!fs.existsSync(arquivo)) return null;
    const raw = fs.readFileSync(arquivo, 'utf-8');
    const dados = JSON.parse(raw);
    return {
      numerosBloqueados: new Set(dados.numerosBloqueados || []),
      gruposBloqueados: new Set(dados.gruposBloqueados || []),
      regrasExtras: dados.regrasExtras || { texto: '' },
      clientesEspeciais: dados.clientesEspeciais || {},
    };
  } catch (err) {
    console.error('[Admin] Erro ao carregar estado administrativo do disco:', err.message);
    return null;
  }
}

function salvarEstadoAdminNoDisco() {
  try {
    const arquivo = getEstadoAdminFilePath();
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dados = {
      numerosBloqueados: Array.from(_refs.numerosBloqueados || []),
      gruposBloqueados: Array.from(_refs.gruposBloqueados || []),
      regrasExtras: _refs.regrasExtras || { texto: '' },
      clientesEspeciais: _refs.clientesEspeciais || {},
    };
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Admin] Erro ao salvar estado administrativo no disco:', err.message);
  }
}

// ── Estado compartilhado em memória (referências injetadas pelo handler) ──
// O handler.js passa essas funções/dados na inicialização porque o admin
// precisa manipular as mesmas estruturas (blacklist, grupos revendedores,
// regras do Luiz vendedor) que vivem no handler e no agente vendedor.
let _refs = {
  numerosBloqueados: null,   // Set
  gruposBloqueados: null,    // Set
  gruposRevendedores: null,  // Object { jid: nome }
  regrasExtras: { texto: '' }, // ajustes de personalidade/regra em runtime
  clientesEspeciais: {},     // { numero: { desconto, vip, obs } }
  pedidosDoDia: [],          // [{ hora, cliente, itens, total, tipo }]
};

// Ao registrar as referências vindas do handler.js, mescla com o que já
// foi salvo em disco anteriormente — assim, números bloqueados e regras
// extras configuradas antes de um redeploy não se perdem.
function registrarReferencias(refs) {
  const salvo = carregarEstadoAdminDoDisco();
  _refs = { ..._refs, ...refs };

  if (salvo) {
    if (salvo.numerosBloqueados.size && _refs.numerosBloqueados) {
      salvo.numerosBloqueados.forEach(n => _refs.numerosBloqueados.add(n));
    }
    if (salvo.gruposBloqueados.size && _refs.gruposBloqueados) {
      salvo.gruposBloqueados.forEach(g => _refs.gruposBloqueados.add(g));
    }
    if (salvo.regrasExtras?.texto) {
      _refs.regrasExtras = salvo.regrasExtras;
    }
    if (salvo.clientesEspeciais && Object.keys(salvo.clientesEspeciais).length) {
      _refs.clientesEspeciais = { ..._refs.clientesEspeciais, ...salvo.clientesEspeciais };
    }
    console.log('[Admin] Estado administrativo restaurado do disco (regras, bloqueios, clientes especiais).');
  }
}

// ── Histórico de conversa do grupo admin (persistido em disco) ───

function getHistoricoAdminFilePath() {
  return path.resolve(process.env.ADMIN_HISTORICO_FILE_PATH || './data/historico-admin.json');
}

function carregarHistoricoAdminDoDisco() {
  try {
    const arquivo = getHistoricoAdminFilePath();
    if (!fs.existsSync(arquivo)) return [];
    const raw = fs.readFileSync(arquivo, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Admin] Erro ao carregar histórico do disco, começando do zero:', err.message);
    return [];
  }
}

function salvarHistoricoAdminNoDisco() {
  try {
    const arquivo = getHistoricoAdminFilePath();
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(historicoAdmin), 'utf-8');
  } catch (err) {
    console.error('[Admin] Erro ao salvar histórico no disco:', err.message);
  }
}

let historicoAdmin = carregarHistoricoAdminDoDisco();
let _limparHistoricoAposResposta = false;

function limparHistoricoAdmin() {
  historicoAdmin = [];
  salvarHistoricoAdminNoDisco();
}

// ── System Prompt do agente administrativo ────────────────────
function buildSystemPromptAdmin() {
  return `Você é o assistente administrativo da Force Imports. Você conversa diretamente com o Luiz (dono/gerente humano) dentro do grupo Admin do WhatsApp. Aqui NÃO existe papel de vendedor nem personalidade carioca de venda — é uma conversa de trabalho, direta e eficiente, entre você e o Luiz.

⚠️ REGRA MÁXIMA PRIORIDADE:
Qualquer pergunta sobre estoque, produto, preço, pedido ou vendas EXIGE chamar a ferramenta correspondente (consultar_estoque_completo, consultar_produto, consultar_pedidos_dia, etc) ANTES de responder qualquer coisa. PROIBIDO terminantemente inventar frases como "endpoint falhou", "problema no sistema", "erro de conexão" ou qualquer desculpa técnica vaga — isso nunca é uma resposta válida. Se uma ferramenta retornar erro de verdade, explica o erro REAL que ela retornou, nunca um erro genérico inventado.

⚠️ FONTE DE PREÇO DE VENDA — ATENÇÃO MÁXIMA:
O preço de venda que vai pro cliente é SEMPRE o que está no catálogo (categorias gerenciadas por substituir_categoria_catalogo, marcar_produto_falta, ver_catalogo_categoria). A planilha de estoque (ferramentas de entrada/saída/consultar_estoque) serve SÓ pra controle de quantidade física e gerar o relatório diário de vendas — o preço que está nela é de controle interno, NUNCA é o preço de venda. Se o Luiz mandar atualização de preço, isso vai pro catálogo, nunca confundir com a planilha.
Existem DOIS catálogos separados: o catálogo normal (cliente final) e o catálogo de revenda (preço diferenciado pra revendedor). Use o catálogo de revenda só quando o Luiz disser explicitamente algo como "responde como preço de revenda" ou "isso é pra revendedor".

ÁUDIO:
Você NÃO ouve nem transcreve áudio. Se o Luiz mandar um áudio, avise educadamente que não consegue ouvir e peça pra ele escrever a mensagem.

QUEM FALA COM VOCÊ:
- Só o Luiz humano (ou pessoas de confiança dele) estão neste grupo.
- Trate como conversa de gestão: direto, sem rodeios, sem precisar ser "simpático" do jeito do agente de vendas.
- Pode usar linguagem natural, mas sempre confirmando o que foi feito de forma clara.

O QUE VOCÊ PODE FAZER (use as ferramentas disponíveis):
1. Bloquear/desbloquear números de telefone e grupos de WhatsApp — o agente de vendas (Luiz IA) nunca responde quem está bloqueado.
2. Controle de ESTOQUE: registrar entrada de produtos ("chegou 10 Masteron Cooper" → registrar_entrada_estoque), registrar saída/venda ("vendeu 2 Durateston Lander" → registrar_saida_estoque), ver estoque atual ("como tá o estoque?" → relatorio_estoque), ver vendas do dia ("o que vendeu hoje?" → relatorio_vendas_dia), buscar venda por cliente ("registrou a venda do Fernando?" → buscar_venda_cliente). O sistema usa a tradução de siglas — você pode falar o nome do produto normalmente que ela encontra.
3. Editar o CATÁLOGO de preço de venda (cliente final e revenda): substituir tabela de uma categoria inteira, marcar item específico em/fora de falta, ver ou listar categorias.
4. Consultar pedidos/vendas do dia, histórico de vendas.
5. Ajustar regras e comportamento do Luiz vendedor (tom de voz, frases ou emojis proibidos, novas instruções) — isso se aplica em tempo real na próxima mensagem que ele responder.
6. Gerenciar clientes especiais: desconto fixo, marcar como VIP, adicionar observações sobre o cliente.
7. Gerenciar grupos de revendedores: adicionar novo grupo de revendedor, remover, listar.
8. Gerar relatórios simples: vendas do dia, produtos mais vendidos, estoque baixo.
9. Adicionar/remover apelidos de produtos.
10. Adicionar/remover clientes da whitelist de atendimento.

COMO INTERPRETAR PEDIDOS:
- O Luiz vai falar de forma natural, não em comandos formais. Exemplos e como tratar:
  - "não responde mais esse número 987655909" → bloquear_numero
  - "desbloqueia o numero X" → desbloquear_numero
  - "esse grupo aqui não é pra ela responder" / cita nome de grupo → se a mensagem do Luiz tiver a marcação "[MENSAGEM ENCAMINHADA DE OUTRO CHAT — JID de origem: ...]" no início, use esse JID direto na ferramenta bloquear_grupo, sem precisar perguntar nada. Se não tiver essa marcação, peça pro Luiz encaminhar (forward) qualquer mensagem do grupo que ele quer bloquear direto pra esse chat — não peça "o JID" porque ele pode não saber o que é isso.
  - "Primobolan tá em falta" / "acabou o X" → marcar_produto_falta E marcar_produto_falta_revenda (atualiza as DUAS tabelas simultaneamente — cliente e fornecedor/revendedor)
  - "chegou de novo o X" → marcar_produto_falta + marcar_produto_falta_revenda com emFalta: false (também nas duas)
  - "atualiza o preço da Trembolona Lander Land pra 220" → substituir_categoria_catalogo (catálogo cliente) — SEMPRE no catálogo, nunca atualizar_preco
  - "manda essa tabela nova pra substituir Deca" (e cola texto) → substituir_categoria_catalogo
  - "isso é preço de revenda" / "responde como revendedor" → use a versão de revenda das ferramentas de catálogo quando disponível, ou avise no campo correto
  - "Cliente Monique tem desconto de 10%" → definir_desconto_cliente
  - "marca o João como VIP" → marcar_cliente_vip
  - "o Luiz (IA) não pode falar 'mano' nunca mais" / "proíbe esse emoji ⚠️" / qualquer ajuste de tom, palavra ou emoji proibido → atualizar_regra_luiz
  - "como tá o estoque?" / "quanto vendeu hoje?" → usar ferramentas de consulta e responder com os dados
  - "cria um grupo novo de revendedor, nome Pedro, jid tal" → adicionar_grupo_revendedor
  - "esquece a conversa" / "limpa o histórico" / "começa do zero" → limpar_historico_admin
  - "responde grupo Ziraldo desconto de 10 mingau" / "fala pro cliente 5521999: frete é R$30" → enviar_mensagem_cliente. IMPORTANTE: quando Luiz mandar só um número seguido de mensagem (ex: "5521992671289 enviar desconto de 15 mingau"), isso é um comando pra enviar aquela mensagem pro cliente com aquele número — NÃO é pra bloquear ou outra ação. O número é o destino, o resto é a mensagem.
- Se a intenção estiver clara, EXECUTE a ferramenta direto e confirme o que foi feito. Não fique pedindo confirmação extra para ações simples e reversíveis (bloqueio, preço, desconto).
- Se faltar informação crítica (ex: qual número bloquear, qual produto, qual valor), pergunte só o que falta, de forma curta.
- Sempre que uma ação for executada, responda confirmando objetivamente o que mudou. Ex: "Bloqueado! Esse número não recebe mais resposta." ou "Preço da Trembolona Lander Land atualizado no catálogo."

IMPORTANTE:
- Nunca minta sobre uma ação ter sido feita. Só confirme depois que a ferramenta retornar sucesso.
- Se uma ferramenta falhar, explique o erro real pro Luiz, de forma direta.
- Você está em modo "controle interno" — não tem moderação de vendas aqui, é gestão pura do negócio.`;
}

module.exports = {
  registrarReferencias,
  limparHistoricoAdmin,
  buildSystemPromptAdmin,
  client,
};

// ── Ferramentas do agente administrativo ──────────────────────
const TOOLS_ADMIN = [
  {
    name: 'atualizar_mes_planilha',
    description: 'Atualiza qual aba/mês da planilha de estoque o sistema deve usar para consultar produtos e quantidades. Use quando o Luiz humano avisar que mudou o mês ou que a aba mudou (ex: "atualiza que estamos em junho", "agora é a aba de julho").',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Nome do mês em português, minúsculo, exatamente como está escrito na aba da planilha (ex: "junho", "julho")' }
      },
      required: ['mes']
    }
  },
  {
    name: 'substituir_categoria_catalogo',
    description: 'Substitui o texto completo de uma categoria do catálogo de produtos (ex: quando o Luiz humano manda uma tabela nova pronta, com preços atualizados, pra substituir a categoria de durateston, masteron, etc). Cria a categoria se ela ainda não existir.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Nome da categoria (ex: durateston, masteron, enantato, deca, trembolona, oxandrolona, primobolan, peptideos, gh, emagrecedores, ou uma categoria nova)' },
        textoNovo: { type: 'string', description: 'Texto completo da tabela pronta, no mesmo estilo/formatação das tabelas existentes' }
      },
      required: ['categoria', 'textoNovo']
    }
  },
  {
    name: 'marcar_produto_falta',
    description: 'Marca ou desmarca um item específico (uma marca/variação dentro de uma categoria) como em falta no catálogo. Use quando o Luiz humano falar que acabou ou que chegou de novo um produto específico (ex: "acabou o Masteron Swiss", "chegou Durateston Cooper de novo").',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Categoria do produto (ex: masteron, durateston)' },
        trechoNomeItem: { type: 'string', description: 'Trecho específico do nome do item pra identificar a linha certa (ex: "Propionato - Swiss" em vez de só "Swiss", pra evitar ambiguidade entre variações da mesma marca)' },
        emFalta: { type: 'boolean', description: 'true para marcar como em falta, false para remover a marcação (voltou ao estoque)' }
      },
      required: ['categoria', 'trechoNomeItem', 'emFalta']
    }
  },
  {
    name: 'ver_catalogo_categoria',
    description: 'Mostra o texto completo atual de uma categoria do catálogo, útil pro Luiz humano confirmar o que está cadastrado antes de editar.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string' }
      },
      required: ['categoria']
    }
  },
  {
    name: 'listar_categorias_catalogo',
    description: 'Lista todas as categorias de produto disponíveis no catálogo atual (preço de cliente final, não revenda).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'restaurar_catalogo_padrao',
    description: 'Restaura o catálogo de cliente final para o padrão original do código, apagando qualquer edição salva em disco. Use quando o Luiz humano pedir "restaura o catálogo", "volta pro padrão" ou similar.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'registrar_entrada_estoque',
    description: 'Registra chegada de produtos no estoque. Use quando o Luiz falar "chegou X unidades de [produto]" ou "dá entrada em X [produto]". O sistema usa a tradução das siglas pra encontrar o produto pelo nome.',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string', description: 'Nome do produto (ex: "Masteron Cooper", "Durateston Lander Land", "M. C")' },
        quantidade: { type: 'number', description: 'Quantidade que chegou' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'registrar_saida_estoque',
    description: 'Registra saída de produtos do estoque (venda). Use quando o Luiz falar "vendeu X [produto]" ou encaminhar finalização de venda. Pode incluir nome do cliente e tipo de venda (normal ou revendedor).',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string', description: 'Nome do produto (ex: "Masteron Cooper", "Durateston Lander Land")' },
        quantidade: { type: 'number', description: 'Quantidade vendida' },
        cliente:    { type: 'string', description: 'Nome do cliente (opcional, pra consultas futuras)' },
        tipoVenda:  { type: 'string', description: '"normal" ou "revendedor"', enum: ['normal', 'revendedor'] }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'relatorio_estoque',
    description: 'Mostra o estoque atual de todos os produtos com quantidade disponível. Use quando o Luiz pedir "como tá o estoque", "relatório de estoque" ou similar.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'relatorio_vendas_dia',
    description: 'Mostra todas as vendas registradas no dia atual. Use quando o Luiz pedir "relatório de vendas", "o que vendeu hoje" ou similar.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'buscar_venda_cliente',
    description: 'Busca vendas registradas pelo nome do cliente. Use quando o Luiz perguntar "registrou a venda do Fernando?" ou "tem venda do [nome]?".',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente pra buscar' }
      },
      required: ['cliente']
    }
  },
  {
    name: 'substituir_categoria_catalogo_revenda',
    description: 'Substitui o texto completo de uma categoria no CATÁLOGO DE REVENDA (preço diferenciado pra revendedor, separado do catálogo de cliente final). Use quando o Luiz humano mandar uma tabela de preço específica pra revendedor.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Nome da categoria (ex: durateston, masteron, etc)' },
        textoNovo: { type: 'string', description: 'Texto completo da tabela de revenda pronta' }
      },
      required: ['categoria', 'textoNovo']
    }
  },
  {
    name: 'marcar_produto_falta_revenda',
    description: 'Marca ou desmarca um item específico como em falta no CATÁLOGO DE REVENDA (separado do catálogo de cliente final).',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string' },
        trechoNomeItem: { type: 'string', description: 'Trecho específico do nome do item pra identificar a linha certa' },
        emFalta: { type: 'boolean' }
      },
      required: ['categoria', 'trechoNomeItem', 'emFalta']
    }
  },
  {
    name: 'ver_catalogo_categoria_revenda',
    description: 'Mostra o texto completo atual de uma categoria do CATÁLOGO DE REVENDA (preço de revendedor, separado do catálogo de cliente final).',
    input_schema: {
      type: 'object',
      properties: { categoria: { type: 'string' } },
      required: ['categoria']
    }
  },
  {
    name: 'listar_categorias_catalogo_revenda',
    description: 'Lista todas as categorias de produto disponíveis no CATÁLOGO DE REVENDA (preço de revendedor).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'limpar_historico_admin',
    description: 'Apaga o histórico da conversa atual do Admin, começando do zero. Use quando o Luiz humano pedir algo como "esquece a conversa", "limpa o histórico" ou "começa do zero" — serve pra reduzir custo, já que conversas longas ficam mais caras por mensagem.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'enviar_mensagem_cliente',
    description: 'Envia uma mensagem do Luiz humano diretamente pro chat de um cliente ou grupo, sem o Luiz precisar ir lá. Use quando Luiz falar "responde [nome/número] [mensagem]" ou "fala pra [cliente] que [mensagem]". Luiz pode repassar cotação de frete, desconto, qualquer info. O agente replica a mensagem no chat do destino.',
    input_schema: {
      type: 'object',
      properties: {
        destino: { type: 'string', description: 'Número do cliente (ex: 5521999998888) ou nome do grupo (ex: Ziraldo, Big Jeff)' },
        mensagem: { type: 'string', description: 'Mensagem exata a enviar' }
      },
      required: ['destino', 'mensagem']
    }
  },
  {
    name: 'bloquear_numero',
    description: 'Bloqueia um número de telefone — o agente de vendas nunca mais responde esse número.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string', description: 'Número de telefone, com ou sem formatação' } },
      required: ['numero']
    }
  },
  {
    name: 'desbloquear_numero',
    description: 'Remove um número da lista de bloqueio, voltando a ser atendido normalmente.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
  {
    name: 'listar_bloqueados',
    description: 'Lista todos os números e grupos atualmente bloqueados.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'bloquear_grupo',
    description: 'Bloqueia um grupo do WhatsApp pelo JID — o agente nunca responde nesse grupo.',
    input_schema: {
      type: 'object',
      properties: { jid: { type: 'string', description: 'JID do grupo, formato 12036xxxx@g.us' } },
      required: ['jid']
    }
  },
  {
    name: 'consultar_estoque_completo',
    description: 'Lista todos os produtos do estoque com quantidade e preço, incluindo os zerados.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'consultar_produto',
    description: 'Busca um produto específico no estoque pelo nome.',
    input_schema: {
      type: 'object',
      properties: { nome: { type: 'string' } },
      required: ['nome']
    }
  },
  {
    name: 'dar_entrada_estoque',
    description: 'Dá entrada de quantidade em um produto do estoque, podendo atualizar o preço também.',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string' },
        quantidade: { type: 'number' },
        preco:      { type: 'number', description: 'Opcional, novo preço de venda' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'dar_saida_estoque',
    description: 'Dá saída/baixa manual de quantidade em um produto (ex: produto vencido, perdido, ou venda não registrada pelo sistema).',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string' },
        quantidade: { type: 'number' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'atualizar_preco',
    description: 'Atualiza o preço de venda de um produto existente no estoque.',
    input_schema: {
      type: 'object',
      properties: {
        produto: { type: 'string' },
        preco:   { type: 'number' }
      },
      required: ['produto', 'preco']
    }
  },
  {
    name: 'consultar_pedidos_dia',
    description: 'Lista os pedidos despachados hoje (cliente, itens, horário).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'atualizar_regra_luiz',
    description: 'Adiciona uma instrução/regra extra que passa a valer imediatamente para o Luiz vendedor (IA), em tempo real. Use para ajustes de tom, frases proibidas, novos comportamentos.',
    input_schema: {
      type: 'object',
      properties: { regra: { type: 'string', description: 'A instrução em texto livre, será injetada no system prompt do Luiz vendedor' } },
      required: ['regra']
    }
  },
  {
    name: 'ver_regras_luiz',
    description: 'Mostra as regras extras atualmente ativas para o Luiz vendedor.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'limpar_regras_luiz',
    description: 'Remove todas as regras extras adicionadas, voltando ao comportamento padrão do Luiz vendedor.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'definir_desconto_cliente',
    description: 'Define um desconto para um cliente específico pelo número. Pode ser permanente (fica sempre) ou pontual (só pra próxima compra, some depois de usar). Use quando Luiz falar "dá X% de desconto pro cliente Y" (permanente) ou "dá X% só nessa compra pro cliente Y" (pontual).',
    input_schema: {
      type: 'object',
      properties: {
        numero:             { type: 'string' },
        descontoPercentual: { type: 'number', description: 'Ex: 10 para 10%' },
        pontual:            { type: 'boolean', description: 'true = só pra próxima compra (some depois de usar). false ou omitido = permanente.' }
      },
      required: ['numero', 'descontoPercentual']
    }
  },
  {
    name: 'marcar_cliente_vip',
    description: 'Marca um cliente como VIP — o Luiz vendedor passa a tratá-lo com mais intimidade/prioridade.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
  {
    name: 'adicionar_observacao_cliente',
    description: 'Adiciona uma observação/nota sobre um cliente específico, que o Luiz vendedor vai considerar nas próximas conversas.',
    input_schema: {
      type: 'object',
      properties: {
        numero:    { type: 'string' },
        observacao: { type: 'string' }
      },
      required: ['numero', 'observacao']
    }
  },
  {
    name: 'adicionar_grupo_revendedor',
    description: 'Adiciona um novo grupo do WhatsApp como grupo de revendedor — o Luiz vendedor passa a usar preço de revenda lá.',
    input_schema: {
      type: 'object',
      properties: {
        jid:  { type: 'string' },
        nome: { type: 'string' }
      },
      required: ['jid', 'nome']
    }
  },
  {
    name: 'remover_grupo_revendedor',
    description: 'Remove um grupo da lista de revendedores.',
    input_schema: {
      type: 'object',
      properties: { jid: { type: 'string' } },
      required: ['jid']
    }
  },
  {
    name: 'listar_grupos_revendedores',
    description: 'Lista todos os grupos de revendedores cadastrados.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'adicionar_cliente_autorizado',
    description: 'Adiciona um número à whitelist de clientes autorizados a receber resposta do agente.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
  {
    name: 'remover_cliente_autorizado',
    description: 'Remove um número da whitelist de clientes autorizados.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
];

function limparNumeroAdmin(numero) {
  return String(numero).replace(/\D/g, '');
}

// ── Executor de ferramentas administrativas ───────────────────
async function executarFerramentaAdmin(nome, input) {
  console.log(`[AdminTool] ${nome}`, input);

  switch (nome) {

    case 'atualizar_mes_planilha': {
      const resultado = estoque.definirAbaAtiva(input.mes);
      return { resultado };
    }

    case 'substituir_categoria_catalogo': {
      const resultado = catalogo.definirCategoria(input.categoria, input.textoNovo);
      return { resultado };
    }

    case 'marcar_produto_falta': {
      const resultado = catalogo.marcarItemFalta(input.categoria, input.trechoNomeItem, input.emFalta);
      return { resultado };
    }

    case 'ver_catalogo_categoria': {
      const texto = catalogo.getCategoria(input.categoria);
      return { resultado: texto || `Categoria "${input.categoria}" não encontrada.` };
    }

    case 'listar_categorias_catalogo': {
      return { resultado: catalogo.listarCategorias() };
    }

    case 'restaurar_catalogo_padrao': {
      const resultado = catalogo.restaurarPadrao();
      return { resultado };
    }

    case 'registrar_entrada_estoque': {
      const resultado = estoqueAdmin.registrarEntrada(input.produto, input.quantidade, input.cliente || null);
      return { resultado };
    }

    case 'registrar_saida_estoque': {
      const resultado = estoqueAdmin.registrarSaida(input.produto, input.quantidade, input.cliente || null, input.tipoVenda || 'normal');
      return { resultado };
    }

    case 'relatorio_estoque': {
      const resultado = estoqueAdmin.relatorioEstoque();
      return { resultado };
    }

    case 'relatorio_vendas_dia': {
      const resultado = estoqueAdmin.relatorioVendas();
      return { resultado };
    }

    case 'buscar_venda_cliente': {
      const resultado = estoqueAdmin.buscarVendaPorCliente(input.cliente);
      return { resultado };
    }

    case 'substituir_categoria_catalogo_revenda': {
      const resultado = catalogo.definirCategoria(input.categoria, input.textoNovo, 'revenda');
      return { resultado };
    }

    case 'marcar_produto_falta_revenda': {
      const resultado = catalogo.marcarItemFalta(input.categoria, input.trechoNomeItem, input.emFalta, 'revenda');
      return { resultado };
    }

    case 'ver_catalogo_categoria_revenda': {
      const texto = catalogo.getCategoria(input.categoria, 'revenda');
      return { resultado: texto || `Categoria "${input.categoria}" não encontrada no catálogo de revenda.` };
    }

    case 'listar_categorias_catalogo_revenda': {
      return { resultado: catalogo.listarCategorias('revenda') };
    }

    case 'limpar_historico_admin': {
      _limparHistoricoAposResposta = true;
      return { resultado: { ok: true, mensagem: 'Histórico será limpo após esta resposta.' } };
    }

    case 'enviar_mensagem_cliente': {
      const { enviarTexto } = require('../webhook/evolution');
      const { getSessao } = require('../agent/agente');
      const destino = String(input.destino).trim();
      const mensagem = String(input.mensagem).trim();

      // Tenta resolver o destino: pode ser número direto ou nome de grupo
      let jidDestino = null;
      let numeroDestino = null;

      // Se for número (só dígitos), monta JID de pessoa
      if (/^\d+$/.test(destino)) {
        numeroDestino = destino;
        jidDestino = `${destino}@s.whatsapp.net`;
      } else {
        // Busca pelo nome do grupo nos grupos de revendedores/fornecedores
        const gruposRev = _refs.gruposRevendedores || {};
        for (const [jid, nome] of Object.entries(gruposRev)) {
          if (nome.toLowerCase().includes(destino.toLowerCase())) {
            jidDestino = jid;
            break;
          }
        }
      }

      if (!jidDestino) {
        return { resultado: { ok: false, erro: `Não encontrei destino "${destino}". Tenta com o número direto (ex: 5521999998888) ou o nome exato do grupo.` } };
      }

      try {
        await enviarTexto(jidDestino, mensagem);

        // Registra a mensagem no histórico do cliente pra IA ter contexto
        if (numeroDestino) {
          try {
            const sessao = getSessao(numeroDestino);
            sessao.historico.push({ role: 'assistant', content: `[Luiz via Admin]: ${mensagem}` });
          } catch (_) {}
        }

        return { resultado: { ok: true, destino: jidDestino, mensagem } };
      } catch (err) {
        return { resultado: { ok: false, erro: err.message } };
      }
    }

    case 'bloquear_numero': {
      const n = limparNumeroAdmin(input.numero);
      _refs.numerosBloqueados?.add(n);
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, numero: n } };
    }

    case 'desbloquear_numero': {
      const n = limparNumeroAdmin(input.numero);
      const existia = _refs.numerosBloqueados?.delete(n);
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: !!existia, numero: n } };
    }

    case 'listar_bloqueados': {
      return {
        resultado: {
          numeros: Array.from(_refs.numerosBloqueados || []),
          grupos: Array.from(_refs.gruposBloqueados || [])
        }
      };
    }

    case 'bloquear_grupo': {
      _refs.gruposBloqueados?.add(input.jid);
      if (_refs.gruposRevendedores && _refs.gruposRevendedores[input.jid]) {
        delete _refs.gruposRevendedores[input.jid];
      }
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, jid: input.jid } };
    }

    case 'consultar_estoque_completo': {
      const lista = estoque.listarTodosProdutos();
      return { resultado: lista };
    }

    case 'consultar_produto': {
      const encontrados = estoque.buscarProduto(input.nome);
      return { resultado: encontrados.length ? encontrados : `Produto "${input.nome}" não encontrado.` };
    }

    case 'dar_entrada_estoque': {
      const r = estoque.entrarEstoque(input.produto, input.quantidade, input.preco ?? null);
      return { resultado: r };
    }

    case 'dar_saida_estoque': {
      const r = estoque.baixarEstoque(input.produto, input.quantidade);
      return { resultado: r };
    }

    case 'atualizar_preco': {
      const r = estoque.atualizarPreco(input.produto, input.preco);
      return { resultado: r };
    }

    case 'consultar_pedidos_dia': {
      const hoje = new Date().toDateString();
      const pedidosHoje = (_refs.pedidosDoDia || []).filter(p => new Date(p.hora).toDateString() === hoje);
      return { resultado: pedidosHoje.length ? pedidosHoje : 'Nenhum pedido registrado hoje ainda.' };
    }

    case 'atualizar_regra_luiz': {
      _refs.regrasExtras.texto = (_refs.regrasExtras.texto + '\n- ' + input.regra).trim();
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, regrasAtuais: _refs.regrasExtras.texto } };
    }

    case 'ver_regras_luiz': {
      return { resultado: _refs.regrasExtras.texto || 'Nenhuma regra extra ativa.' };
    }

    case 'limpar_regras_luiz': {
      _refs.regrasExtras.texto = '';
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true } };
    }

    case 'definir_desconto_cliente': {
      const n = limparNumeroAdmin(input.numero);
      _refs.clientesEspeciais[n] = {
        ..._refs.clientesEspeciais[n],
        desconto: input.descontoPercentual,
        descontoPontual: input.pontual === true
      };
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, numero: n, desconto: input.descontoPercentual, pontual: input.pontual === true } };
    }

    case 'marcar_cliente_vip': {
      const n = limparNumeroAdmin(input.numero);
      _refs.clientesEspeciais[n] = { ..._refs.clientesEspeciais[n], vip: true };
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, numero: n } };
    }

    case 'adicionar_observacao_cliente': {
      const n = limparNumeroAdmin(input.numero);
      const atual = _refs.clientesEspeciais[n] || {};
      const obsAtuais = atual.observacoes || [];
      _refs.clientesEspeciais[n] = { ...atual, observacoes: [...obsAtuais, input.observacao] };
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, numero: n } };
    }

    case 'adicionar_grupo_revendedor': {
      if (_refs.gruposRevendedores) _refs.gruposRevendedores[input.jid] = input.nome;
      return { resultado: { ok: true, jid: input.jid, nome: input.nome } };
    }

    case 'remover_grupo_revendedor': {
      const existia = _refs.gruposRevendedores && _refs.gruposRevendedores[input.jid];
      if (existia && _refs.gruposRevendedores) delete _refs.gruposRevendedores[input.jid];
      return { resultado: { ok: !!existia, jid: input.jid } };
    }

    case 'listar_grupos_revendedores': {
      return { resultado: _refs.gruposRevendedores || {} };
    }

    case 'adicionar_cliente_autorizado': {
      const r = adicionarContato(input.numero);
      return { resultado: r };
    }

    case 'remover_cliente_autorizado': {
      const r = removerContato(input.numero);
      return { resultado: r };
    }

    default:
      return { resultado: `Ferramenta administrativa desconhecida: ${nome}` };
  }
}

// ── Loop principal do agente administrativo ───────────────────
async function processarMensagemAdmin(textoMensagem, conteudoMultimodal = null) {
  // Se vier conteúdo multimodal (ex: imagem em base64), usa ele como o
  // "content" da mensagem em vez do texto puro — a API da Anthropic lê
  // imagem nativamente nesse formato.
  historicoAdmin.push({ role: 'user', content: conteudoMultimodal || textoMensagem });

  if (historicoAdmin.length > 30) {
    historicoAdmin = historicoAdmin.slice(-30);
  }

  let resposta = null;
  let tentativasDeReset = 0;
  const MAX_TENTATIVAS_RESET = 2; // limite de segurança pra nunca entrar em loop infinito

  while (true) {
    let resultado;
    try {
      resultado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: buildSystemPromptAdmin(),
        tools: TOOLS_ADMIN,
        messages: historicoAdmin
      });
    } catch (errApi) {
      console.error('[Admin] ERRO BRUTO da API Anthropic:', JSON.stringify(errApi?.error || errApi?.message || errApi), '| status:', errApi?.status);
      // IMPORTANTE: "histórico corrompido" e "crédito esgotado" retornam
      // o MESMO status HTTP (400) — precisa checar a mensagem real pra
      // não confundir os dois. Resetar histórico não resolve falta de
      // crédito, e fazer isso mascarava o problema real (visto no log
      // de produção: ficava "resetando" repetidamente quando na
      // verdade já tinha estourado o saldo).
      const errType = errApi?.error?.error?.type || errApi?.error?.type || '';
      const errMsgBruta = (errApi?.error?.error?.message || errApi?.message || '').toLowerCase();
      const ehSemCredito =
        errApi?.status === 400 && /credit|balance|billing/.test(errMsgBruta) ||
        errApi?.status === 403 && /credit|balance/.test(errMsgBruta);

      if (ehSemCredito) {
        console.error('[Admin] CRÉDITOS ESGOTADOS na Anthropic:', errMsgBruta);
        const grupoAdmin = process.env.ADMIN_GROUP_JID;
        if (grupoAdmin) {
          try {
            const { enviarTexto } = require('../webhook/evolution');
            await enviarTexto(grupoAdmin, '🚨 *Créditos da Anthropic esgotados!*\n\nAcessa console.anthropic.com e recarrega pra voltar a funcionar.');
          } catch (_) {}
        }
        throw errApi;
      }

      const ehErroEstrutura = errApi?.status === 400;

      if (ehErroEstrutura && tentativasDeReset < MAX_TENTATIVAS_RESET) {
        tentativasDeReset++;
        console.error(`[Admin] Histórico corrompido, resetando (tentativa ${tentativasDeReset}/${MAX_TENTATIVAS_RESET}). Erro:`, errApi?.message || errApi);
        historicoAdmin = [{ role: 'user', content: conteudoMultimodal || textoMensagem }];
        // CRÍTICO: salva o reset em disco IMEDIATAMENTE, mesmo que essa
        // tentativa ainda venha a falhar de novo. Isso impede que o
        // histórico corrompido fique permanentemente travado em disco
        // e continue dando erro pra sempre em mensagens futuras —
        // foi exatamente isso que causou o gasto de crédito em loop.
        salvarHistoricoAdminNoDisco();
        continue;
      }

      // Esgotou as tentativas de reset, ou não é erro de estrutura.
      // Em qualquer um dos casos, garante que o que está em disco
      // não fica travado: zera o histórico antes de propagar o erro,
      // pra próxima mensagem já começar limpa.
      if (ehErroEstrutura) {
        console.error('[Admin] Esgotadas as tentativas de reset. Zerando histórico por segurança.');
        historicoAdmin = [];
        salvarHistoricoAdminNoDisco();
      }
      throw errApi;
    }

    console.log('[Admin] stop_reason:', resultado.stop_reason, '| blocos de conteúdo:', resultado.content?.map(b => b.type).join(','));

    if (resultado.stop_reason === 'tool_use') {
      historicoAdmin.push({ role: 'assistant', content: resultado.content });

      const toolResults = [];
      for (const bloco of resultado.content) {
        if (bloco.type === 'tool_use') {
          let conteudoResultado;
          try {
            const saida = await executarFerramentaAdmin(bloco.name, bloco.input);
            conteudoResultado = JSON.stringify(saida.resultado);
          } catch (errFerramenta) {
            console.error(`[AdminTool] Erro ao executar ${bloco.name}:`, errFerramenta);
            // Passa o erro REAL pra IA poder comunicar com precisão,
            // em vez de uma mensagem genérica que a IA acaba parafraseando
            // de forma estranha (tipo "2 endpoints falharam").
            conteudoResultado = JSON.stringify({
              erro: true,
              mensagem: `Erro real ao executar ${bloco.name}: ${errFerramenta.message || errFerramenta}`
            });
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: bloco.id,
            content: conteudoResultado
          });
        }
      }

      historicoAdmin.push({ role: 'user', content: toolResults });
      continue;
    }

    resposta = resultado.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    historicoAdmin.push({ role: 'assistant', content: resposta });
    break;
  }

  salvarHistoricoAdminNoDisco();

  // Se a ferramenta limpar_historico_admin foi chamada nesta rodada,
  // limpa DEPOIS de já ter salvo a resposta atual — assim a confirmação
  // ("histórico limpo!") chega normal pro Luiz antes de zerar tudo.
  if (_limparHistoricoAposResposta) {
    _limparHistoricoAposResposta = false;
    historicoAdmin = [];
    salvarHistoricoAdminNoDisco();
    console.log('[Admin] Histórico limpo a pedido do Luiz humano.');
  }

  return resposta || null;
}

module.exports.processarMensagemAdmin = processarMensagemAdmin;
module.exports.registrarPedidoNoRelatorio = function (pedido) {
  _refs.pedidosDoDia = _refs.pedidosDoDia || [];
  _refs.pedidosDoDia.push({ hora: Date.now(), ...pedido });
};
module.exports.getClienteEspecial = function (numero) {
  return _refs.clientesEspeciais?.[limparNumeroAdmin(numero)] || null;
};
module.exports.zerarDescontoPontual = function (numero) {
  const n = limparNumeroAdmin(numero);
  if (_refs.clientesEspeciais?.[n]) {
    delete _refs.clientesEspeciais[n].desconto;
    delete _refs.clientesEspeciais[n].descontoPontual;
    salvarEstadoAdminNoDisco();
  }
};
module.exports.getRegrasExtras = function () {
  return _refs.regrasExtras?.texto || '';
};
