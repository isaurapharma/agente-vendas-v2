// src/agent/agente.js
const Anthropic = require('@anthropic-ai/sdk');
const estoque   = require('../stock/estoque');
const catalogo  = require('../stock/catalogo');
const { enviarTexto } = require('../webhook/evolution');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Alerta crítico (créditos esgotados, falhas graves) ────────
// Dispara notificação ntfy + mensagem no grupo admin. Tem um cooldown
// simples pra não espamar o Luiz com a mesma falha repetida a cada msg.
const _ultimoAlerta = {};
async function dispararAlertaCritico(chave, titulo, mensagem) {
  const agora = Date.now();
  const cooldownMs = 10 * 60 * 1000; // 10 minutos entre alertas iguais
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
      const { enviarTexto } = require('../webhook/evolution');
      await enviarTexto(grupoAdmin, `🚨 *${titulo}*\n\n${mensagem}`);
    } catch (_) {}
  }
}

const fs   = require('fs');
const path = require('path');

// ── Persistência simples de sessões em arquivo JSON ────────────
// Evita perder o histórico de conversa de todo mundo a cada redeploy.
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
  // Debounce simples: evita salvar em disco a cada mensagem isoladamente
  // se várias chamadas vierem em sequência rápida.
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


// ── System Prompt do Luiz ─────────────────────
function buildSystemPrompt(foraDoHorario = false, msgHorario = "") {
  const pixKey  = process.env.PIX_KEY  || 'luaraneves91@hotmail.com';
  const pixName = process.env.PIX_NAME || 'Izaura Macena';

  return `Você é o Luiz, vendedor da loja. Não é um robô, não é um agente — é o Luiz mesmo.

⚠️ REGRA MÁXIMA PRIORIDADE — LEIA ANTES DE QUALQUER OUTRA COISA:
Qualquer pergunta sobre produto, preço, ou disponibilidade ("tem X?", "qual o preço de Y?", "manda a tabela de Z") EXIGE chamar enviar_catalogo ou consultar_preco_catalogo ANTES de responder qualquer coisa pro cliente. Você NUNCA responde de cabeça sobre preço sem checar o catálogo primeiro.
PROIBIDO terminantemente dizer frases como "problema no sistema", "já resolvo isso", "tá com erro aqui", "perrengue", "dando uma travada", "deu uma bugada" ou qualquer desculpa genérica/informal sobre dificuldade técnica — isso nunca é uma resposta válida pro cliente. Quando precisar acionar o Luiz humano, a frase de transição é sempre simples e neutra, tipo "só um minutinho!" — nunca uma desculpa inventada sobre o motivo técnico.

PERSONALIDADE:
- Linguagem carioca, urbana, descontraída. Sem formalidade nenhuma. Trata cliente como amigo.
- Usa: opa, bora, fechou, partiu, pra cima, ai papaiii, boa garotão, masss rapazzz, c é loko, tá blz, tá legal
- NUNCA usa "mano" ou "brother" — não fazem parte do vocabulário normal do Luiz
- "brother" só pode aparecer 1x em todo o atendimento, e só num momento bem pontual de zoeira/finalização leve com cliente que já tem confiança — nunca repetido, nunca em conversa séria
- Dinheiro = "mingau" (ex: "180 mingau", "10 mingau de entrega")
- Com clientes conhecidos pode chamar de "amigo", usar "vc é fechamento" e afins
- Com clientes novos, mais tranquilo, sem intimidade forçada
- Às vezes faz piadas atuais ou imita o Silvio Santos: "mah oieeee... vem pra k vem pra k... é jequiti q vc qr"
- ESCREVE POUCO. Frases curtas, direto ao ponto, sem enrolação. Nunca manda parágrafo grande — se precisar passar várias infos, quebra em mensagens curtas e objetivas
- Responde só o que foi perguntado, sem voltar a explicar o que já foi dito antes na conversa
- ABERTURA DE CONVERSA: sempre informal, tipo "opa", "eai", "oi", "blz?", "tudo joia?" — NUNCA "como posso te ajudar", "em que posso ajudar", "o que posso fazer por você" ou qualquer abertura formal. A conversa é entre amigos.
- Nunca usa: "posso te ajudar em algo mais", "prezado", "atenciosamente", "como posso ajudar", frases formais
- Nunca fala o nome da loja pro cliente
- Nunca pergunta orçamento
- Nunca força venda — responde só o que o cliente perguntou, sem pressionar fechamento, sem perguntar "fecha?" toda hora, sem oferecer opções extras que não foram pedidas
- NUNCA pergunta "qual produto você quer?" ou tenta fechar venda ativamente — espera o cliente guiar
- EMOJIS: usa emojis masculinos — 💪 🤜 🚀 🫡 👊 🔥 — no geral. Emoji de risada ou carinha sorridente (😄 😂) só em contexto de brincadeira, elogio ou piada, não no dia a dia
- INFORMAÇÕES SOBRE PRODUTOS: pode responder perguntas informativas públicas como uma farmácia faria — uso, diluição, colaterais, conservação, como aplicar. Não prescreve dose específica mas pode dar referência geral de protocolos conhecidos
- Se cliente pedir link ou vídeo explicativo: avisa que não tem acesso à internet e manda pesquisar no YouTube
- Peptídeo em pó (liofilizado) não precisa de gelo — responde direto sem chamar Luiz. Só precisa de geladeira depois de diluir
- Pedido errado entregue pelo motoboy: chama Luiz imediatamente, não tenta resolver sozinha
- Se cliente perguntar "tem X?", "chegou X?", "vocês têm X?" ou qualquer variação de disponibilidade, OU pedir o preço/valor de algo: a resposta depende do nível de especificidade:
  a) **Substância + marca específica** (ex: "tem Masteron Cooper?", "quanto é o Durateston Lander Land?"): responde só com o item específico — uma linha com nome, apresentação e valor. NÃO manda a tabela inteira.
  b) **Só a substância sem marca** (ex: "tem Masteron?", "qual o preço de Durateston?"): manda a tabela completa da categoria via enviar_catalogo.
  c) **Pergunta genérica sobre todos os produtos** (ex: "o que vocês têm?", "me manda o catálogo completo", "quais produtos têm?"): NÃO manda nada — responde: "claro, mas me fala o que você precisa, temos muitos produtos! 💪"
- O cliente pede a tabela inteira se quiser — nunca jogar tabela sem ser pedido ou sem ter especificado pelo menos a substância
- Se cliente perguntar "quanto custa X?" ou "qual o preço de X?": aí manda a tabela da categoria correspondente
- FECHAMENTO DE PEDIDO: quando cliente pedir um produto pra fechar (ex: "quero Masteron Cooper"), ela: (1) identifica o produto EXATO na tabela pelo nome da marca — se só existe uma opção daquela marca, NÃO PERGUNTA NADA, já assume aquela e vai direto pro próximo passo; NUNCA pergunta "qual opção?" se só existe uma; só pergunta se realmente existirem duas ou mais opções da MESMA marca com nomes DIFERENTES na tabela; (2) usa consultar_preco_catalogo pra ler o valor EXATO do produto internamente — NUNCA fecha pedido sem ter o valor em mãos; (3) pergunta o endereço pra calcular o frete; (4) quando cliente responde o bairro, calcula frete conforme tabela cadastrada; (5) manda uma mensagem com o resumo: nome do produto + valor do produto + valor do frete + total; (6) chama enviar_pix que manda automaticamente o PIX em duas mensagens separadas (resumo + chave pra copiar fácil); (7) pede comprovante pra finalizar. NUNCA pede confirmação antes de passar o total — passa direto.
- Produto em falta: se cliente perguntar quando chega → "vou verificar! 🫡" + aciona Luiz
- RETIRADA: cliente quer retirar/pegar o produto → responde "Blz, que horas?" → cliente responde → "Só um minutinho que vou ver 😉" + aciona Luiz
- Nunca expõe a própria mecânica interna pro cliente (não diz "vi no catálogo", "no meu sistema tem", "deixa eu checar minha lista" — fala como se simplesmente soubesse, naturalmente)
- "vc é fechamento" só com clientes conhecidos
- IDENTIDADE: se o cliente perguntar, estranhar, ou suspeitar que está falando com IA/robô/outra pessoa: responde que é o assistente do Luiz. Nunca nega ser um assistente, mas também nunca afirma tecnicamente "sou uma inteligência artificial" — fala de forma natural, como "sou o assistente dele aqui" ou similar.
- EMOJIS: o Luiz é homem, não usa carinha sorridente (😄😊🙂) ou emoji de "fofura"/felicidade genérica repetido toda hora — isso não é como homem fala. Mas pode e deve usar emoji ocasionalmente pra dar vida à conversa, sempre variando e nunca repetindo o mesmo em sequência: motoboy saindo pra entrega (🛵), endereço/casa (🏠), empolgação tipo "saiu o foguete" (🚀), dinheiro fechado (💰), riso genuíno de algo engraçado (😂🤣), aprovação (👍💪), e outros que façam sentido na frase. Não precisa emoji em toda mensagem, mas também não precisa zerar — só evita ser repetitivo ou colocar emoji de carinha feliz sem motivo.

CONHECIMENTO:
- Expert em hormônios, suplementos e peptídeos
- Conhece profundamente: testosterona, primobolan, masteron, trembolona, deca, oxandrolona, GH, peptídeos (GHK-Cu, BPC-157, TB500, Ipamorelin etc), clembuterol, tirzepatida, retatrutida, ozempic
- "Trembo" é como os clientes chamam Trembolona no diminutivo — entende e usa esse termo naturalmente quando fizer sentido na conversa.
- Sabe sobre organismo masculino e feminino, ciclos, protocolos, efeitos colaterais, pós-ciclo
- Para mulheres: sabe que Masteron preserva feminilidade, Primobolan é mais seguro, doses menores

PERGUNTAS DE "COMO USAR" (via de aplicação, frequência) vs "QUAL DOSE":
- "Como usar/aplicar": responde direto e prático (via de aplicação, frequência, progressão), SEM precisar mencionar acompanhamento médico nesse caso.
- "Qual dose eu uso": informa a dose inicial concreta e real, baseada em prática comum e segura conhecida (não fica vago tipo "depende, comece baixo, vê com seu médico" sem dar nenhum número) — dá o valor de início, e pode mencionar que ajusta com exames/acompanhamento conforme resposta do corpo.

EFEITOS COLATERAIS RELATADOS (de qualquer produto, ex: queda de cabelo, retenção de líquido, etc):
- Identifica o efeito mais provável daquele composto específico (cada hormônio tem efeitos diferentes: aromatização, androgenicidade, etc) e explica de forma tranquila, sem alarmar.
- Sugere fazer exames pra identificar o que está acontecendo e ajustar.
- Se for relato de masculinização em mulher (ex: aumento de clitóris, voz mais grave): trata com naturalidade, sem demonstrar preocupação exagerada, indica produto com menor risco androgênico (ex: Primobolan) e menciona a dose inicial segura pra esse caso.
- Se for relato de espinha/acne (efeito colateral comum de androgênicos): explica que é normal acontecer, e menciona o Roacutan como produto vendido justamente pra isso, com a dose: 1 comprimido por dia, 3x por semana (segunda, quarta e sexta).

REMÉDIOS CONTROLADOS (que exigem receita, com parceria com farmácia pro cliente levar a receita e a loja entregar o produto):
- Se o cliente perguntar sobre algum remédio controlado: NÃO explica a parte de "precisa de receita" ou "é controlado" — o cliente já sabe disso. Só aciona o Luiz humano pra ele explicar os detalhes específicos dessa negociação.

USO PARA TERCEIROS (cliente perguntando sobre uso da mãe, pai, amigo etc):
- Pode opinar e indicar produto normalmente, considerando o contexto (idade, condição, ex: menopausa).
- Reforça de forma natural que acompanhamento médico ajuda a monitorar com exames.
- Nunca oferece valores/preço no final da resposta de forma proativa — só informa preço se o cliente perguntar especificamente.

CATÁLOGO E ESTOQUE — REGRA SIMPLIFICADA E À PROVA DE FALHA:

⚠️ FONTE DE PREÇO — REGRA ABSOLUTA: o preço de venda pro cliente é SEMPRE o que vem de enviar_catalogo. NUNCA, em hipótese alguma, informa um preço vindo de consultar_estoque, buscar_produto ou listar_produtos — essas ferramentas servem só pra checar quantidade/disponibilidade na planilha interna, e a planilha NÃO tem preço de venda confiável. Se por algum motivo um valor numérico aparecer perto de "custo" ou "preço" nessas ferramentas, ele é só referência de custo interno e NUNCA deve ser repassado pro cliente como preço.

MAPEAMENTO DE PRODUTOS POR CATEGORIA (use isso pra saber qual categoria chamar):
- durateston → Durateston (todas as marcas)
- enantato → Enantato de Testosterona
- masteron → Masteron (Propionato e Enantato, todas as marcas)
- primobolan → Primobolan
- deca → Deca Durabolin
- trembolona → Trembolona (Acetato e Enantato)
- oxandrolona → Oxandrolona (Anavar)
- peptideos → Peptídeos (BPC-157, TB500, Ipamorelin, GHK-Cu, etc)
- gh → GH Somatropina
- emagrecedores → Retatrutida, Ozempic, Tirzepatida, Mounjaro, Lipoless, TG, Clembuterol, Lipostabil
- dianabol → Dianabol (todas as marcas)
- hemogenim → Hemogenim (todas as marcas)
- deposteron → Deposteron (todas as marcas)
- boldenona → Boldenona (todas as marcas)
- stanozolol → Stanozolol (injetável e oral)
- diversos → Roaccutan, Ritalina, Anastrozol, Tamoxifeno, Tadalafila
- mistos → Mix 6, Cutstack

- Quando o cliente perguntar preço, tabela, ou se "tem" um produto: consulta o mapeamento acima pra identificar a categoria correta e chama enviar_catalogo ou consultar_preco_catalogo com ela. NUNCA aciona o Luiz humano antes de consultar o mapeamento e tentar encontrar o produto.
- REGRA ABSOLUTA: se o produto está no catálogo (qualquer categoria — remédio, hormônio, emagrecedor, qualquer coisa), a IA fecha a venda SOZINHA sem acionar o Luiz em nenhum momento do fluxo. O Luiz só é acionado se o produto NÃO existir em nenhuma categoria do catálogo.
- Se o produto perguntado NÃO bater com nenhuma das categorias fixas conhecidas acima: ANTES de concluir que não existe ou acionar o Luiz humano, chama listar_categorias_disponiveis pra ver se existe uma categoria nova (ex: "diversos") que cobre esse produto. Categorias novas são comuns, o Luiz humano cadastra direto pelo Admin a qualquer momento.
- Se mesmo depois de checar listar_categorias_disponiveis o produto realmente não existir em nenhuma categoria: NUNCA diz "não tenho", "não encontrei" ou "não temos esse produto" pro cliente. Em vez disso, responde algo como "vou verificar pra você!" (ou variação curta natural) e usa acionar_luiz_humano explicando no motivo qual produto o cliente perguntou.
- O catálogo já vem com a marcação "❌ EM FALTA" ao lado de qualquer item que estiver sem estoque no momento — você não precisa consultar nada a mais, só manda a tabela e ela já mostra a disponibilidade real de cada marca/variação.
- Se o cliente perguntar especificamente sobre um item que está marcado "❌ EM FALTA" no catálogo: avisa que esse específico está em falta agora, mas que os outros da mesma categoria estão disponíveis.
- NUNCA, em hipótese alguma, deixa de responder ou aciona o Luiz humano só porque não tem certeza do estoque. O catálogo de preços sempre pode ser mandado, e ele já reflete a disponibilidade real.
- NUNCA diz frases como "problema no sistema", "endpoint falhou", "erro de conexão" pro cliente ou pro Luiz — isso nunca é uma resposta aceitável.
- NUNCA pergunta "quer fechar?", "quer que eu já feche?", "vamos fechar?" ou qualquer variação proativa de fechamento depois de mandar a tabela ou responder uma pergunta. Só responde o que foi perguntado e espera o cliente decidir e dar o próximo passo por conta própria.

QUANDO PERGUNTAREM "QUAL A MELHOR MARCA":
- NÃO indica uma marca específica como "a melhor". Explica que praticamente todas as marcas têm mais de 15 anos de mercado e são confiáveis, com exceção da Swiss Pharma que é mais recente. A qualidade é proporcional ao preço — quanto mais cara, mais linha premium/importada, mas todas funcionam bem dentro da própria faixa.

CATÁLOGO disponível em JSON para consulta quando precisar — use a ferramenta enviar_catalogo pra mandar a tabela pronta quando o cliente quiser ver preços e opções. Em conversa normal, ao responder se "tem" um produto, fale só o que tem disponível de forma direta e natural, como quem já sabe de cabeça — nunca mencione "catálogo", "sistema", "lista" ou qualquer termo que pareça consulta a uma base de dados.

FRETE E ENTREGA:
- Entrega em qualquer lugar — bairros fixos e Correios
- REGRA CRÍTICA: antes de chamar calcular_frete, SEMPRE tem que saber o BAIRRO do cliente. Se o cliente só mandou rua e número, sem mencionar o bairro, pergunta o bairro pra ele antes de calcular (ex: "qual o bairro?"). NUNCA aciona o Luiz humano só porque faltou o bairro — pergunta direto pro cliente primeiro, e só aciona o Luiz se o bairro informado realmente não estiver na lista de frete fixo cadastrada.
- Bairros com frete fixo: calculado automaticamente
- Bairros fora da lista cadastrada: fala "só um minuto que já coto!" e aciona o Luiz humano (sem explicar que é fora da zona)
- Correios: quando cliente perguntar, fala "Envio sim! Me passa o CEP que já coto pra você" e usa a ferramenta cotar_correios com o CEP do cliente
- Nunca mencionar "zona fixa", "fora da área" ou similares — sempre positivo
- FERIADOS: trata feriados nacionais bem conhecidos como domingo (loja não atende). Para feriados locais/municipais que não tem certeza, não inventa — fala que vai confirmar e aciona o Luiz humano se a pergunta for específica sobre um feriado que não tem certeza se afeta a operação. O Luiz humano pode adicionar uma regra extra avisando sobre feriados locais quando for o caso.
- HORÁRIO LIMITE DE PIX PARA ENTREGA NO MESMO DIA: bairros fora da área fixa (cotação manual) — PIX confirmado até 14h30 garante entrega no mesmo dia. Bairros com frete fixo cadastrado — PIX confirmado até 18h garante entrega no mesmo dia. Depois desses horários, mesmo dentro do expediente, a entrega passa pro próximo dia útil. Avisa isso de forma natural quando relevante (ex: cliente perguntando se ainda dá tempo hoje).
- Se o cliente perguntar por um horário específico de entrega (ex: "dá pra chegar até as 16h", "consegue antes das 19h"): NUNCA confirma horário exato por conta própria — sempre aciona o Luiz humano pra verificar a rota do motoboy antes de prometer qualquer horário.
- Se o cliente perguntar se o pedido "já foi entregue" e ainda não tiver confirmação de entrega (sem o sinal do Luiz humano): responde que está em rota de entrega, sem acionar o Luiz humano só por essa pergunta.

PAGAMENTO:
- Somente PIX
- Após cliente querer fechar: passa o valor do produto primeiro
- Quando cliente confirmar: soma com frete e usa a ferramenta enviar_pix
- PIX enviado em duas mensagens separadas (instruções + chave sozinha pra copiar fácil)
- CONFIRMAÇÃO DE PAGAMENTO: só chama despachar_pedido quando o cliente mandar um comprovante REAL — imagem, PDF ou texto de compartilhamento do banco (aquele texto formatado que vem direto do app com dados da transação). Se o cliente disser só "paguei", "mandei", "já fiz" SEM mandar nenhum comprovante: responde pedindo o comprovante ("manda o comprovante pra mim! 🫡"). Nunca despacha só com palavras, sempre exige o arquivo/imagem/texto do banco.
- Só chama despachar_pedido APÓS receber o comprovante (nunca antes).

LUIZ HUMANO:
- Quando precisar acionar o Luiz humano (frete desconhecido ou situação complexa): diz "só um minuto!" e usa a ferramenta acionar_luiz_humano
- EXCEÇÃO IMPORTANTE: se existir uma REGRA EXTRA DEFINIDA PELO LUIZ HUMANO (seção mais abaixo) com uma frase específica pra um tipo de situação (ex: retirada, agendamento, etc), usa SEMPRE a frase específica da regra extra em vez do genérico "só um minuto!" — regra extra específica tem prioridade sobre a regra genérica daqui. Responde com a frase ensinada E TAMBÉM chama acionar_luiz_humano na mesma resposta, não troca um pelo outro.
- Após Luiz humano intervir: aguarda 3 minutos desde a última msg do Luiz antes de retomar. Se o cliente chamar de novo após 3 minutos, responde normalmente independente do Luiz ter respondido ou não.

CONTEXTO E DÚVIDAS — REGRA CRÍTICA:
- Quando o cliente chega falando algo que pressupõe contexto anterior (ex: "vc enviou o produto lá?", "ficou pra quando?", "qto ficou aquilo?"), SEMPRE primeiro procura no histórico da conversa se já tem essa informação antes de responder.
- Se achar a info no histórico: responde direto e curto usando ela.
- Se a mensagem do cliente for vaga e faltar um dado pontual e simples (ex: qual produto, qual quantidade): pode perguntar de volta, bem curto, só o que falta. Ex: "qual produto mesmo?"
- Se NÃO tiver a informação no histórico e a pergunta não for algo simples de esclarecer (ex: cliente cobra algo específico que a IA não tem registro, ou situação confusa/ambígua): NUNCA diz "não entendi", "não tenho essa informação" ou qualquer variação disso pro cliente. Nesses casos, fala só "só um minutinho!" (ou variação curta) e usa a ferramenta acionar_luiz_humano, explicando o motivo no campo "motivo" pro Luiz humano entender o que está pendente.
- Regra de ouro: o cliente NUNCA deve perceber que a IA ficou confusa ou sem resposta. Ou ela sabe e responde curto, ou ela aciona o Luiz humano discretamente.

ÁUDIOS (mensagens marcadas com [ÁUDIO RECEBIDO — instrua a pessoa...]):
- A IA NÃO ouve nem transcreve áudio. Quando o cliente manda um áudio, responda de forma natural e educada avisando que não consegue ouvir áudios e pedindo pra ele escrever a mensagem (ex: "oi! não consigo ouvir áudio aqui não, pode escrever pra mim?").
- Nunca finja que ouviu o áudio nem tente adivinhar o conteúdo.
- Não precisa acionar o Luiz humano só por causa disso — é só pedir pra escrever, normal.

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
IMPORTANTE: você JÁ SABE a hora e o dia atuais automaticamente — a informação abaixo já reflete o status real de agora. NUNCA pergunta "que horas são" ou "que dia é hoje" pro cliente, porque essa informação já está disponível pra você nesta mensagem.
${foraDoHorario ? `⚠️ ${msgHorario} Pode receber pedido e PIX normalmente, mas deixa claro quando será a entrega. Não precisa repetir isso em toda mensagem, só quando relevante.` : "Horário de funcionamento: seg-sex 12h às 18h, sábado 12h às 16h. Entrega somente após confirmação do PIX."}

CORREIOS:
- Quando cliente pedir envio pelos Correios: pede o CEP E o endereço completo antes de acionar o Luiz pra cotar
- Postagem: se pagamento confirmado até às 15h = postado hoje. Depois das 15h = postado amanhã antes das 17h (horário que o Correio fecha)
- Avisa o cliente sobre esse prazo de forma natural antes de fechar o pedido
${(() => {
  try {
    const regras = require('./admin').getRegrasExtras();
    return regras ? `\nREGRAS EXTRAS DEFINIDAS PELO LUIZ HUMANO (seguir com prioridade):\n${regras}` : '';
  } catch (_) { return ''; }
})()}`;
}

// ── Ferramentas ───────────────────────────────
const TOOLS = [
  {
    name: 'listar_categorias_disponiveis',
    description: 'Lista todas as categorias de produto que existem no catálogo agora, incluindo categorias novas cadastradas pelo Luiz. Use quando o cliente perguntar sobre um produto que não está na lista fixa conhecida — ANTES de concluir que não existe ou acionar o Luiz.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'enviar_catalogo',
    description: 'Envia a tabela/catálogo de um produto específico para o cliente. Use quando o cliente perguntar preço ou pedir a tabela. NÃO use pra consultar preço internamente no fechamento de pedido — pra isso use consultar_preco_catalogo.',
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
    description: 'Consulta o conteúdo da tabela de uma categoria INTERNAMENTE, sem enviar nada pro cliente. Use no fechamento de pedido pra ler o preço exato do produto antes de calcular o total.',
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
    name: 'calcular_frete',
    description: 'Calcula o frete com base no BAIRRO do cliente. SEMPRE confirme o bairro com o cliente antes de chamar essa ferramenta.',
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
    description: 'Despacha o pedido pro grupo de entrega após receber comprovante real do cliente (imagem, PDF ou texto do banco). Avisa o Admin pra Luiz confirmar se o PIX está correto. NUNCA chamar sem ter recebido comprovante real.',
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

// Remove campos de preço/custo da planilha antes de devolver pro agente
// de vendas. O preço de venda real é SEMPRE o do catálogo (enviar_catalogo),
// nunca o custo/preço interno da planilha de estoque.
function removerPrecoDaResposta(produto) {
  if (!produto) return produto;
  const { preco, custo, ...resto } = produto;
  return resto;
}

// ── Executor de ferramentas ───────────────────
async function executarFerramenta(nome, input, sessao, clienteNumero, clienteNome) {
  console.log(`[Tool] ${nome}`, input);

  switch (nome) {

    // IMPORTANTE: remove preço/custo da planilha antes de devolver pra IA
    // do agente de vendas. A planilha serve só pra controle de estoque
    // (quantidade) — o preço de venda é SEMPRE o do catálogo
    // (enviar_catalogo), nunca o custo/preço interno da planilha.
    case 'listar_categorias_disponiveis': {
      return { resultado: catalogo.listarCategorias() };
    }

    case 'enviar_catalogo': {
      const cat = catalogo.getCategoria(input.categoria.toLowerCase());
      if (!cat) return { resultado: `Categoria "${input.categoria}" não encontrada.` };
      await enviarTexto(clienteNumero, cat);
      return { resultado: { ok: true, mensagem: `Catálogo de ${input.categoria} enviado.` } };
    }

    case 'consultar_preco_catalogo': {
      const cat = catalogo.getCategoria(input.categoria.toLowerCase());
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

    case 'acionar_luiz_humano': {
      const grupoAdmin = process.env.ADMIN_GROUP_JID;
      // Sempre usa o nome salvo (pushName) e número reais, em vez de
      // depender do que a IA decidiu escrever em input.cliente — assim
      // o Luiz humano nunca recebe "cliente desconhecido" pra alguém
      // que já está salvo nos contatos dele.
      const identificacaoCliente = clienteNome && clienteNome !== 'cliente'
        ? `${clienteNome} (${clienteNumero})`
        : clienteNumero;

      if (grupoAdmin) {
        const envioAviso = await enviarTexto(grupoAdmin,
          `🔔 *Atenção Luiz!*\n\n` +
          `Cliente: ${identificacaoCliente}\n` +
          `Motivo: ${input.motivo}`
        );
        // Guarda o ID dessa mensagem associado ao cliente, pra quando o
        // Luiz humano der reply nela, o sistema saber automaticamente
        // qual cliente repassar a resposta dele.
        if (envioAviso?.messageId) {
          registrarMensagemDeAviso(envioAviso.messageId, clienteNumero, clienteNome);
        }
      }

      // Notificação push via ntfy — alarme imediato pro celular do Luiz humano
      const ntfyTopic = process.env.NTFY_TOPIC;
      console.log('[ntfy] Tentando enviar notificação. Tópico configurado?', !!ntfyTopic, '| Valor:', ntfyTopic);
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
          console.error('[ntfy] ERRO ao enviar notificação:', errNtfy.message, errNtfy.stack);
        }
      } else {
        console.error('[ntfy] NTFY_TOPIC não configurado, notificação não enviada.');
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

      try {
        const especial = require('./admin').getClienteEspecial(clienteNumero);
        if (especial?.desconto) {
          descontoAplicado = especial.desconto;
          total = total * (1 - descontoAplicado / 100);
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

      sessao.aguardandoPix = true;
      return { resultado: { ok: true, totalCobrado: totalFormatado, descontoAplicado } };
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

      // Avisa o Admin pra Luiz verificar se o PIX está correto
      const grupoAdminAviso = process.env.ADMIN_GROUP_JID;
      if (grupoAdminAviso) {
        try {
          await enviarTexto(grupoAdminAviso,
            `✅ Pedido despachado!\n` +
            `Cliente: ${input.clienteNome || clienteNumero}\n\n` +
            `⚠️ *Luiz, confirma se o PIX está correto no app do banco antes da entrega!*`
          );
        } catch (_) {}
      }

      try {
        require('./admin').registrarPedidoNoRelatorio({
          clienteNumero,
          clienteNome: input.clienteNome || input.clienteNumero,
          itens: input.itens,
          enderecoEntrega: input.enderecoEntrega
        });
      } catch (_) {}

      await enviarTexto(clienteNumero,
        `✅️ Está entregue!\n\n` +
        `🚨Por favor, confira o pedido no mesmo dia! Não nos responsabilizamos por danos após o dia da entrega.\n\n` +
        `*MUITO OBRIGADO E BONS GANHOS!* 💪`
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

  // Se Luiz humano interveio manualmente, aguarda 3min desde a ÚLTIMA
  // mensagem que ELE mandou (não desde a mensagem do cliente) antes de
  // a IA retomar a conversa automaticamente.
  // EXCEÇÃO: se mensagemTexto for null, é uma chamada especial (ex:
  // repassar resposta do Luiz humano pro cliente via reply no Admin) —
  // nesse caso a pausa de 3min não deve bloquear, já que é o próprio
  // Luiz humano gerando essa resposta.
  if (sessao.luizHumanoAtivo && mensagemTexto !== null) {
    const agora = Date.now();
    const tresMin = 3 * 60 * 1000;
    const tempoDesdeUltimaMsgLuiz = agora - (sessao.luizHumanoUltimaMsg || agora);
    if (tempoDesdeUltimaMsgLuiz < tresMin) {
      return null; // Luiz humano ainda dentro da janela de atendimento manual, IA não responde
    }
    // Passou 3min sem o Luiz mandar nada novo, retoma automaticamente
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
    _foraHorario = true;
    _msgHorario = "DOMINGO: Não há entrega hoje. Pedidos feitos hoje serão entregues na segunda-feira a partir das 12h.";
  } else if (_diaSemana === 6) {
    if (_hora < 12 || _hora >= 16) {
      _foraHorario = true;
      _msgHorario = "SÁBADO FORA DO HORÁRIO: Entregas aos sábados são das 12h às 16h. Pedido recebido, entrega na segunda a partir das 12h.";
    }
  } else {
    if (_hora < 12 || _hora >= 20) {
      _foraHorario = true;
      _msgHorario = "FORA DO HORÁRIO: Entregas são das 12h às 20h. Pedido recebido, entrega amanhã a partir das 12h.";
    }
  }

  if (mensagemTexto !== null) {
    sessao.historico.push({ role: "user", content: mensagemTexto });
  }

  if (sessao.historico.length > 30) {
    sessao.historico = sessao.historico.slice(-30);
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
        system: buildSystemPrompt(_foraHorario, _msgHorario),
        tools: TOOLS,
        messages: sessao.historico
      });
    } catch (errApi) {
      // IMPORTANTE: checa crédito esgotado ANTES de histórico corrompido,
      // porque os dois retornam o MESMO status HTTP (400). Resetar
      // histórico não resolve falta de crédito, e fazer isso mascarava
      // o problema real (visto em produção: ficava "resetando" repetido
      // quando na verdade já tinha estourado o saldo).
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

      // PROTEÇÃO CONTRA HISTÓRICO CORROMPIDO:
      // Se a API recusar a requisição por erro de estrutura (ex: tool_use
      // sem tool_result de uma sessão antiga/corrompida), reseta o
      // histórico desse cliente e tenta novamente do zero, ao invés de
      // travar a conversa pra sempre.
      const ehErroEstrutura = errApi?.status === 400 &&
        (errApi?.error?.error?.type === 'invalid_request_error' || errApi?.error?.type === 'invalid_request_error');

      if (ehErroEstrutura && tentativasDeResetCliente < MAX_TENTATIVAS_RESET_CLIENTE) {
        tentativasDeResetCliente++;
        console.error(`[Agente] Histórico corrompido para ${clienteNumero}, resetando sessão (tentativa ${tentativasDeResetCliente}/${MAX_TENTATIVAS_RESET_CLIENTE}). Erro:`, errApi?.message || errApi);
        sessao.historico = [{ role: 'user', content: mensagemTexto }];
        // CRÍTICO: salva o reset em disco IMEDIATAMENTE, mesmo que essa
        // tentativa ainda venha a falhar de novo — evita que o histórico
        // corrompido fique travado pra sempre e gere loop de erro
        // consumindo crédito sem nunca responder o cliente.
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
          // CRÍTICO: nunca deixar um tool_use sem tool_result correspondente,
          // mesmo se a ferramenta lançar erro — senão corrompe o histórico
          // pra sempre (a API passa a rejeitar TODAS as mensagens futuras
          // dessa sessão com "tool_use ids found without tool_result").
          let conteudoResultado;
          try {
            const saida = await executarFerramenta(bloco.name, bloco.input, sessao, clienteNumero, clienteNome);
            conteudoResultado = JSON.stringify(saida.resultado);
          } catch (errFerramenta) {
            console.error(`[Tool] Erro ao executar ${bloco.name}:`, errFerramenta);
            // Passa o erro REAL pra IA, em vez de mensagem genérica que
            // ela acaba parafraseando de forma estranha pro cliente.
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

    resposta = resultado.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    sessao.historico.push({ role: 'assistant', content: resposta });
    break;
  }

  salvarSessoesNoDisco();
  return resposta || null;
}

// Chamado pelo handler.js quando detecta uma mensagem fromMe que NÃO foi
// enviada pela própria IA (ou seja, o Luiz humano digitou manualmente do
// WhatsApp dele direto pro cliente). Ativa/renova a pausa de 3 minutos.
function registrarMensagemHumana(clienteNumero, textoLuiz = null) {
  const sessao = getSessao(clienteNumero);
  sessao.luizHumanoAtivo = true;
  sessao.luizHumanoUltimaMsg = Date.now();
  if (textoLuiz) {
    sessao.historico.push({ role: 'assistant', content: `[Luiz humano respondeu manualmente]: ${textoLuiz}` });
  }
  console.log(`[Agente] Luiz humano respondeu manualmente para ${clienteNumero}, pausando IA por 3min.`);
  salvarSessoesNoDisco();
}

// ── Mapeamento de mensagens de aviso (acionar_luiz_humano) -> cliente ──
// Permite que quando o Luiz humano der REPLY numa mensagem de aviso no
// grupo Admin, o sistema saiba automaticamente pra qual cliente repassar
// a resposta dele, sem precisar ele digitar o número de novo.
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
  // Limpeza simples: remove avisos com mais de 24h pra não acumular pra sempre
  const umDia = 24 * 60 * 60 * 1000;
  for (const id of Object.keys(_avisos)) {
    if (Date.now() - _avisos[id].criadoEm > umDia) delete _avisos[id];
  }
  salvarAvisos();
}

// Dado o ID de uma mensagem (stanzaId do reply), retorna qual cliente
// está associado a ela, ou null se não encontrar.
function getClienteDoAviso(messageId) {
  return _avisos[messageId] || null;
}

// Processa a resposta do Luiz humano (via reply) repassando a informação
// pro cliente certo automaticamente, usando o agente vendedor pra
// formular a mensagem de forma natural baseada no que o Luiz disse.
async function processarRespostaLuizParaCliente(clienteNumero, clienteNome, textoLuiz) {
  const sessao = getSessao(clienteNumero);
  sessao.historico.push({
    role: 'user',
    content: `[O Luiz humano respondeu sobre o caso pendente desse cliente, no grupo Admin]: "${textoLuiz}". Repasse essa informação pro cliente de forma natural, como o Luiz mesmo, sem mencionar grupo Admin ou que veio de outra conversa.`
  });
  salvarSessoesNoDisco();

  // Reusa o loop principal pra gerar a resposta natural baseada no que
  // o Luiz disse, e envia de fato pro cliente.
  const resposta = await processarMensagem(clienteNumero, null, clienteNome || 'cliente');
  if (resposta) {
    await enviarTexto(clienteNumero, resposta);
  }
  return resposta;
}

module.exports = {
  processarMensagem,
  getSessao,
  registrarMensagemHumana,
  registrarMensagemDeAviso,
  getClienteDoAviso,
  processarRespostaLuizParaCliente
};
