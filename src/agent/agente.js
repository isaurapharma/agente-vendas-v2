// src/agent/agente.js
const Anthropic = require('@anthropic-ai/sdk');
const catalogo  = require('../stock/catalogo');
const { enviarTexto } = require('../webhook/evolution');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Alerta crítico (créditos esgotados, falhas graves) ────────
const _ultimoAlerta = {};
async function dispararAlertaCritico(chave, titulo, mensagem) {
  const agora = Date.now();
  const cooldownMs = 10 * 60 * 1000;
  if (_ultimoAlerta[chave] && (agora - _ultimoAlerta[chave]) < cooldownMs) return;
  _ultimoAlerta[chave] = agora;

  const ntfyTopic = process.env.NTFY_TOPIC;
  if (ntfyTopic) {
    try {
      await fetch(`https://ntfy.sh/${ntfyTopic}`, {
        method: 'POST',
        headers: { 'Title': titulo, 'Priority': 'urgent', 'Tags': 'warning' },
        body: mensagem
      });
    } catch (_) {}
  }

  const grupoAdmin = process.env.ADMIN_GROUP_JID;
  if (grupoAdmin) {
    try {
      await enviarTexto(grupoAdmin, `🚨 *${titulo}*\n\n${mensagem}`);
    } catch (_) {}
  }
}

const fs   = require('fs');
const path = require('path');

// ── Persistência de sessões ────────────────────────────────────
function getSessoesFilePath() {
  return path.resolve(process.env.SESSOES_FILE_PATH || './data/sessoes.json');
}

function carregarSessoesDoDisco() {
  try {
    const arquivo = getSessoesFilePath();
    if (!fs.existsSync(arquivo)) {
      console.log('[Sessoes] Nenhum arquivo de sessões anterior encontrado, começando do zero.');
      return new Map();
    }
    const raw = fs.readFileSync(arquivo, 'utf-8');
    const obj = JSON.parse(raw);
    const mapa = new Map(Object.entries(obj));
    console.log(`[Sessoes] Carregadas ${mapa.size} sessões do disco.`);
    return mapa;
  } catch (err) {
    console.error('[Sessoes] Erro ao carregar sessões do disco, começando do zero:', err.message);
    return new Map();
  }
}

let _salvandoSessoes = false;
let _salvamentoPendente = false;

function salvarSessoesNoDisco() {
  if (_salvandoSessoes) {
    _salvamentoPendente = true;
    return;
  }
  _salvandoSessoes = true;

  setTimeout(() => {
    try {
      const arquivo = getSessoesFilePath();
      const dir = path.dirname(arquivo);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(sessoes);
      fs.writeFileSync(arquivo, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      console.error('[Sessoes] Erro ao salvar sessões no disco:', err.message);
    } finally {
      _salvandoSessoes = false;
      if (_salvamentoPendente) {
        _salvamentoPendente = false;
        salvarSessoesNoDisco();
      }
    }
  }, 500);
}

const sessoes = carregarSessoesDoDisco();

function getSessao(numero) {
  if (!sessoes.has(numero)) {
    sessoes.set(numero, {
      historico: [],
      carrinho: [],
      aguardandoPix: false,
      enderecoJaCadastrado: false,
      pedidoPendente: null,
      luizHumanoAtivo: false,
      luizHumanoUltimaMsg: null,
      endereco: null,
      frete: null
    });
    salvarSessoesNoDisco();
  }
  return sessoes.get(numero);
}

function limparCarrinho(numero) {
  const s = getSessao(numero);
  s.carrinho = [];
  s.aguardandoPix = false;
  s.pedidoPendente = null;
}

// ── Fretes por bairro ─────────────────────────────────────────
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
  return null;
}

// ── System Prompt do Luiz ─────────────────────────────────────
function buildSystemPrompt(foraDoHorario = false, msgHorario = "", primeiraMensagem = false, ehRevendedor = false) {
  const pixKey  = process.env.PIX_KEY  || 'luaraneves91@hotmail.com';
  const pixName = process.env.PIX_NAME || 'Izaura Macena';

  return `Assistente do Luiz no WhatsApp. Age como Luiz, mas se perguntado: "sou o assistente do Luiz". Nunca diz que é IA.

⚠️ PRIORIDADE MÁXIMA: preço/disponibilidade → consultar catálogo ANTES de responder. NUNCA de cabeça. NUNCA diz "perrengue", "tá bugado", "endpoint falhou" ou desculpa técnica.

PERSONALIDADE: carioca, amigo, sem formalidade. Usa: opa, bora, fechou, mingau (=dinheiro). Frases curtas. Nunca: "como posso ajudar", "prezado", forçar venda, perguntar "qual produto quer?", "mano". Emojis masculinos (💪👊🔥🚀🫡), risada (😂) só em piada. "Brother" máx 1x, só com cliente conhecido. Não expõe mecânica interna. Não fala nome da loja. Piadas ok, imita Silvio Santos às vezes.

⚠️ ESTILO DE RESPOSTA: Responde APENAS o que foi perguntado. NÃO faz perguntas ao final de cada resposta tentando forçar venda ou avançar o fluxo. Aguarda o cliente tomar a iniciativa. Só faz perguntas quando for estritamente necessário para completar um pedido em andamento.

PRIMEIRA MENSAGEM DA CONVERSA: quando o histórico está vazio (primeira vez que o cliente manda mensagem), SEMPRE responde com: "Fala comigo, tudo na paz! Aqui o assistente do Luiz, tá precisando do quê? 👊" — independente do que o cliente escreveu. Depois segue normalmente respondendo o que ele pediu na mesma mensagem se tiver algo específico.
${primeiraMensagem ? '⚠️ ESTA É A PRIMEIRA MENSAGEM DO CLIENTE — use a saudação de boas-vindas acima obrigatoriamente.' : ''}

IDENTIDADE: se questionado → "sou o assistente do Luiz". Nunca afirma ser IA.

CONHECIMENTO: expert em hormônios/peptídeos/suplementos (testo, masteron, trembo, deca, oxandrolona, GH, GHK-Cu, BPC-157, tirzepatida, retatrutida, ozempic...). Sabe ciclos, protocolos, efeitos colaterais masculino/feminino. Responde como farmácia: uso, diluição, colaterais, conservação, dose inicial concreta (não vago). Peptídeo em pó = sem gelo. NUNCA afirma que produto não existe/não tem formato sem consultar catálogo primeiro.

DISPONIBILIDADE/PREÇO:
- Substância+marca específica → só aquele item, 1 linha com valor. NÃO envia tabela completa.
- Só substância (sem marca) → tabela completa via enviar_catalogo
- "O que vocês têm?" genérico → "me fala o que precisa, temos muitos produtos! 💪"
- Item "❌ EM FALTA" no catálogo → avisa que está em falta. Em falta em qualquer tabela = em falta pra todos (cliente e revendedor têm a mesma disponibilidade de estoque)
- Produto não encontrado → "vou verificar! 🫡" + aciona Luiz. NUNCA diz "não temos"

APELIDOS CONHECIDOS (clientes usam esses termos):
- "retra" = Retatrutida

MAPEAMENTO CATEGORIAS:
durateston|enantato|masteron|primobolan|deca|trembolona|oxandrolona|peptideos|gh|emagrecedores(retatrutida/ozempic/tirzepatida/mounjaro/lipoless/tg/clembuterol/lipostabil)|dianabol|hemogenim|deposteron|boldenona|stanozolol|diversos(roaccutan/ritalina/anastrozol/tamoxifeno/tadalafila/cabergolina)|mistos(mix6/cutstack)|propionato(testosterona propionato)|npp(nandrolona fenilpropionato)|hcg|turinabol|halotestin|proviron|testosteronagel

PIX SEM CONTEXTO: se chegar comprovante/imagem de PIX sem pedido em andamento → "Tá pagando qual pedido com esse PIX? 🫡" → cliente responde → envia resumo pro Admin: "PIX recebido de [cliente] referente a: [resposta]" + aciona Luiz

PAGAMENTO APÓS ENTREGA (fiado): se cliente do chat falar "vou pagar depois", "pago na entrega", "acerta depois" ou similar → NÃO despacha → aciona Luiz no Admin avisando. Quando Luiz liberar via Admin ("libera o pedido do [cliente]" ou similar) → avisa cliente "Liberado! Já separei seu pedido 🫡" → despacha pro Admin normalmente seguindo todas as regras (etiqueta, resumo, etc)

FECHAMENTO DE PEDIDO:
1. Identifica produto(1 marca=direto;2+=pergunta qual)
2. consultar_preco_catalogo pra pegar preço
3. Pergunta bairro→calcula frete
4. Pergunta "Luiz já tem o endereço de entrega?"
   SE SIM → chama confirmar_endereco_cadastrado → resumo+enviar_pix(sem etiqueta) → pede comprovante → recebeu→"Fechou!🫡"→despachar
   SE NÃO → resumo+enviar_pix(com etiqueta em branco) → cliente manda comprovante+etiqueta preenchida → "Fechou!🫡"→despachar
5. Sem etiqueta quando esperava → "Falta preencher os dados de entrega! 🫡"

REVENDEDOR: mesmo fluxo mas SEM PIX. Produto→confirma(preço revenda)→bairro→"Luiz já tem o endereço de entrega?" SIM→chama confirmar_endereco_cadastrado→despacha direto. NÃO→etiqueta em branco→preenche→despacha. Retirada→"Anotado!🫡 Luiz combina o local"+despacha. Tabela só se pedirem.

ENTREGA/LOCAL:
- Qualquer local (portaria, academia, trabalho, loja, primo) → "Blz! Me passa endereço completo com bairro 🛵"
- Retirada sem endereço → "Blz, que horas?" → "Só um minutinho 🫡" + aciona Luiz
- Pedido errado pelo motoboy → aciona Luiz imediatamente
- Horário específico → nunca promete, aciona Luiz

FRETE:
- Bairro fixo: calcular_frete automático
- Bairro desconhecido: "só um minuto que já coto!" + aciona Luiz (nunca diz "fora da área")
- Correios: pede CEP+endereço completo → aciona Luiz. Quando Luiz responder com o valor do frete via reply, o endereço já está coletado — ir direto pro PIX sem perguntar endereço de novo nem perguntar "Luiz já tem o endereço?". Postagem até 15h = hoje, depois = amanhã antes das 17h

HORÁRIOS:
- Seg-sex: 12h-20h. PIX até 18h = entrega hoje (bairros fixos). PIX até 14h30 = entrega hoje (Correios/cotação)
- Sábado: 12h-16h. PIX até 14h30 = entrega hoje
- Fora do horário → "motoboy já saiu! Pode fechar que entrego amanhã/segunda a partir das 12h 🛵"
- Domingo/feriado nacional → sem entrega, entrega segunda

LUIZ HUMANO:
- Aciona com "só um minuto!" + acionar_luiz_humano
- Regra extra do Luiz tem prioridade sobre regra genérica daqui
- Após Luiz intervir: aguarda 3 min. Cliente chamar depois = responde normalmente

ÁUDIO: não ouve. Pede pra escrever naturalmente. Não aciona Luiz por isso.

REMÉDIO CONTROLADO: não explica sobre receita. Aciona Luiz.
EFEITO COLATERAL: explica tranquilo, identifica o provável, sugere exames. Acne → Roacutan (1cp 3x/semana: seg/qua/sex).
USO PARA TERCEIROS: opina normalmente, menciona exames.
MARCA MELHOR: todas confiáveis +15 anos (exceto Swiss, mais recente). Qualidade ∝ preço.

CONTEXTO: busca no histórico antes de responder. Se não achar e for complexo → "só um minutinho!" + aciona Luiz.

${ehRevendedor ? `
⚠️ CONTEXTO: VOCÊ ESTÁ NUM GRUPO DE REVENDEDOR.
- Usar SEMPRE a tabela de REVENDA (preços menores) — nunca a tabela de cliente final
- Se pedirem preço/tabela: enviar_catalogo com tipo "revenda"
- Fluxo de pedido: revendedor manda produto → confirma → pede etiqueta → despacha pro Admin SEM exigir PIX
- Se falar retirada: confirma e avisa que Luiz vai combinar o local
- Pagamento é acertado em outro canal — nunca cobrar PIX
` : ''}
PAGAMENTO: só PIX. Nome: ${pixName}. Chave: ${pixKey}. Banco: Santander.
⚠️ HORÁRIO ATUAL (você JÁ SABE, NUNCA pergunte ao cliente que horas são ou que dia é):
${foraDoHorario ? `AGORA ESTÁ FORA DO HORÁRIO — ${msgHorario}` : `Horário: seg-sex 12h-20h, sábado 12h-16h. Dentro do horário agora.`}
Quando cliente perguntar se entrega hoje: responde baseado nessa informação acima, sem perguntar o horário.
${(() => {
  try {
    const regras = require('./admin').getRegrasExtras();
    return regras ? `\nREGRAS EXTRAS DO LUIZ (prioridade máxima):\n${regras}` : '';
  } catch (_) { return ''; }
})()}`;
}

// ── Ferramentas ───────────────────────────────────────────────
const TOOLS = [
  {
    name: 'listar_categorias_disponiveis',
    description: 'Lista categorias do catálogo. Usar quando produto não bater com nenhuma categoria conhecida.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'enviar_catalogo',
    description: 'Envia tabela de categoria ao cliente. Usar quando cliente pedir preço/tabela. Não usar no fechamento — usar consultar_preco_catalogo.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Categoria do produto: durateston, enantato, masteron, primobolan, deca, trembolona, oxandrolona, peptideos, gh, emagrecedores, dianabol, hemogenim, deposteron, boldenona, stanozolol, diversos, mistos'
        }
      },
      required: ['categoria']
    }
  },
  {
    name: 'consultar_preco_catalogo',
    description: 'Lê tabela internamente sem enviar ao cliente. Usar no fechamento pra pegar preço exato.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Categoria do produto'
        }
      },
      required: ['categoria']
    }
  },
  {
    name: 'calcular_frete',
    description: 'Calcula frete pelo bairro. Só chamar após confirmar o bairro com o cliente.',
    input_schema: {
      type: 'object',
      properties: {
        bairro:   { type: 'string', description: 'Nome do bairro confirmado com o cliente' },
        endereco: { type: 'string', description: 'Endereço completo, se disponível' }
      },
      required: ['bairro']
    }
  },
  {
    name: 'confirmar_endereco_cadastrado',
    description: 'Registra que o Luiz já tem o endereço de entrega deste cliente cadastrado. Chamar quando o cliente confirmar "sim" na pergunta "Luiz já tem o endereço de entrega?". Após isso, enviar_pix NÃO vai mandar etiqueta em branco.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'acionar_luiz_humano',
    description: 'Aciona Luiz humano. Usar em: frete desconhecido, produto não encontrado, CEP Correios, desconto, retirada, situação complexa.',
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
    description: 'Despacha pedido ao Admin após comprovante REAL e confirmação do cliente. Envia etiqueta de endereço formatada + resumo do pedido. Avisa Luiz pra verificar PIX.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome:     { type: 'string', description: 'Nome do cliente' },
        clienteNumero:   { type: 'string', description: 'Número do cliente' },
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
        rua:      { type: 'string', description: 'Rua e número (ex: Rua das Flores, n° 123)' },
        apto:     { type: 'string', description: 'Apartamento/complemento (opcional)' },
        bairro:   { type: 'string', description: 'Bairro' },
        cidade:   { type: 'string', description: 'Cidade' },
        cep:      { type: 'string', description: 'CEP' }
      },
      required: ['clienteNumero', 'itens', 'rua', 'bairro', 'cidade', 'cep']
    }
  }
];

function removerPrecoDaResposta(produto) {
  if (!produto) return produto;
  const { preco, custo, ...resto } = produto;
  return resto;
}

// ── Executor de ferramentas ───────────────────────────────────
async function executarFerramenta(nome, input, sessao, clienteNumero, clienteNome, ehRevendedor = false) {
  console.log(`[Tool] ${nome}`, input);

  switch (nome) {

    case 'listar_categorias_disponiveis': {
      return { resultado: catalogo.listarCategorias() };
    }

    case 'enviar_catalogo': {
      const tipoTabela = input.tipo === 'revenda' || ehRevendedor ? 'revenda' : 'normal';
      const cat = catalogo.getCategoria(input.categoria.toLowerCase(), tipoTabela);
      if (!cat) return { resultado: `Categoria "${input.categoria}" não encontrada.` };
      await enviarTexto(clienteNumero, cat);
      return { resultado: { ok: true, mensagem: `Catálogo de ${input.categoria} (${tipoTabela}) enviado.` } };
    }

    case 'consultar_preco_catalogo': {
      const tipoTabela = input.tipo === 'revenda' || ehRevendedor ? 'revenda' : 'normal';
      const cat = catalogo.getCategoria(input.categoria.toLowerCase(), tipoTabela);
      if (!cat) return { resultado: `Categoria "${input.categoria}" não encontrada no catálogo.` };
      return { resultado: cat };
    }

    case 'calcular_frete': {
      sessao.endereco = input.endereco || input.bairro;
      const frete = calcularFrete(input.bairro);
      sessao.frete = frete;
      if (frete === null) {
        return { resultado: { frete: null, precisaAcionarLuiz: true, mensagem: `Bairro "${input.bairro}" fora da zona de frete fixo cadastrada. Acionar Luiz humano para cotar.` } };
      }
      return { resultado: { frete, bairro: input.bairro } };
    }

    case 'confirmar_endereco_cadastrado': {
      sessao.enderecoJaCadastrado = true;
      salvarSessoesNoDisco();
      return { resultado: { ok: true, mensagem: 'Endereço marcado como já cadastrado. enviar_pix não vai incluir etiqueta.' } };
    }

    case 'acionar_luiz_humano': {
      const grupoAdmin = process.env.ADMIN_GROUP_JID;
      const identificacaoCliente = clienteNome && clienteNome !== 'cliente'
        ? `${clienteNome} (${clienteNumero})`
        : clienteNumero;

      if (grupoAdmin) {
        const envioAviso = await enviarTexto(grupoAdmin,
          `🔔 *Atenção Luiz!*\n\n` +
          `Cliente: ${identificacaoCliente}\n` +
          `Motivo: ${input.motivo}`
        );
        if (envioAviso?.messageId) {
          registrarMensagemDeAviso(envioAviso.messageId, clienteNumero, clienteNome);
        }
      }

      const ntfyTopic = process.env.NTFY_TOPIC;
      console.log('[ntfy] Tentando enviar notificação. Tópico configurado?', !!ntfyTopic);
      if (ntfyTopic) {
        try {
          const respNtfy = await fetch(`https://ntfy.sh/${ntfyTopic}`, {
            method: 'POST',
            headers: {
              'Title': 'Luiz, te chamaram!',
              'Priority': 'urgent',
              'Tags': 'rotating_light'
            },
            body: `Cliente: ${identificacaoCliente}\nMotivo: ${input.motivo}`
          });
          console.log('[ntfy] Resposta do ntfy.sh, status:', respNtfy.status);
        } catch (errNtfy) {
          console.error('[ntfy] ERRO ao enviar notificação:', errNtfy.message);
        }
      }

      sessao.luizHumanoAtivo = true;
      sessao.luizHumanoUltimaMsg = Date.now();
      return { resultado: { ok: true, mensagem: 'Luiz humano acionado.' } };
    }

    case 'enviar_pix': {
      const pixKey  = process.env.PIX_KEY  || 'luaraneves91@hotmail.com';
      const pixName = process.env.PIX_NAME || 'Izaura Macena';

      let total = Number(input.total);
      let descontoAplicado = 0;
      let tipoDesconto = null;

      try {
        const adminMod = require('./admin');
        const especial = adminMod.getClienteEspecial(clienteNumero);
        if (especial) {
          if (especial.precoFixo != null) {
            // Preço fixo: substitui o total inteiro
            tipoDesconto = `preço fixo R$${especial.precoFixo.toFixed(2)}`;
            descontoAplicado = total - especial.precoFixo;
            total = especial.precoFixo;
          } else if (especial.descontoReais != null) {
            // Desconto em reais: subtrai do total
            tipoDesconto = `R$${especial.descontoReais.toFixed(2)} de desconto`;
            descontoAplicado = especial.descontoReais;
            total = Math.max(0, total - especial.descontoReais);
          } else if (especial.desconto != null) {
            // Desconto em porcentagem
            tipoDesconto = `${especial.desconto}% de desconto`;
            descontoAplicado = total * (especial.desconto / 100);
            total = total * (1 - especial.desconto / 100);
          }
          if (especial.descontoPontual && tipoDesconto) {
            adminMod.zerarDescontoPontual(clienteNumero);
          }
        }
      } catch (_) {}

      const totalFormatado = total.toFixed(2);

      await enviarTexto(clienteNumero,
        `💰 *Pagamento via PIX*\n` +
        `Nome: ${pixName}\n` +
        `Banco: Santander\n` +
        `Valor: R$ ${totalFormatado}\n\n` +
        `Copie a chave abaixo 👇`
      );
      await new Promise(r => setTimeout(r, 1000));
      await enviarTexto(clienteNumero, pixKey);
      await new Promise(r => setTimeout(r, 1000));

      if (!sessao.enderecoJaCadastrado && !ehRevendedor) {
        await enviarTexto(clienteNumero, `Preenche os dados abaixo e manda o comprovante do PIX pra finalizar! 🫡`);
        await new Promise(r => setTimeout(r, 500));
        await enviarTexto(clienteNumero,
          `Destinatário: \n` +
          `Rua: , n° , Apto \n` +
          `Bairro: \n` +
          `Cidade: \n` +
          `CEP: `
        );
      } else {
        await enviarTexto(clienteNumero, `Manda o comprovante pra finalizar! 🫡`);
      }

      sessao.aguardandoPix = true;
      return { resultado: { ok: true, totalCobrado: totalFormatado, descontoAplicado, instrucao: 'Mensagens enviadas automaticamente. NÃO escreva mais nada — aguarde o cliente preencher e mandar o comprovante.' } };
    }

    case 'despachar_pedido': {
      const grupoAdmin = process.env.ADMIN_GROUP_JID;
      if (!grupoAdmin) return { resultado: { ok: false, erro: 'ADMIN_GROUP_JID não configurado.' } };

      const itensTexto = input.itens
        .map(i => `📦 ${i.nome}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''}`)
        .join('\n');

      const apto = input.apto ? `, Apto ${input.apto}` : '';
      const etiqueta =
        `Destinatário: ${input.clienteNome || input.clienteNumero}\n` +
        `Rua: ${input.rua}${apto}\n` +
        `Bairro: ${input.bairro}\n` +
        `Cidade: ${input.cidade}\n` +
        `CEP: ${input.cep}`;

      const resumoPedido =
        `✅ *PEDIDO CONFIRMADO*\n\n` +
        `👤 *Cliente:* ${input.clienteNome || input.clienteNumero}\n` +
        `📱 *Número:* ${clienteNumero}\n\n` +
        `${itensTexto}` +
        // FIX: aviso de PIX só para cliente final, não para revendedor
        (ehRevendedor ? '' : `\n\n⚠️ *Luiz, confirma se o PIX está correto no app do banco antes de despachar!*`);

      try {
        await enviarTexto(grupoAdmin, etiqueta);
        await enviarTexto(grupoAdmin, resumoPedido);
      } catch (err) {
        console.error('[Despacho] Erro ao enviar pro Admin:', err.message);
      }

      try {
        require('./admin').registrarPedidoNoRelatorio({
          clienteNumero,
          clienteNome: input.clienteNome || input.clienteNumero,
          itens: input.itens,
          enderecoEntrega: `${input.rua}, ${input.bairro}, ${input.cidade} - CEP: ${input.cep}`
        });
      } catch (_) {}

      // FIX: clienteNumero pode ser JID de grupo (revendedor) — não adiciona
      // @s.whatsapp.net se já termina com @g.us ou já tem @ no número
      const clienteJid = clienteNumero.includes('@')
        ? clienteNumero
        : `${clienteNumero}@s.whatsapp.net`;

      await enviarTexto(clienteJid,
        `✅ Pedido recebido! Assim que confirmarmos o pagamento a gente já separa pra você 🫡`
      );

      limparCarrinho(clienteNumero);
      sessao.enderecoJaCadastrado = false;
      salvarSessoesNoDisco();
      return { resultado: { ok: true } };
    }

    default:
      return { resultado: `Ferramenta desconhecida: ${nome}` };
  }
}

// ── Loop principal ────────────────────────────────────────────
async function processarMensagem(clienteNumero, mensagemTexto, clienteNome = 'cliente', ehRevendedor = false, conteudoMultimodal = null) {
  const sessao = getSessao(clienteNumero);

  if (sessao.luizHumanoAtivo && mensagemTexto !== null) {
    const agora = Date.now();
    const tresMin = 3 * 60 * 1000;
    const tempoDesdeUltimaMsgLuiz = agora - (sessao.luizHumanoUltimaMsg || agora);
    if (tempoDesdeUltimaMsgLuiz < tresMin) {
      return null;
    }
    sessao.luizHumanoAtivo = false;
    sessao.luizHumanoUltimaMsg = null;
  }

  // ── Verifica horário (Brasília) ───────────────────────────
  const _agora = new Date();
  const _horaBSB = new Date(_agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const _hora = _horaBSB.getHours();
  const _minutos = _horaBSB.getMinutes();
  const _diaSemana = _horaBSB.getDay();

  let _foraHorario = false;
  let _msgHorario = "";

  if (_diaSemana === 0) {
    _foraHorario = true;
    _msgHorario = "DOMINGO: Não há entrega hoje. Pedidos feitos hoje serão entregues na segunda-feira a partir das 12h.";
  } else if (_diaSemana === 6) {
    if (_hora < 12 || _hora >= 16) {
      _foraHorario = true;
      _msgHorario = "SÁBADO FORA DO HORÁRIO: Entregas aos sábados são das 12h às 16h. Pedido recebido, entrega na segunda a partir das 12h.";
    // FIX: era "_hora >= 14 || (_hora === 14 && ...)" — o || fazia entrar no bloco às 14h00
    // Correto: _hora > 14 para horas depois das 14h, ou _hora === 14 E minutos >= 30
    } else if (_hora > 14 || (_hora === 14 && _minutos >= 30)) {
      _foraHorario = false;
      _msgHorario = "SÁBADO APÓS 14H30: Pagamento confirmado após 14h30 no sábado — entrega somente na segunda-feira a partir das 12h.";
    }
  } else {
    if (_hora < 12 || _hora >= 20) {
      _foraHorario = true;
      _msgHorario = "FORA DO HORÁRIO: Loja funciona seg-sex das 12h às 20h. O motoboy já saiu hoje — pedido recebido, entrega amanhã a partir das 12h.";
    }
  }

  if (mensagemTexto !== null) {
    if (conteudoMultimodal) {
      sessao.historico.push({
        role: 'user',
        content: [
          ...conteudoMultimodal,
          { type: 'text', text: mensagemTexto || 'Arquivo enviado.' }
        ]
      });
    } else {
      sessao.historico.push({ role: 'user', content: mensagemTexto });
    }
  }

  // FIX: corte do histórico preserva pares tool_use/tool_result íntegros.
  // Percorre de trás pra frente e só corta em um ponto seguro (mensagem
  // de usuário com content string, não tool_result).
  if (sessao.historico.length > 30) {
    let corte = sessao.historico.length - 30;
    // Avança o ponto de corte até achar uma mensagem de usuário com texto simples
    while (corte < sessao.historico.length) {
      const msg = sessao.historico[corte];
      if (msg.role === 'user' && typeof msg.content === 'string') break;
      corte++;
    }
    sessao.historico = sessao.historico.slice(corte);
  }

  let resposta = null;
  let tentativasDeResetCliente = 0;
  const MAX_TENTATIVAS_RESET_CLIENTE = 2;

  while (true) {
    let resultado;
    try {
      resultado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: buildSystemPrompt(_foraHorario, _msgHorario, sessao.historico.length <= 1, ehRevendedor),
        tools: TOOLS,
        messages: sessao.historico
      });
    } catch (errApi) {
      const errType = errApi?.error?.error?.type || errApi?.error?.type || '';
      const errMsg  = (errApi?.error?.error?.message || errApi?.message || '').toLowerCase();
      const ehSemCredito =
        errType === 'invalid_request_error' && /credit|balance|billing/.test(errMsg) ||
        errApi?.status === 403 && /credit|balance/.test(errMsg);

      if (ehSemCredito) {
        console.error('[Agente] CRÉDITOS ESGOTADOS na Anthropic:', errMsg);
        await dispararAlertaCritico(
          'creditos_anthropic',
          'Créditos da Anthropic esgotados!',
          'O agente parou de responder porque os créditos da conta Anthropic acabaram. Acessa console.anthropic.com e recarrega pra voltar a funcionar.'
        );
        throw errApi;
      }

      const ehErroEstrutura = errApi?.status === 400 &&
        (errApi?.error?.error?.type === 'invalid_request_error' || errApi?.error?.type === 'invalid_request_error');

      if (ehErroEstrutura && tentativasDeResetCliente < MAX_TENTATIVAS_RESET_CLIENTE) {
        tentativasDeResetCliente++;
        console.error(`[Agente] Histórico corrompido para ${clienteNumero}, resetando sessão (tentativa ${tentativasDeResetCliente}/${MAX_TENTATIVAS_RESET_CLIENTE}).`);
        sessao.historico = mensagemTexto ? [{ role: 'user', content: mensagemTexto }] : [];
        salvarSessoesNoDisco();
        continue;
      }

      if (ehErroEstrutura) {
        console.error(`[Agente] Esgotadas as tentativas de reset para ${clienteNumero}. Zerando histórico por segurança.`);
        sessao.historico = [];
        salvarSessoesNoDisco();
      }

      console.error('[Agente] Erro irrecuperável na API:', errApi);
      throw errApi;
    }

    if (resultado.stop_reason === 'tool_use') {
      sessao.historico.push({ role: 'assistant', content: resultado.content });

      const toolResults = [];
      for (const bloco of resultado.content) {
        if (bloco.type === 'tool_use') {
          let conteudoResultado;
          try {
            const saida = await executarFerramenta(bloco.name, bloco.input, sessao, clienteNumero, clienteNome, ehRevendedor);
            conteudoResultado = JSON.stringify(saida.resultado);
          } catch (errFerramenta) {
            console.error(`[Tool] Erro ao executar ${bloco.name}:`, errFerramenta);
            conteudoResultado = JSON.stringify({
              erro: true,
              mensagem: `Erro real ao executar ${bloco.name}: ${errFerramenta.message || errFerramenta}. Se for sobre catálogo/preço, ainda assim tenta usar enviar_catalogo, que não depende dessa ferramenta que falhou.`
            });
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: bloco.id,
            content: conteudoResultado
          });
        }
      }

      sessao.historico.push({ role: 'user', content: toolResults });
      continue;
    }

    // FIX: histórico final sempre salva como array de blocos de texto,
    // igual ao formato que a API retorna — evita mistura de string/array
    // que corrompia o histórico e causava invalid_request_error
    const textoResposta = resultado.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    resposta = textoResposta;
    // Salva no histórico no mesmo formato que a API retorna (array de blocos)
    sessao.historico.push({ role: 'assistant', content: resultado.content });
    break;
  }

  salvarSessoesNoDisco();
  return resposta || null;
}

function registrarMensagemHumana(clienteNumero, textoLuiz = null) {
  const sessao = getSessao(clienteNumero);
  sessao.luizHumanoAtivo = true;
  sessao.luizHumanoUltimaMsg = Date.now();
  if (textoLuiz) {
    sessao.historico.push({ role: 'assistant', content: [{ type: 'text', text: `[Luiz humano respondeu manualmente]: ${textoLuiz}` }] });
  }
  console.log(`[Agente] Luiz humano respondeu manualmente para ${clienteNumero}, pausando IA por 3min.`);
  salvarSessoesNoDisco();
}

// ── Mapeamento de mensagens de aviso → cliente ────────────────
function getAvisosFilePath() {
  return path.resolve(process.env.AVISOS_FILE_PATH || './data/avisos-luiz.json');
}

function carregarAvisos() {
  try {
    const arquivo = getAvisosFilePath();
    if (!fs.existsSync(arquivo)) return {};
    return JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
  } catch (_) {
    return {};
  }
}

function salvarAvisos() {
  try {
    const arquivo = getAvisosFilePath();
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(_avisos), 'utf-8');
  } catch (err) {
    console.error('[Agente] Erro ao salvar avisos no disco:', err.message);
  }
}

let _avisos = carregarAvisos();

function registrarMensagemDeAviso(messageId, clienteNumero, clienteNome) {
  _avisos[messageId] = { clienteNumero, clienteNome, criadoEm: Date.now() };
  const umDia = 24 * 60 * 60 * 1000;
  for (const id of Object.keys(_avisos)) {
    if (Date.now() - _avisos[id].criadoEm > umDia) delete _avisos[id];
  }
  salvarAvisos();
}

function getClienteDoAviso(messageId) {
  return _avisos[messageId] || null;
}

async function processarRespostaLuizParaCliente(clienteNumero, clienteNome, textoLuiz) {
  const sessao = getSessao(clienteNumero);
  sessao.historico.push({
    role: 'user',
    content: `[O Luiz humano respondeu sobre o caso pendente desse cliente, no grupo Admin]: "${textoLuiz}". Repasse essa informação pro cliente de forma natural, como o Luiz mesmo, sem mencionar grupo Admin ou que veio de outra conversa.`
  });
  salvarSessoesNoDisco();

  const resposta = await processarMensagem(clienteNumero, null, clienteNome || 'cliente');
  if (resposta) {
    await enviarTexto(clienteNumero, resposta);
  }
  return resposta;
}

module.exports = {
  processarMensagem,
  getSessao,
  salvarSessoesNoDisco,
  registrarMensagemHumana,
  registrarMensagemDeAviso,
  getClienteDoAviso,
  processarRespostaLuizParaCliente,
  liberarPausaLuiz(clienteNumero) {
    const sessao = getSessao(clienteNumero);
    sessao.luizHumanoAtivo = false;
    sessao.luizHumanoUltimaMsg = null;
    salvarSessoesNoDisco();
  }
};
