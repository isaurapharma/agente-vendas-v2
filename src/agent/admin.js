// src/agent/admin.js
// Agente administrativo: roda no grupo Admin, entende linguagem natural
// do Luiz humano e executa ações de gestão do negócio.

const Anthropic = require('@anthropic-ai/sdk');
const catalogo      = require('../stock/catalogo');
const estoqueAdmin  = require('../stock/estoque-admin');
// FIX: importa estoque.js com o nome correto para os cases que usavam
// a variável `estoque` indefinida (dar_entrada_estoque, dar_saida_estoque, etc.)
const estoque       = require('../stock/estoque');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
const { adicionarContato, removerContato, listarContatos } = require('../stock/contatos');
const fs   = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Persistência do estado administrativo ─────────────────────
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
      numerosBloqueados:  new Set(dados.numerosBloqueados  || []),
      gruposBloqueados:   new Set(dados.gruposBloqueados   || []),
      // FIX: gruposRevendedores agora é persistido no estado admin
      gruposRevendedores: dados.gruposRevendedores || {},
      regrasExtras:       dados.regrasExtras       || { texto: '' },
      clientesEspeciais:  dados.clientesEspeciais  || {},
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
      numerosBloqueados:  Array.from(_refs.numerosBloqueados  || []),
      gruposBloqueados:   Array.from(_refs.gruposBloqueados   || []),
      // FIX: persiste gruposRevendedores
      gruposRevendedores: _refs.gruposRevendedores || {},
      regrasExtras:       _refs.regrasExtras       || { texto: '' },
      clientesEspeciais:  _refs.clientesEspeciais  || {},
    };
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Admin] Erro ao salvar estado administrativo no disco:', err.message);
  }
}

// ── Estado compartilhado em memória ──────────────────────────
let _refs = {
  numerosBloqueados:  null,
  gruposBloqueados:   null,
  gruposRevendedores: null,
  regrasExtras:       { texto: '' },
  clientesEspeciais:  {},
  pedidosDoDia:       [],
};

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
    // FIX: restaura gruposRevendedores salvos em disco
    if (salvo.gruposRevendedores && Object.keys(salvo.gruposRevendedores).length && _refs.gruposRevendedores) {
      Object.assign(_refs.gruposRevendedores, salvo.gruposRevendedores);
    }
    if (salvo.regrasExtras?.texto) {
      _refs.regrasExtras = salvo.regrasExtras;
    }
    if (salvo.clientesEspeciais && Object.keys(salvo.clientesEspeciais).length) {
      _refs.clientesEspeciais = { ..._refs.clientesEspeciais, ...salvo.clientesEspeciais };
    }
    console.log('[Admin] Estado administrativo restaurado do disco (regras, bloqueios, revendedores, clientes especiais).');
  }
}

// ── Histórico do grupo admin ──────────────────────────────────
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
1. Bloquear/desbloquear números de telefone e grupos de WhatsApp.
2. Controle de ESTOQUE: registrar entrada (registrar_entrada_estoque), registrar saída (registrar_saida_estoque), ver estoque atual (relatorio_estoque), ver vendas do dia (relatorio_vendas_dia), buscar venda por cliente (buscar_venda_cliente).
3. Editar o CATÁLOGO de preço de venda (cliente final e revenda).
4. Consultar pedidos/vendas do dia, histórico de vendas.
5. Ajustar regras e comportamento do Luiz vendedor em tempo real.
6. Gerenciar clientes especiais: desconto fixo, marcar como VIP, adicionar observações.
7. Gerenciar grupos de revendedores: adicionar, remover, listar.
8. Gerar relatórios simples: vendas do dia, estoque.
9. Adicionar/remover apelidos de produtos.
10. Adicionar/remover clientes da whitelist de atendimento.

COMO INTERPRETAR PEDIDOS:
- O Luiz vai falar de forma natural. Exemplos:
  - "não responde mais esse número X" → bloquear_numero
  - "desbloqueia o numero X" → desbloquear_numero
  - "esse grupo aqui não é pra ela responder" → bloquear_grupo com JID do forward
  - "Primobolan tá em falta" / "acabou o X" → marcar_produto_falta E marcar_produto_falta_revenda OBRIGATORIAMENTE nas DUAS tabelas simultaneamente — estoque é o mesmo pra cliente e revendedor, só o preço muda
  - "chegou de novo o X" → marcar_produto_falta E marcar_produto_falta_revenda com emFalta: false nas DUAS tabelas — nunca atualizar só uma
  - "atualiza o preço da Trembolona Lander pra 220" → substituir_categoria_catalogo (catálogo cliente) — se Luiz não especificar revenda, atualiza só o cliente
  - "atualiza o preço de revenda da Trembolona Lander pra 185" → substituir_categoria_catalogo_revenda
  - "Cliente Monique tem desconto de 10%" → definir_desconto_cliente com descontoPercentual: 10
  - "dá R$50 de desconto pro cliente X" → definir_desconto_cliente com descontoReais: 50
  - "faz o Masteron por R$180 pro cliente X" → definir_desconto_cliente com precoFixo: 180
  - "desconto só nessa compra" → definir_desconto_cliente com pontual: true
  - "o Luiz (IA) não pode falar 'mano' nunca mais" → atualizar_regra_luiz
  - "como tá o estoque?" → relatorio_estoque
  - "quanto vendeu hoje?" → relatorio_vendas_dia
  - "cria um grupo novo de revendedor, nome Pedro, jid tal" → adicionar_grupo_revendedor
  - "esquece a conversa" / "limpa o histórico" → limpar_historico_admin
  - "responde grupo Ziraldo que..." ou "fala pro cliente 5521999: ..." → enviar_mensagem_cliente
- Se a intenção estiver clara, EXECUTE direto e confirme. Não fique pedindo confirmação para ações simples.
- Se faltar informação crítica, pergunte só o que falta, de forma curta.
- Sempre que uma ação for executada, responda confirmando objetivamente o que mudou.

IMPORTANTE:
- Nunca minta sobre uma ação ter sido feita. Só confirme depois que a ferramenta retornar sucesso.
- Se uma ferramenta falhar, explique o erro real pro Luiz, de forma direta.
- Você está em modo "controle interno" — não tem moderação de vendas aqui, é gestão pura do negócio.`;
}

// ── Ferramentas do agente administrativo ─────────────────────
const TOOLS_ADMIN = [
  {
    name: 'atualizar_mes_planilha',
    description: 'Atualiza qual aba/mês da planilha de estoque o sistema deve usar.',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Nome do mês em português, minúsculo (ex: "junho", "julho")' }
      },
      required: ['mes']
    }
  },
  {
    name: 'substituir_categoria_catalogo',
    description: 'Substitui o texto completo de uma categoria do catálogo de produtos.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string' },
        textoNovo: { type: 'string' }
      },
      required: ['categoria', 'textoNovo']
    }
  },
  {
    name: 'marcar_produto_falta',
    description: 'Marca ou desmarca um item específico como em falta no catálogo de cliente final.',
    input_schema: {
      type: 'object',
      properties: {
        categoria:      { type: 'string' },
        trechoNomeItem: { type: 'string', description: 'Trecho específico do nome do item' },
        emFalta:        { type: 'boolean' }
      },
      required: ['categoria', 'trechoNomeItem', 'emFalta']
    }
  },
  {
    name: 'ver_catalogo_categoria',
    description: 'Mostra o texto completo atual de uma categoria do catálogo de cliente final.',
    input_schema: {
      type: 'object',
      properties: { categoria: { type: 'string' } },
      required: ['categoria']
    }
  },
  {
    name: 'listar_categorias_catalogo',
    description: 'Lista todas as categorias do catálogo de cliente final.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'restaurar_catalogo_padrao',
    description: 'Restaura o catálogo de cliente final para o padrão original do código.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'registrar_entrada_estoque',
    description: 'Registra chegada de produtos no estoque admin.',
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
    name: 'registrar_saida_estoque',
    description: 'Registra saída de produtos do estoque admin (venda).',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string' },
        quantidade: { type: 'number' },
        cliente:    { type: 'string' },
        tipoVenda:  { type: 'string', enum: ['normal', 'revendedor'] }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'relatorio_estoque',
    description: 'Mostra o estoque atual de todos os produtos registrados no sistema admin.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'relatorio_vendas_dia',
    description: 'Mostra todas as vendas registradas no dia atual.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'buscar_venda_cliente',
    description: 'Busca vendas registradas pelo nome do cliente.',
    input_schema: {
      type: 'object',
      properties: { cliente: { type: 'string' } },
      required: ['cliente']
    }
  },
  {
    name: 'substituir_categoria_catalogo_revenda',
    description: 'Substitui o texto completo de uma categoria no CATÁLOGO DE REVENDA.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string' },
        textoNovo: { type: 'string' }
      },
      required: ['categoria', 'textoNovo']
    }
  },
  {
    name: 'marcar_produto_falta_revenda',
    description: 'Marca ou desmarca um item específico como em falta no CATÁLOGO DE REVENDA.',
    input_schema: {
      type: 'object',
      properties: {
        categoria:      { type: 'string' },
        trechoNomeItem: { type: 'string' },
        emFalta:        { type: 'boolean' }
      },
      required: ['categoria', 'trechoNomeItem', 'emFalta']
    }
  },
  {
    name: 'ver_catalogo_categoria_revenda',
    description: 'Mostra o texto completo atual de uma categoria do CATÁLOGO DE REVENDA.',
    input_schema: {
      type: 'object',
      properties: { categoria: { type: 'string' } },
      required: ['categoria']
    }
  },
  {
    name: 'listar_categorias_catalogo_revenda',
    description: 'Lista todas as categorias do CATÁLOGO DE REVENDA.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'limpar_historico_admin',
    description: 'Apaga o histórico da conversa atual do Admin, começando do zero.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'enviar_mensagem_cliente',
    description: 'Envia uma mensagem do Luiz humano diretamente pro chat de um cliente ou grupo.',
    input_schema: {
      type: 'object',
      properties: {
        destino:  { type: 'string', description: 'Número do cliente (ex: 5521999998888) ou nome do grupo' },
        mensagem: { type: 'string' }
      },
      required: ['destino', 'mensagem']
    }
  },
  {
    name: 'liberar_pedido_fiado',
    description: 'Libera um pedido pra entrega sem PIX.',
    input_schema: {
      type: 'object',
      properties: {
        numero:     { type: 'string' },
        observacao: { type: 'string' }
      },
      required: ['numero']
    }
  },
  {
    name: 'bloquear_numero',
    description: 'Bloqueia um número de telefone — o agente de vendas nunca mais responde esse número.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
  {
    name: 'desbloquear_numero',
    description: 'Remove um número da lista de bloqueio.',
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
    description: 'Bloqueia um grupo do WhatsApp pelo JID.',
    input_schema: {
      type: 'object',
      properties: { jid: { type: 'string' } },
      required: ['jid']
    }
  },
  {
    name: 'consultar_estoque_completo',
    description: 'Lista todos os produtos do estoque (planilha Excel) com quantidade.',
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
    description: 'Dá entrada de quantidade em um produto do estoque (planilha Excel).',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string' },
        quantidade: { type: 'number' },
        preco:      { type: 'number', description: 'Opcional' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'dar_saida_estoque',
    description: 'Dá saída manual de quantidade em um produto (planilha Excel).',
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
    description: 'Atualiza o preço de um produto na planilha de estoque.',
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
    description: 'Lista os pedidos despachados hoje.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'atualizar_regra_luiz',
    description: 'Adiciona uma instrução/regra extra para o Luiz vendedor (IA) em tempo real.',
    input_schema: {
      type: 'object',
      properties: { regra: { type: 'string' } },
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
    description: 'Remove todas as regras extras do Luiz vendedor.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'definir_desconto_cliente',
    description: `Define desconto ou preço especial para um cliente. Aceita três formatos:
- Porcentagem: "dá 10% de desconto pro cliente X" → descontoPercentual: 10
- Valor em reais: "dá R$50 de desconto pro cliente X" → descontoReais: 50
- Preço fixo: "faz o Masteron por R$180 pro cliente X" → precoFixo: 180 (substitui o total inteiro)
Pode ser permanente (fica sempre) ou pontual (só pra próxima compra).`,
    input_schema: {
      type: 'object',
      properties: {
        numero:             { type: 'string', description: 'Número do cliente' },
        descontoPercentual: { type: 'number', description: 'Desconto em % (ex: 10 para 10%). Use OU descontoPercentual OU descontoReais OU precoFixo.' },
        descontoReais:      { type: 'number', description: 'Desconto em valor fixo em reais (ex: 50 para R$50 de desconto no total)' },
        precoFixo:          { type: 'number', description: 'Preço fixo total do pedido em reais — substitui o total calculado (ex: 180 para cobrar R$180 independente do produto)' },
        pontual:            { type: 'boolean', description: 'true = só pra próxima compra (some depois de usar). false ou omitido = permanente.' }
      },
      required: ['numero']
    }
  },
  {
    name: 'marcar_cliente_vip',
    description: 'Marca um cliente como VIP.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero']
    }
  },
  {
    name: 'adicionar_observacao_cliente',
    description: 'Adiciona uma observação sobre um cliente específico.',
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
    description: 'Adiciona um novo grupo do WhatsApp como grupo de revendedor.',
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
    description: 'Adiciona um número à whitelist de clientes autorizados.',
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
      const destino = String(input.destino).trim();
      const mensagem = String(input.mensagem).trim();

      let jidDestino = null;
      let numeroDestino = null;

      if (/^\d+$/.test(destino)) {
        numeroDestino = destino;
        jidDestino = `${destino}@s.whatsapp.net`;
      } else {
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

        if (numeroDestino) {
          try {
            const { getSessao, salvarSessoesNoDisco, liberarPausaLuiz } = require('../agent/agente');
            const sessao = getSessao(numeroDestino);
            sessao.historico.push({ role: 'user', content: `[Mensagem enviada pelo Luiz pro cliente]: ${mensagem}` });
            liberarPausaLuiz(numeroDestino);
            salvarSessoesNoDisco();
          } catch (_) {}
        }

        return { resultado: { ok: true, destino: jidDestino, mensagem } };
      } catch (err) {
        return { resultado: { ok: false, erro: err.message } };
      }
    }

    case 'liberar_pedido_fiado': {
      const { enviarTexto } = require('../webhook/evolution');
      const { getSessao, salvarSessoesNoDisco, liberarPausaLuiz } = require('../agent/agente');
      const numero = String(input.numero).replace(/\D/g, '');
      const jid = `${numero}@s.whatsapp.net`;
      const obs = input.observacao ? ` (${input.observacao})` : '';

      try {
        await enviarTexto(jid, `Liberado! Já separei seu pedido 🫡${obs}`);

        const sessao = getSessao(numero);
        sessao.historico.push({ role: 'user', content: `[Luiz liberou o pedido sem PIX${obs}] — despache o pedido pro Admin agora seguindo todas as regras normais (etiqueta, resumo).` });
        liberarPausaLuiz(numero);
        salvarSessoesNoDisco();

        return { resultado: { ok: true, numero, mensagem: 'Cliente avisado e pedido liberado pra despacho.' } };
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
          grupos:  Array.from(_refs.gruposBloqueados  || [])
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

    // FIX: era `estoque.*` (variável indefinida) — agora usa `estoque` importado corretamente
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
      // Valida que pelo menos um tipo de desconto foi informado
      if (input.descontoPercentual == null && input.descontoReais == null && input.precoFixo == null) {
        return { resultado: { ok: false, erro: 'Informe descontoPercentual, descontoReais ou precoFixo.' } };
      }
      _refs.clientesEspeciais[n] = {
        ..._refs.clientesEspeciais[n],
        // Salva apenas o tipo informado, limpa os outros
        desconto:       input.descontoPercentual ?? null,
        descontoReais:  input.descontoReais      ?? null,
        precoFixo:      input.precoFixo          ?? null,
        descontoPontual: input.pontual === true
      };
      salvarEstadoAdminNoDisco();
      const tipo = input.precoFixo != null ? `preço fixo R$${input.precoFixo}`
                 : input.descontoReais != null ? `R$${input.descontoReais} de desconto`
                 : `${input.descontoPercentual}% de desconto`;
      return { resultado: { ok: true, numero: n, tipo, pontual: input.pontual === true } };
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
      // FIX: persiste em disco (antes não salvava)
      salvarEstadoAdminNoDisco();
      return { resultado: { ok: true, jid: input.jid, nome: input.nome } };
    }

    case 'remover_grupo_revendedor': {
      const existia = _refs.gruposRevendedores && _refs.gruposRevendedores[input.jid];
      if (existia && _refs.gruposRevendedores) delete _refs.gruposRevendedores[input.jid];
      // FIX: persiste em disco (antes não salvava)
      salvarEstadoAdminNoDisco();
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
  // FIX: protege contra null em ambos os campos antes de salvar no histórico
  const conteudoHistorico = conteudoMultimodal || (textoMensagem ? textoMensagem : '[mensagem vazia]');
  historicoAdmin.push({ role: 'user', content: conteudoHistorico });

  if (historicoAdmin.length > 30) {
    historicoAdmin = historicoAdmin.slice(-30);
  }

  let resposta = null;
  let tentativasDeReset = 0;
  const MAX_TENTATIVAS_RESET = 2;

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

      const errType   = errApi?.error?.error?.type || errApi?.error?.type || '';
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

      // FIX: verificação mais precisa — igual ao agente.js, checa o type
      // para não confundir outros erros 400 com histórico corrompido
      const ehErroEstrutura = errApi?.status === 400 &&
        (errApi?.error?.error?.type === 'invalid_request_error' || errApi?.error?.type === 'invalid_request_error');

      if (ehErroEstrutura && tentativasDeReset < MAX_TENTATIVAS_RESET) {
        tentativasDeReset++;
        console.error(`[Admin] Histórico corrompido, resetando (tentativa ${tentativasDeReset}/${MAX_TENTATIVAS_RESET}).`);
        historicoAdmin = [{ role: 'user', content: conteudoHistorico }];
        salvarHistoricoAdminNoDisco();
        continue;
      }

      if (ehErroEstrutura) {
        console.error('[Admin] Esgotadas as tentativas de reset. Zerando histórico por segurança.');
        historicoAdmin = [];
        salvarHistoricoAdminNoDisco();
      }
      throw errApi;
    }

    console.log('[Admin] stop_reason:', resultado.stop_reason, '| blocos:', resultado.content?.map(b => b.type).join(','));

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

    historicoAdmin.push({ role: 'assistant', content: resultado.content });
    break;
  }

  salvarHistoricoAdminNoDisco();

  if (_limparHistoricoAposResposta) {
    _limparHistoricoAposResposta = false;
    historicoAdmin = [];
    salvarHistoricoAdminNoDisco();
    console.log('[Admin] Histórico limpo a pedido do Luiz humano.');
  }

  return resposta || null;
}

// FIX: module.exports único e completo no final do arquivo
// (antes havia um exports parcial no meio do arquivo na linha 190)
module.exports = {
  registrarReferencias,
  limparHistoricoAdmin,
  buildSystemPromptAdmin,
  processarMensagemAdmin,
  client,
  registrarPedidoNoRelatorio(pedido) {
    _refs.pedidosDoDia = _refs.pedidosDoDia || [];
    _refs.pedidosDoDia.push({ hora: Date.now(), ...pedido });
  },
  getClienteEspecial(numero) {
    return _refs.clientesEspeciais?.[limparNumeroAdmin(numero)] || null;
  },
  zerarDescontoPontual(numero) {
    const n = limparNumeroAdmin(numero);
    if (_refs.clientesEspeciais?.[n]) {
      delete _refs.clientesEspeciais[n].desconto;
      delete _refs.clientesEspeciais[n].descontoReais;
      delete _refs.clientesEspeciais[n].precoFixo;
      delete _refs.clientesEspeciais[n].descontoPontual;
      salvarEstadoAdminNoDisco();
    }
  },
  getRegrasExtras() {
    return _refs.regrasExtras?.texto || '';
  }
};
