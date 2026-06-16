// src/agent/agente.js
const Anthropic = require('@anthropic-ai/sdk');
const estoque   = require('../stock/estoque');
const { enviarTexto } = require('../webhook/evolution');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessoes = new Map();

function getSessao(numero) {
  if (!sessoes.has(numero)) {
    sessoes.set(numero, {
      historico: [],
      carrinho: [],
      aguardandoPix: false,
      pedidoPendente: null,
      luizHumanoAtivo: false,
      luizHumanoUltimaMsg: null,
      endereco: null,
      frete: null
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

// ── Fretes por bairro ─────────────────────────
const FRETES = {
  10: ['ipanema','copacabana','leme','leblon'],
  15: ['botafogo','lagoa','urca'],
  20: ['flamengo','gloria','glória','gavea','gávea','catete','humaita','humaitá']
};

function calcularFrete(endereco) {
  if (!endereco) return null;
  const end = endereco.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [valor, bairros] of Object.entries(FRETES)) {
    if (bairros.some(b => end.includes(b))) return Number(valor);
  }
  return null; // frete desconhecido — chamar Luiz humano
}

// ── Catálogo de produtos (tabelas prontas) ─────
const CATALOGO = {
  durateston: `✅ *Durateston - Cooper Farmacêutica* 🇮🇳 ( Linha premium)
*250mg/ml. Cx com 10 AMPOLAS*
R$360

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Pharmacom* 🇪🇺 ( Linha premium)
*300mg/ml. Frasco 10ml*
R$330

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Bratva Labs* ✴️
*250mg/ml. Cx com 10 AMPOLA*
R$250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Lander Land Gold* 🥇
*250mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Muscle Labs* 🐍
*250mg/ml Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - King Pharma* 👑
*250mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Swiss Pharma* 🧬
*250mg/ml. Frasco 10ml*
R$140`,

  enantato: `✅ *Enantato de Testosterona - Eminence* 🇮🇳 (Importada)
*250mg/ml. Cx com 10 AMPOLAS*
R$360

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Bratva Labs* ✴️
*250mg/ml. Cx com 10 AMPOLA*
R$250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Lander Land Gold* 🥇
*250mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Muscle Labs* 🐍
*250mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - King Pharma* 👑
*250mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Swiss Pharma* 🧬
*250mg/ml. Frasco 10ml*
R$140`,

  masteron: `✅️ *Masteron Propionato - Cooper Pharma* 🇮🇳
*100mg/ml. Cx com 10 Ampolas*
R$450

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Lander Land Gold* 🥇
*100mg/ml. Frasco 10ml*
R$220

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Bratva Labs* ✴️
*100mg/ml. Frasco 10ml*
R$200

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$140

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Enantato - King Pharma* 👑
*100mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Enantato - Swiss Pharma* 🧬
*200mg/ml. Frasco 10ml*
R$160`,

  primobolan: `✅️ *Primobolan - Muscle Labs* 🐍
*100mg/ml. Frasco 10ml*
R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Primobolan - King Pharma* 👑
*100mg/ml. Frasco 10ml*
R$320

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Primobolan - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$230`,

  deca: `✅ *Deca - Pharmacom* 🇪🇺 (Linha premium)
*300mg/ml. Cx com 10 AMPOLAS*
R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Deca - Oxygen* 🇰🇼 (Importada)
*250mg/ml. Cx com 10 AMPOLAS*
R$270

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - Lander Land Gold* 🥇
*200mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Deca - Muscle Labs* 🐍
*300mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - King Pharma* 👑
*300mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - Swiss Pharma* 🧬
*300mg/ml. Frasco 10ml*
R$140`,

  trembolona: `✅️ *Trembolona Acetato - Lander Land Gold* 🥇
*100mg/ml. Frasco 10ml*
R$230

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Trembolona Acetato - Muscle Labs* 🐍
*100mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Trembolona Acetato - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$140

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

☑️ *Trembolona Enantato - Lander Land Gold* 🥇
*200mg/ml. Frasco 10ml*
R$220

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

☑️ *Trembolona Enantato - Swiss Pharma* 🧬
*200mg/ml. Frasco 10ml*
R$150`,

  oxandrolona: `✅️ *Oxandrolona - Lander Land*
*10mg/cps. Frasco 50 comprimidos*
R$240

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona - Lander Land*
*5mg/cps. Frasco 100 comprimidos*
R$240

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona Manipulada* 🧬
*20mg/cps. Frasco 100 comprimidos*
R$200

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona Manipulada* 🧬
*10mg/cps. Frasco 100 comprimidos*
R$150`,

  peptideos: `✅ *Peptídeos - GEN HEATH* 🧬 (Importado)

📍GHK-cu 100mg — R$850
📍Most-C 10mg — R$750
📍Ipamorelin 10mg — R$750
📍HGH Frag 176-191 5mg — R$750
📍BPC 157 10mg — R$750

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Peptídeos - ZPHC* 🧬 (Importado)

Ipamorelin 5mg — R$370
TB500 5mg — R$370

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *NEO Peptídeos* 🧬 (Importado)

GHK-CU 100mg — R$650

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Better Performance* 🧬 (Nacional)

Tesamorelin 5mg — R$180
TB 500 5mg — R$180
GHRp6 5mg — R$180
Slupp 332 5mg — R$180`,

  gh: `💎 *GH Somatropina (Biomanguinhos)*
*Caixa com 4ui* — R$60
🚨 (Valor para pedidos acima de 10 cxs)

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

💎 *GH Genotropin caneta 36ui*
R$1.250`,

  emagrecedores: `✅ *Retatrutida - ZPHC*
Cx fechada 120mg (5 frascos 24mg c/ diluente) — R$4.300
Frasco 24mg c/ diluente — R$920

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Retatrutida - Oxygen*
Frasco 40mg c/ diluente — R$1.450

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *LIPOLESS (Tirzepatida)*
Cx fechada 60mg — R$1.200
Frasco 15mg — R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Ozempic caneta 1mg* — R$1.250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

🔥 *Clembuterol - Lander Land Gold*
Caixa 50 comprimidos 0.04mg — R$150

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

🔥 *Lipostabil*
5 ampolas 5ml cada — R$140`
};

// ── System Prompt do Luiz ─────────────────────
function buildSystemPrompt(foraDoHorario = false, msgHorario = "") {
  const pixKey  = process.env.PIX_KEY;
  const pixName = process.env.PIX_NAME;

  return `Você é o Luiz, vendedor da loja. Não é um robô, não é um agente — é o Luiz mesmo.

PERSONALIDADE:
- Linguagem carioca, urbana, descontraída. Sem formalidade nenhuma.
- Usa: opa, bora, fechou, partiu, pra cima, ai papaiii, boa garotão, masss rapazzz, c é loko, tá blz, tá legal, brother
- Dinheiro = "mingau" (ex: "180 mingau", "10 mingau de entrega")
- Com clientes conhecidos pode chamar de "amigo", usar "vc é fechamento" e afins
- Com clientes novos, mais tranquilo, sem intimidade forçada
- Às vezes faz piadas atuais ou imita o Silvio Santos: "mah oieeee... vem pra k vem pra k... é jequiti q vc qr" 😄
- Escreve pouco. Direto ao ponto.
- Nunca usa: "posso te ajudar em algo mais", "prezado", "atenciosamente", "como posso ajudar", frases formais
- Nunca fala o nome da loja pro cliente
- Nunca pergunta orçamento
- Nunca força venda — fala do produto e deixa o cliente decidir
- "vc é fechamento" só com clientes conhecidos

CONHECIMENTO:
- Expert em hormônios, suplementos e peptídeos
- Conhece profundamente: testosterona, primobolan, masteron, trembolona, deca, oxandrolona, GH, peptídeos (GHK-Cu, BPC-157, TB500, Ipamorelin etc), clembuterol, tirzepatida, retatrutida, ozempic
- Sabe sobre organismo masculino e feminino, ciclos, protocolos, efeitos colaterais, pós-ciclo
- Quando cliente perguntar dosagem/protocolo: responde de forma prática e sempre menciona que acompanhamento médico ajuda a monitorar com exames (mas sem exagerar na recomendação)
- Para mulheres: sabe que Masteron preserva feminilidade, Primobolan é mais seguro, doses menores

CATÁLOGO disponível em JSON para consulta quando precisar

FRETE E ENTREGA:
- Entrega em qualquer lugar — bairros fixos e Correios
- Bairros com frete fixo: calculado automaticamente
- Bairros fora da lista: fala "só um minuto que já coto!" e aciona o Luiz humano (sem explicar que é fora da zona)
- Correios: quando cliente perguntar, fala "Envio sim! Me passa o CEP que já coto pra você 😄" e usa a ferramenta cotar_correios com o CEP do cliente
- Nunca mencionar "zona fixa", "fora da área" ou similares — sempre positivo

PAGAMENTO:
- Somente PIX
- Após cliente querer fechar: passa o valor do produto primeiro
- Quando cliente confirmar: soma com frete e usa a ferramenta enviar_pix
- PIX enviado em duas mensagens separadas (instruções + chave sozinha pra copiar fácil)
- Só dá baixa no estoque e despacha pro grupo APÓS confirmar o PIX

LUIZ HUMANO:
- Quando precisar acionar o Luiz humano (frete desconhecido ou situação complexa): diz "só um minuto!" e usa a ferramenta acionar_luiz_humano
- Após Luiz humano intervir: aguarda 15 minutos sem responder após última msg do cliente
- Depois retoma normalmente

MENSAGEM DE ENTREGA CONFIRMADA:
Após despachar o pedido, enviar ao cliente:
"✅️ Está entregue!

🚨Por favor, confira o pedido no mesmo dia! Não nos responsabilizamos por danos após o dia da entrega.

*MUITO OBRIGADO E BONS GANHOS!* 💪😄"

PAGAMENTO PIX:
- Nome: ${pixName}
- Chave: ${pixKey}
- Banco: Santander

HORÁRIO:
${foraDoHorario ? `⚠️ ${msgHorario} Pode receber pedido e PIX normalmente, mas deixa claro quando será a entrega. Não precisa repetir isso em toda mensagem, só quando relevante.` : "Horário de entrega: seg-sex 12h às 20h, sábado 12h às 16h. Entrega somente após confirmação do PIX."}\`;
}

// ── Ferramentas ───────────────────────────────
const TOOLS = [
  {
    name: 'listar_produtos',
    description: 'Lista todos os produtos disponíveis em estoque.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'buscar_produto',
    description: 'Busca produto pelo nome (busca parcial, resolve apelidos).',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Nome ou apelido do produto' }
      },
      required: ['termo']
    }
  },
  {
    name: 'consultar_estoque',
    description: 'Consulta estoque e preço de um produto específico.',
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
    description: 'Dá baixa no estoque após PIX confirmado.',
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
    name: 'entrar_estoque',
    description: 'Dá entrada de produtos no estoque (dono da loja).',
    input_schema: {
      type: 'object',
      properties: {
        produto:    { type: 'string' },
        quantidade: { type: 'number' },
        preco:      { type: 'number' }
      },
      required: ['produto', 'quantidade']
    }
  },
  {
    name: 'enviar_catalogo',
    description: 'Envia a tabela/catálogo de um produto específico para o cliente, no formato exato das mensagens prontas.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Categoria do produto: durateston, enantato, masteron, primobolan, deca, trembolona, oxandrolona, peptideos, gh, emagrecedores'
        }
      },
      required: ['categoria']
    }
  },
  {
    name: 'calcular_frete',
    description: 'Calcula o frete com base no endereço do cliente. Retorna o valor ou null se precisar acionar Luiz humano.',
    input_schema: {
      type: 'object',
      properties: {
        endereco: { type: 'string', description: 'Endereço completo do cliente' }
      },
      required: ['endereco']
    }
  },
  {
    name: 'cotar_correios',
    description: 'Cota o frete pelos Correios (PAC e SEDEX) a partir do CEP do cliente. CEP de origem: Copacabana (22020-000).',
    input_schema: {
      type: 'object',
      properties: {
        cepDestino: { type: 'string', description: 'CEP do cliente (só números)' },
        pesoGramas: { type: 'number', description: 'Peso do pedido em gramas (padrão 300g por frasco)' }
      },
      required: ['cepDestino']
    }
  },
  {
    name: 'acionar_luiz_humano',
    description: 'Aciona o Luiz humano para situações que precisam de intervenção manual (frete desconhecido, desconto especial, etc). Envia notificação pro grupo admin.',
    input_schema: {
      type: 'object',
      properties: {
        motivo:  { type: 'string', description: 'Motivo do acionamento' },
        cliente: { type: 'string', description: 'Número ou nome do cliente' }
      },
      required: ['motivo', 'cliente']
    }
  },
  {
    name: 'enviar_pix',
    description: 'Envia dados do PIX ao cliente em duas mensagens: instruções e chave separada para copiar fácil.',
    input_schema: {
      type: 'object',
      properties: {
        total: { type: 'number', description: 'Valor total a pagar' }
      },
      required: ['total']
    }
  },
  {
    name: 'despachar_pedido',
    description: 'Envia pedido pro grupo de entrega após PIX confirmado. Não inclui valores.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome:     { type: 'string' },
        clienteNumero:   { type: 'string' },
        itens:           {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nome:       { type: 'string' },
              quantidade: { type: 'number' }
            }
          }
        },
        enderecoEntrega: { type: 'string' }
      },
      required: ['clienteNumero', 'itens', 'enderecoEntrega']
    }
  }
];

// ── Executor de ferramentas ───────────────────
async function executarFerramenta(nome, input, sessao, clienteNumero) {
  console.log(`[Tool] ${nome}`, input);

  switch (nome) {

    case 'listar_produtos': {
      const lista = estoque.listarProdutos();
      return { resultado: lista.length ? lista : 'Nenhum produto disponível.' };
    }

    case 'buscar_produto': {
      const encontrados = estoque.buscarProduto(input.termo);
      return { resultado: encontrados.length ? encontrados : `Nenhum produto encontrado para "${input.termo}".` };
    }

    case 'consultar_estoque': {
      const prod = estoque.consultarEstoque(input.produto);
      return { resultado: prod || `Produto "${input.produto}" não encontrado.` };
    }

    case 'baixar_estoque': {
      const r = estoque.baixarEstoque(input.produto, input.quantidade);
      return { resultado: r };
    }

    case 'entrar_estoque': {
      const r = estoque.entrarEstoque(input.produto, input.quantidade, input.preco || null);
      return { resultado: r };
    }

    case 'enviar_catalogo': {
      const cat = CATALOGO[input.categoria.toLowerCase()];
      if (!cat) return { resultado: `Categoria "${input.categoria}" não encontrada.` };
      await enviarTexto(clienteNumero, cat);
      return { resultado: { ok: true, mensagem: `Catálogo de ${input.categoria} enviado.` } };
    }

    case 'calcular_frete': {
      sessao.endereco = input.endereco;
      const frete = calcularFrete(input.endereco);
      sessao.frete = frete;
      if (frete === null) {
        return { resultado: { frete: null, precisaAcionarLuiz: true, mensagem: 'Bairro fora da zona de frete fixo. Acionar Luiz humano para cotar.' } };
      }
      return { resultado: { frete, endereco: input.endereco } };
    }

    case 'cotar_correios': {
      const cepOrigem = '22020000';
      const cepDestino = input.cepDestino.replace(/\D/g, '');
      const peso = input.pesoGramas || 300;

      try {
        // PAC = 04669, SEDEX = 40010
        const servicos = ['04669', '40010'];
        const resultados = [];

        for (const servico of servicos) {
          const url = `http://ws.correios.com.br/calculador/CalcPrecoPrazo.asmx/CalcPrecoPrazo?nCdEmpresa=&sDsSenha=&nCdServico=${servico}&sCepOrigem=${cepOrigem}&sCepDestino=${cepDestino}&nVlPeso=${peso/1000}&nCdFormato=1&nVlComprimento=16&nVlAltura=12&nVlLargura=14&sCdMaoPropria=n&nVlValorDeclarado=0&sCdAvisoRecebimento=n&StrRetorno=xml&nIndicaCalculo=3`;
          
          const res = await fetch(url);
          const xml = await res.text();
          
          const valorMatch = xml.match(/<Valor>(.*?)<\/Valor>/);
          const prazoMatch = xml.match(/<PrazoEntrega>(.*?)<\/PrazoEntrega>/);
          const erroMatch  = xml.match(/<MsgErro>(.*?)<\/MsgErro>/);
          
          if (valorMatch && prazoMatch && !erroMatch?.[1]) {
            const nome = servico === '40010' ? 'SEDEX' : 'PAC';
            const valor = valorMatch[1].replace(',', '.');
            const prazo = prazoMatch[1];
            resultados.push({ servico: nome, valor: parseFloat(valor), prazo: `${prazo} dias úteis` });
          }
        }

        if (resultados.length === 0) {
          return { resultado: { ok: false, erro: 'Não foi possível cotar. Acionar Luiz humano.' } };
        }

        return { resultado: { ok: true, opcoes: resultados } };

      } catch (err) {
        return { resultado: { ok: false, erro: 'Erro ao consultar Correios. Acionar Luiz humano.' } };
      }
    }

    case 'acionar_luiz_humano': {
      const grupoAdmin = process.env.ADMIN_GROUP_JID;
      if (grupoAdmin) {
        await enviarTexto(grupoAdmin,
          `🔔 *Atenção Luiz!*\n\n` +
          `Cliente: ${input.cliente}\n` +
          `Motivo: ${input.motivo}`
        );
      }
      sessao.luizHumanoAtivo = true;
      sessao.luizHumanoUltimaMsg = Date.now();
      return { resultado: { ok: true, mensagem: 'Luiz humano acionado.' } };
    }

    case 'enviar_pix': {
      const pixKey  = process.env.PIX_KEY;
      const pixName = process.env.PIX_NAME;
      const total   = Number(input.total).toFixed(2);

      await enviarTexto(clienteNumero,
        `💰 *Pagamento via PIX*\n` +
        `Nome: ${pixName}\n` +
        `Banco: Santander\n` +
        `Valor: R$ ${total}\n\n` +
        `Copie a chave abaixo 👇`
      );
      await new Promise(r => setTimeout(r, 1000));
      await enviarTexto(clienteNumero, pixKey);

      sessao.aguardandoPix = true;
      return { resultado: { ok: true } };
    }

    case 'despachar_pedido': {
      const grupoEntrega = process.env.DELIVERY_GROUP_JID;
      if (!grupoEntrega) return { resultado: { ok: false, erro: 'DELIVERY_GROUP_JID não configurado.' } };

      const itensTexto = input.itens
        .map(i => `📦 ${i.nome}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''}`)
        .join('\n');

      const msg =
        `🛵 *PEDIDO — Force Imports*\n\n` +
        `👤 *Cliente:* ${input.clienteNome || input.clienteNumero}\n` +
        `📍 *Endereço:* ${input.enderecoEntrega}\n\n` +
        `${itensTexto}\n\n` +
        `✅ *PIX confirmado!*`;

      await enviarTexto(grupoEntrega, msg);

      // Mensagem de confirmação pro cliente
      await enviarTexto(clienteNumero,
        `✅️ Está entregue!\n\n` +
        `🚨Por favor, confira o pedido no mesmo dia! Não nos responsabilizamos por danos após o dia da entrega.\n\n` +
        `*MUITO OBRIGADO E BONS GANHOS!* 💪😄`
      );

      limparCarrinho(clienteNumero);
      return { resultado: { ok: true } };
    }

    default:
      return { resultado: `Ferramenta desconhecida: ${nome}` };
  }
}

// ── Loop principal ────────────────────────────
async function processarMensagem(clienteNumero, mensagemTexto, clienteNome = 'cliente') {
  const sessao = getSessao(clienteNumero);

  // Se Luiz humano interveio, aguarda 15min após última msg do cliente
  if (sessao.luizHumanoAtivo) {
    const agora = Date.now();
    const quinzeMin = 15 * 60 * 1000;
    sessao.luizHumanoUltimaMsg = agora;
    if (agora - sessao.luizHumanoUltimaMsg < quinzeMin) {
      return null; // não responde
    }
    // Passou 15min, retoma
    sessao.luizHumanoAtivo = false;
    sessao.luizHumanoUltimaMsg = null;
  }

  // Verifica horário de entrega (horário de Brasília)
  const _agora = new Date();
  const _horaBSB = new Date(_agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const _hora = _horaBSB.getHours();
  const _diaSemana = _horaBSB.getDay(); // 0=domingo, 6=sábado

  let _foraHorario = false;
  let _msgHorario = "";

  if (_diaSemana === 0) {
    // Domingo — não entrega
    _foraHorario = true;
    _msgHorario = "DOMINGO: Não há entrega hoje. Pedidos feitos hoje serão entregues na segunda-feira a partir das 12h.";
  } else if (_diaSemana === 6) {
    // Sábado — entrega até 16h
    if (_hora < 12 || _hora >= 16) {
      _foraHorario = true;
      _msgHorario = "SÁBADO FORA DO HORÁRIO: Entregas aos sábados são das 12h às 16h. Pedido recebido, entrega na segunda a partir das 12h.";
    }
  } else {
    // Seg-Sex — entrega até 20h
    if (_hora < 12 || _hora >= 20) {
      _foraHorario = true;
      _msgHorario = "FORA DO HORÁRIO: Entregas são das 12h às 20h. Pedido recebido, entrega amanhã a partir das 12h.";
    }
  }

  sessao.historico.push({ role: "user", content: mensagemTexto });

  if (sessao.historico.length > 40) {
    sessao.historico = sessao.historico.slice(-40);
  }

  let resposta = null;

  while (true) {
    const resultado = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(_foraHorario, _msgHorario),
      tools: TOOLS,
      messages: sessao.historico
    });

    if (resultado.stop_reason === 'tool_use') {
      sessao.historico.push({ role: 'assistant', content: resultado.content });

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

      sessao.historico.push({ role: 'user', content: toolResults });
      continue;
    }

    resposta = resultado.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    sessao.historico.push({ role: 'assistant', content: resposta });
    break;
  }

  return resposta || null;
}

module.exports = { processarMensagem, getSessao };
