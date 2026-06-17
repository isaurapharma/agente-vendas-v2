// src/agent/admin.js
// Agente administrativo: roda no grupo Admin, entende linguagem natural
// do Luiz humano e executa ações de gestão do negócio.

const Anthropic = require('@anthropic-ai/sdk');
const estoque   = require('../stock/estoque');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
const { adicionarContato, removerContato, listarContatos } = require('../stock/contatos');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function registrarReferencias(refs) {
  _refs = { ..._refs, ...refs };
}

// ── Histórico de conversa do grupo admin (persistido em disco) ───
const fs   = require('fs');
const path = require('path');

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

function limparHistoricoAdmin() {
  historicoAdmin = [];
  salvarHistoricoAdminNoDisco();
}

// ── System Prompt do agente administrativo ────────────────────
function buildSystemPromptAdmin() {
  return `Você é o assistente administrativo da Force Imports. Você conversa diretamente com o Luiz (dono/gerente humano) dentro do grupo Admin do WhatsApp. Aqui NÃO existe papel de vendedor nem personalidade carioca de venda — é uma conversa de trabalho, direta e eficiente, entre você e o Luiz.

QUEM FALA COM VOCÊ:
- Só o Luiz humano (ou pessoas de confiança dele) estão neste grupo.
- Trate como conversa de gestão: direto, sem rodeios, sem precisar ser "simpático" do jeito do agente de vendas.
- Pode usar linguagem natural, mas sempre confirmando o que foi feito de forma clara.

O QUE VOCÊ PODE FAZER (use as ferramentas disponíveis):
1. Bloquear/desbloquear números de telefone e grupos de WhatsApp — o agente de vendas (Luiz IA) nunca responde quem está bloqueado.
2. Consultar e editar estoque: ver produtos, quantidades, preços; dar entrada ou saída manual.
3. Consultar pedidos/vendas do dia, histórico de vendas.
4. Ajustar regras e comportamento do Luiz vendedor (tom de voz, frases proibidas, novas instruções) — isso se aplica em tempo real na próxima mensagem que ele responder.
5. Gerenciar clientes especiais: desconto fixo, marcar como VIP, adicionar observações sobre o cliente.
6. Gerenciar grupos de revendedores: adicionar novo grupo de revendedor, remover, listar.
7. Gerar relatórios simples: vendas do dia, produtos mais vendidos, estoque baixo.
8. Adicionar/remover apelidos de produtos.
9. Adicionar/remover clientes da whitelist de atendimento.

COMO INTERPRETAR PEDIDOS:
- O Luiz vai falar de forma natural, não em comandos formais. Exemplos e como tratar:
  - "não responde mais esse número 987655909" → bloquear_numero
  - "desbloqueia o numero X" → desbloquear_numero
  - "esse grupo aqui não é pra ela responder" / cita nome de grupo → se a mensagem do Luiz tiver a marcação "[MENSAGEM ENCAMINHADA DE OUTRO CHAT — JID de origem: ...]" no início, use esse JID direto na ferramenta bloquear_grupo, sem precisar perguntar nada. Se não tiver essa marcação, peça pro Luiz encaminhar (forward) qualquer mensagem do grupo que ele quer bloquear direto pra esse chat — não peça "o JID" porque ele pode não saber o que é isso.
  - "Primobolan tá em falta" / "acabou o X" → dar_saida_manual ou avisar pra zerar estoque
  - "atualiza o preço da Trembolona pra 220" → atualizar_preco
  - "Cliente Monique tem desconto de 10%" → definir_desconto_cliente
  - "marca o João como VIP" → marcar_cliente_vip
  - "o Luiz (IA) não pode falar 'mano' nunca mais" / qualquer ajuste de tom → atualizar_regra_luiz
  - "como tá o estoque?" / "quanto vendeu hoje?" → usar ferramentas de consulta e responder com os dados
  - "cria um grupo novo de revendedor, nome Pedro, jid tal" → adicionar_grupo_revendedor
- Se a intenção estiver clara, EXECUTE a ferramenta direto e confirme o que foi feito. Não fique pedindo confirmação extra para ações simples e reversíveis (bloqueio, preço, desconto).
- Se faltar informação crítica (ex: qual número bloquear, qual produto, qual valor), pergunte só o que falta, de forma curta.
- Sempre que uma ação for executada, responda confirmando objetivamente o que mudou. Ex: "Bloqueado! Esse número não recebe mais resposta." ou "Preço da Trembolona Lander Land atualizado pra R$220."

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
    description: 'Define um desconto percentual fixo para um cliente específico pelo número.',
    input_schema: {
      type: 'object',
      properties: {
        numero:           { type: 'string' },
        descontoPercentual: { type: 'number', description: 'Ex: 10 para 10%' }
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

    case 'bloquear_numero': {
      const n = limparNumeroAdmin(input.numero);
      _refs.numerosBloqueados?.add(n);
      return { resultado: { ok: true, numero: n } };
    }

    case 'desbloquear_numero': {
      const n = limparNumeroAdmin(input.numero);
      const existia = _refs.numerosBloqueados?.delete(n);
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
      return { resultado: { ok: true, regrasAtuais: _refs.regrasExtras.texto } };
    }

    case 'ver_regras_luiz': {
      return { resultado: _refs.regrasExtras.texto || 'Nenhuma regra extra ativa.' };
    }

    case 'limpar_regras_luiz': {
      _refs.regrasExtras.texto = '';
      return { resultado: { ok: true } };
    }

    case 'definir_desconto_cliente': {
      const n = limparNumeroAdmin(input.numero);
      _refs.clientesEspeciais[n] = { ..._refs.clientesEspeciais[n], desconto: input.descontoPercentual };
      return { resultado: { ok: true, numero: n, desconto: input.descontoPercentual } };
    }

    case 'marcar_cliente_vip': {
      const n = limparNumeroAdmin(input.numero);
      _refs.clientesEspeciais[n] = { ..._refs.clientesEspeciais[n], vip: true };
      return { resultado: { ok: true, numero: n } };
    }

    case 'adicionar_observacao_cliente': {
      const n = limparNumeroAdmin(input.numero);
      const atual = _refs.clientesEspeciais[n] || {};
      const obsAtuais = atual.observacoes || [];
      _refs.clientesEspeciais[n] = { ...atual, observacoes: [...obsAtuais, input.observacao] };
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
async function processarMensagemAdmin(textoMensagem) {
  historicoAdmin.push({ role: 'user', content: textoMensagem });

  if (historicoAdmin.length > 60) {
    historicoAdmin = historicoAdmin.slice(-60);
  }

  let resposta = null;

  while (true) {
    let resultado;
    try {
      resultado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: buildSystemPromptAdmin(),
        tools: TOOLS_ADMIN,
        messages: historicoAdmin
      });
    } catch (errApi) {
      const ehErroEstrutura = errApi?.status === 400;
      if (ehErroEstrutura && historicoAdmin.length > 1) {
        console.error('[Admin] Histórico corrompido, resetando. Erro:', errApi?.message || errApi);
        historicoAdmin = [{ role: 'user', content: textoMensagem }];
        continue;
      }
      throw errApi;
    }

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
            conteudoResultado = JSON.stringify({ erro: true, mensagem: 'Erro interno ao executar a ação.' });
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
module.exports.getRegrasExtras = function () {
  return _refs.regrasExtras?.texto || '';
};
