// src/agent/agente.js
// Agente IA com Claude — gerencia conversa, ferramentas e decisões

const Anthropic = require('@anthropic-ai/sdk');
const estoque   = require('../stock/estoque');
const { despacharPedido } = require('../dispatch/pedido');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// Memória de sessões por número de WhatsApp
// (em produção, migre para Redis ou banco de dados)
// ─────────────────────────────────────────────
const sessoes = new Map();

function getSessao(numero) {
  if (!sessoes.has(numero)) {
    sessoes.set(numero, {
      historico: [],
      carrinho: [],         // [{ id, nome, quantidade, precoUnit }]
      aguardandoPix: false,
      pedidoPendente: null
    });
  }
  return sessoes.get(numero);
}

function limparCarrinho(numero) {
  const s = getSessao(numero);
  s.carrinho = [];
  s.aguardandoPix = false;
  s.pedidoPendente = null;
}

// ─────────────────────────────────────────────
// System Prompt — personalidade e regras do agente
// ─────────────────────────────────────────────
function buildSystemPrompt() {
  const freteFixo  = Number(process.env.FRETE_FIXO || 10);
  const freteGratis = Number(process.env.FRETE_GRATIS_ACIMA || 150);
  const pixKey     = process.env.PIX_KEY;
  const pixName    = process.env.PIX_NAME;

  return `Você é o assistente de vendas da loja, mas responde como um amigo próximo e descontraído — sem formalidade, sem "prezado cliente", sem "atenciosamente". Use linguagem natural, emojis com moderação, e seja direto ao ponto.

REGRAS DE COMPORTAMENTO:
- Responda sempre em português brasileiro informal
- Seja rápido e objetivo, mas simpático
- Não use linguagem corporativa
- Se o cliente perguntar algo que você não sabe, seja honesto
- Nunca invente preços ou produtos — sempre consulte o estoque

FRETE:
- Frete fixo: R$ ${freteFixo.toFixed(2)}
- Frete grátis para pedidos acima de R$ ${freteGratis.toFixed(2)}
- Sempre informe o frete antes de fechar o pedido

PAGAMENTO PIX:
- Chave PIX: ${pixKey}
- Nome: ${pixName}
- Após o cliente confirmar o pedido, envie a chave PIX e o valor total
- Aguarde o comprovante no chat
- Quando receber o comprovante, confirme o pagamento e avise que o pedido foi para entrega

ENTRADA DE ESTOQUE (somente para o dono):
- Mensagens começando com "ESTOQUE" são comandos do dono da loja
- Exemplo: "ESTOQUE ENTRADA: Camiseta XG, 10 unidades, R$49.90"
- Processe a entrada e confirme

CARRINHO:
- Mantenha o carrinho atualizado durante a conversa
- Antes de fechar, sempre confirme todos os itens e o total com frete
- Só dê baixa no estoque APÓS confirmar o PIX

FERRAMENTAS DISPONÍVEIS:
Use as ferramentas para todas as operações de estoque. Nunca suponha o estoque — sempre consulte.`;
}

// ─────────────────────────────────────────────
// Definição das ferramentas (tools) do Claude
// ─────────────────────────────────────────────
const TOOLS = [
  {
    name: 'listar_produtos',
    description: 'Lista todos os produtos disponíveis em estoque.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'buscar_produto',
    description: 'Busca produto pelo nome (busca parcial). Use quando o cliente pede um produto específico.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Nome ou parte do nome do produto' }
      },
      required: ['termo']
    }
  },
  {
    name: 'consultar_estoque',
    description: 'Consulta estoque e preço de um produto específico pelo nome exato ou ID.',
    input_schema: {
      type: 'object',
      properties: {
        produto: { type: 'string', description: 'Nome exato ou ID do produto' }
      },
      required: ['produto']
    }
  },
  {
    name: 'baixar_estoque',
    description: 'Dá baixa no estoque após pagamento PIX confirmado. Só use APÓS confirmar o pagamento.',
    input_schema: {
      type: 'object',
      properties: {
        produto: { type: 'string', description: 'Nome exato ou ID do produto' },
        quantidade: { type: 'number', description: 'Quantidade vendida' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'entrar_estoque',
    description: 'Dá entrada de produtos no estoque (para o dono da loja).',
    input_schema: {
      type: 'object',
      properties: {
        produto: { type: 'string', description: 'Nome do produto' },
        quantidade: { type: 'number', description: 'Quantidade a adicionar' },
        preco: { type: 'number', description: 'Preço unitário (obrigatório para produtos novos)' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'despachar_pedido',
    description: 'Envia o pedido confirmado para o grupo de entrega (motoboy/ajudante). Use após confirmar o PIX.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome:       { type: 'string' },
        clienteNumero:     { type: 'string' },
        itens:             {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nome:        { type: 'string' },
              quantidade:  { type: 'number' },
              precoUnit:   { type: 'number' }
            }
          }
        },
        subtotal:          { type: 'number' },
        frete:             { type: 'number' },
        total:             { type: 'number' },
        enderecoEntrega:   { type: 'string' },
        observacoes:       { type: 'string' }
      },
      required: ['clienteNumero', 'itens', 'subtotal', 'frete', 'total']
    }
  },
  {
    name: 'calcular_total',
    description: 'Calcula subtotal + frete com base nos itens do carrinho.',
    input_schema: {
      type: 'object',
      properties: {
        subtotal: { type: 'number', description: 'Soma dos itens sem frete' }
      },
      required: ['subtotal']
    }
  }
];

// ─────────────────────────────────────────────
// Executor de ferramentas
// ─────────────────────────────────────────────
async function executarFerramenta(nome, input, sessao, clienteNumero) {
  console.log(`[Tool] ${nome}`, input);

  switch (nome) {

    case 'listar_produtos': {
      const lista = estoque.listarProdutos();
      if (lista.length === 0) return { resultado: 'Nenhum produto disponível no momento.' };
      return { resultado: lista };
    }

    case 'buscar_produto': {
      const encontrados = estoque.buscarProduto(input.termo);
      if (encontrados.length === 0) return { resultado: `Nenhum produto encontrado para "${input.termo}".` };
      return { resultado: encontrados };
    }

    case 'consultar_estoque': {
      const prod = estoque.consultarEstoque(input.produto);
      if (!prod) return { resultado: `Produto "${input.produto}" não encontrado.` };
      return { resultado: prod };
    }

    case 'baixar_estoque': {
      const r = estoque.baixarEstoque(input.produto, input.quantidade);
      return { resultado: r };
    }

    case 'entrar_estoque': {
      const r = estoque.entrarEstoque(input.produto, input.quantidade, input.preco || null);
      return { resultado: r };
    }

    case 'calcular_total': {
      const freteFixo   = Number(process.env.FRETE_FIXO || 10);
      const freteGratis = Number(process.env.FRETE_GRATIS_ACIMA || 150);
      const subtotal    = Number(input.subtotal);
      const frete       = subtotal >= freteGratis ? 0 : freteFixo;
      const total       = subtotal + frete;
      return { resultado: { subtotal, frete, total, freteGratis: frete === 0 } };
    }

    case 'despachar_pedido': {
      const r = await despacharPedido({ ...input, clienteNumero });
      // Após despachar, limpa a sessão
      if (r.ok) limparCarrinho(clienteNumero);
      return { resultado: r };
    }

    default:
      return { resultado: `Ferramenta desconhecida: ${nome}` };
  }
}

// ─────────────────────────────────────────────
// Loop principal do agente (agentic loop)
// ─────────────────────────────────────────────
async function processarMensagem(clienteNumero, mensagemTexto, clienteNome = 'cliente') {
  const sessao = getSessao(clienteNumero);

  // Adiciona mensagem do usuário ao histórico
  sessao.historico.push({ role: 'user', content: mensagemTexto });

  // Limita histórico a 40 mensagens para não explodir o contexto
  if (sessao.historico.length > 40) {
    sessao.historico = sessao.historico.slice(-40);
  }

  let resposta = null;

  // ── Agentic loop: continua até o Claude parar de chamar ferramentas ──
  while (true) {
    const resultado = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages: sessao.historico
    });

    // Se o Claude quer usar ferramentas
    if (resultado.stop_reason === 'tool_use') {
      // Adiciona a resposta do assistente (com tool_use) ao histórico
      sessao.historico.push({ role: 'assistant', content: resultado.content });

      // Processa cada ferramenta solicitada
      const toolResults = [];
      for (const bloco of resultado.content) {
        if (bloco.type === 'tool_use') {
          const saida = await executarFerramenta(bloco.name, bloco.input, sessao, clienteNumero);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: bloco.id,
            content: JSON.stringify(saida.resultado)
          });
        }
      }

      // Adiciona resultados das ferramentas ao histórico e continua o loop
      sessao.historico.push({ role: 'user', content: toolResults });
      continue;
    }

    // Claude terminou — extrai o texto de resposta
    resposta = resultado.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Adiciona resposta final ao histórico
    sessao.historico.push({ role: 'assistant', content: resposta });
    break;
  }

  return resposta || '(sem resposta)';
}

module.exports = { processarMensagem, getSessao };
