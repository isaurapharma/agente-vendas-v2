// src/stock/estoque.js
// Gerencia leitura, baixa e entrada no Excel de estoque REAL (planilha
// financeira mensal da loja, aba com nome do mês, ex: "maio", "junho").
//
// Estrutura real da planilha (confirmada pela usuária):
// Coluna A = sigla do produto (ex: "E. M", "D. L", "PM. S")
// Coluna B = custo
// Coluna H = ESTOQUE atual (quantidade disponível)
// A aba tem o nome do mês atual em português, minúsculo (maio, junho, etc).

const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');
const { resolverApelido } = require('./apelidos');

function getFilePath() {
  return path.resolve(process.env.STOCK_FILE_PATH || './data/estoque.xlsx');
}

// ─────────────────────────────────────────────
// Configuração persistida da aba ativa (nome do mês). O Luiz humano
// pode atualizar isso falando no grupo Admin (ex: "atualiza que estamos
// em junho"), sem precisar de redeploy ou variável de ambiente.
// ─────────────────────────────────────────────
function getConfigFilePath() {
  return path.resolve(process.env.STOCK_CONFIG_FILE_PATH || './data/estoque-config.json');
}

function lerConfigAba() {
  try {
    const arquivo = getConfigFilePath();
    if (!fs.existsSync(arquivo)) return null;
    const raw = fs.readFileSync(arquivo, 'utf-8');
    return JSON.parse(raw).abaAtiva || null;
  } catch (_) {
    return null;
  }
}

// Permite o admin.js definir manualmente qual aba usar (ex: "junho"),
// persistindo em disco pra sobreviver a redeploys.
function definirAbaAtiva(nomeAba) {
  try {
    const arquivo = getConfigFilePath();
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify({ abaAtiva: nomeAba.toLowerCase().trim() }), 'utf-8');
    return { ok: true, abaAtiva: nomeAba.toLowerCase().trim() };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// Nome da aba: prioridade é (1) configuração manual salva pelo admin via
// definirAbaAtiva, (2) variável de ambiente STOCK_SHEET_NAME, (3) mês
// atual calculado automaticamente (fallback).
function getNomeAbaEsperado() {
  const configManual = lerConfigAba();
  if (configManual) return configManual;
  if (process.env.STOCK_SHEET_NAME) return process.env.STOCK_SHEET_NAME.toLowerCase();
  const meses = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const agoraBSB = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const mesIdx = agoraBSB.getMonth();
  return meses[mesIdx];
}

// ─────────────────────────────────────────────
// Mapeamento de siglas -> nome legível (categoria + marca)
// Baseado na legenda real fornecida pela usuária.
// ─────────────────────────────────────────────

const MARCAS = {
  'M': 'Muscle Pharma',
  'L': 'Lander Land',
  'K': 'King Pharma',
  'B': 'Bratva Labs',
  'C': 'Cooper Pharma',
  'PH': 'Pharmacom',
  'S': 'Swiss Pharma',
  'Z': 'ZPHC',
  'O': 'Oxygen',
  'E': 'Eminence Labs',
  'H': 'High Pharma',
  'GN': 'Gen Heath',
  'BTT': 'Better Performance',
  'OR': 'Original',
  'GE': 'Genérico',
};

// sigla de categoria (antes do ponto/barra) -> nome legível da categoria
const CATEGORIAS = {
  'E':    'Enantato de Testosterona',
  'D':    'Durateston',
  'M':    'Masteron Propionato',
  'ME':   'Masteron Enantato',
  'DC':   'Deca',
  'NP':   'NPP (Nandrolona Fenilpropionato)',
  'DE':   'Deposteron',
  'TA':   'Trembolona Acetato',
  'TE':   'Trembolona Enantato',
  'DI':   'Dianabol',
  'HE':   'Hemogenim',
  'ST':   'Stanozolol',
  'PM':   'Primobolan',
  'OX':   'Oxandrolona',
  'B':    'Boldenona',
  'PV':   'Proviron',
  'HA':   'Halotestin',
  'HC':   'HCG',
  'TU':   'Turinabol',
  'TES':  'Testosterona Gel',
  'G':    'GH Biomanguinhos',
  'TIR':  'Tirzepatida',
  'RT':   'Retatrutida',
  'CLB':  'Clembuterol',
  'LISP': 'Lipostabil',
  'RTNA': 'Ritalina',
  'RCN':  'Roacutan',
  'ANSTL':'Anastrozol',
  'SBMNA':'Sibutramina',
  'CAB':  'Cabergolina',
  'TDLA': 'Tadalafila',
  'TAMXF':'Citrato de Tamoxifeno',
  'PEP':  'Peptídeo',
  'HD':   'Lipo HD',
  'VNZ':  'Pré-treino Veinz',
  'FMTP': 'Fematrop',
  'MEG':  'Mega Man',
};

// Casos especiais de sigla completa -> nome legível direto, quando o
// padrão "CATEGORIA. MARCA" não se aplica bem (ex: stack, extras, etc).
const CASOS_ESPECIAIS = {
  'M. EXTRA':       'Masteron Propionato — Adicional',
  'D. EXTRA':       'Durateston — Adicional',
  'E. EXTRA':       'Enantato de Testosterona — Adicional',
  'DC. EXTRA':      'Deca — Adicional',
  'NP. EXTRA':      'NPP — Adicional',
  'DI. EXTRA':      'Dianabol — Adicional',
  'HE. EXTRA':      'Hemogenim — Adicional',
  'TA. STACK':      'Blend Cut Stack Muscle Pharma',
  'TE. BLEND PH':   'Blend Mix 6 Pharmacom',
  'TE. CAN':        'Trembolona Enantato Canada Labs',
  'M.B (AMP)':      'Masteron Propionato Bratva Labs (Ampola)',
  'M. B':           'Masteron Propionato Bratva Labs',
  'DC. AMP/ PH':    'Deca Pharmacom (Ampola)',
  'DC. PH':         'Deca Pharmacom (Frasco)',
  'DE./AMP. L':     'Deposteron Lander Land (Ampola)',
  'DE. L':          'Deposteron Lander Land (Frasco)',
  'ST. 30. L':      'Stanozolol 30ml Lander Land',
  'ST. 15. L':      'Stanozolol 15ml Lander Land',
  'ST. 10. OX':     'Stanozolol 10ml Oxygen',
  'ST. CP/ L':      'Stanozolol 100 Comprimidos Lander Land',
  'ST. CP/ M':      'Stanozolol 100 Comprimidos Muscle Pharma',
  'OX/5. L':        'Oxandrolona 5mg 100cps Lander Land',
  'OX/10. L':       'Oxandrolona 10mg 50cps Lander Land',
  'OX/10. MANP.':   'Oxandrolona Manipulada 10mg/100cps',
  'OX/20. MANP.':   'Oxandrolona Manipulada 20mg/100cps',
  'TES. GL':        'Testosterona Gel',
  'G/ 4':           'GH Biomanguinhos Caixa 4ui',
  'G/ 12':          'GH Biomanguinhos Caixa 12ui',
  'G/ C':           'GH Caneta Genotropin',
  'TIR. CX/ T':     'Tirzepatida TG Caixa Fechada',
  'TIR. FR/ T':     'Tirzepatida TG Frasco 15mg',
  'TIR. CX./ LPSS': 'Tirzepatida Lipoless Caixa Fechada',
  'TIR. FR./ LP SS':'Tirzepatida Lipoless Frasco 15mg',
  'TIR. 10/ MJ':    'Tirzepatida Mounjaro Caneta 10mg',
  'TIR. 2.5/ MJ':   'Tirzepatida Mounjaro Caneta 2.5mg',
  'RT/ 15. Z':      'Retatrutida ZPHC 15mg',
  'RT/ 24. Z':      'Retatrutida ZPHC 24mg',
  'RT/ 120. Z':     'Retatrutida ZPHC 120mg',
  'RT. SY':         'Retatrutida Synedica 40mg',
  'RT. O':          'Retatrutida Oxygen 40mg',
  'CLB. L':         'Clembuterol 50cps Lander Land',
  'CLB. GL':        'Clembuterol Veterinário Gel 500ml',
  'CLB. BTEL':      'Clembuterol 20cps',
  'LISP.':          'Lipostabil Caixa 5 Ampolas',
  'RTNA. OR':       'Ritalina Original',
  'RTNA. GE':       'Ritalina Genérico',
  'RCN. OR':        'Roacutan Original',
  'RCN. GE':        'Roacutan Genérico',
  'TDLA.':          'Tadalafila 5mg 30cps',
  'TAMXF':          'Citrato de Tamoxifeno',
  'PEP. IP/ GN':    'Peptídeo Ipamorelin Gen Heath',
  'PEP. IP/ BTT':   'Peptídeo Ipamorelin Better Performance',
  'PEP. FR/ GN':    'Peptídeo Frag 176 Gen Heath',
  'PEP. FR/BTT':    'Peptídeo Frag 176 Better Performance',
  'PEP. TB/ GN':    'Peptídeo TB500 Gen Heath',
  'PEP. TB/ BTT':   'Peptídeo TB500 Better Performance',
  'PEP. GK-C/ GN':  'Peptídeo GHK-Cu Gen Heath',
  'PEP. GK-C/ BTT': 'Peptídeo GHK-Cu Better Performance',
  'PEP. GK-C/ O':   'Peptídeo GHK-Cu Oxygen',
  'PEP. GK-C/ Z':   'Peptídeo GHK-Cu ZPHC',
  'PEP. MSC/ GN':   'Peptídeo Most-C Gen Heath',
  'PEP. MSC/ BTT':  'Peptídeo Most-C Better Performance',
  'PEP. BPC/ GN':   'Peptídeo BPC-157 Gen Heath',
  'PEP. BPC/ BTT':  'Peptídeo BPC-157 Better Performance',
  'PEP. SLU/ BTT':  'Peptídeo Slupp 332 Better Performance',
  'PEP. SLU/ GN':   'Peptídeo Slupp 332 Gen Heath',
  'PEP. TSA/ BTT':  'Peptídeo Tesamorelin Better Performance',
  'PEP. TSA/ GN':   'Peptídeo Tesamorelin Gen Heath',
  'PEP. RP6/ BTT':  'Peptídeo GHRP-6 Better Performance',
  'PEP. RP6/ GN':   'Peptídeo GHRP-6 Gen Heath',
  'VNZ':            'Pré-treino Vasodilatador Veinz',
  'FMTP':           'Fematrop',
  'MEG':            'Mega Man',
  'HC. E':          'HCG Choriomon 2.718ui',
  'HD':             'Lipo HD',
  'ANSTL':          'Anastrozol',
  'SBMNA':          'Sibutramina',
  'CAB.':           'Cabergolina',
  'CURCUMA':        'Curcuma',
  'P.T/ M':         'Proviron Muscle Pharma',
  'P.T/ L':         'Proviron Lander Land',
  'P.T/ K':         'Proviron King Pharma',
  'P.T/ S':         'Proviron Swiss Pharma',
  'P.T/ EXTRA':     'Proviron — Adicional',
};

// Traduz uma sigla bruta da planilha (ex: "E. M", "PM. S") pra um nome
// legível (ex: "Enantato de Testosterona Muscle Pharma"). Se não
// reconhecer o padrão, retorna a própria sigla como fallback seguro.
function traduzirSigla(siglaBruta) {
  const sigla = String(siglaBruta).trim();
  const siglaUpper = sigla.toUpperCase().replace(/\s+/g, ' ');

  if (CASOS_ESPECIAIS[siglaUpper]) return CASOS_ESPECIAIS[siglaUpper];

  // Algumas categorias têm ponto dentro da própria sigla (T.A, T.E) —
  // tenta reconhecer esses prefixos compostos primeiro, antes de
  // quebrar a string por ponto/barra de forma genérica.
  const prefixosCompostos = ['T.A', 'T.E'];
  for (const prefixo of prefixosCompostos) {
    if (siglaUpper.startsWith(prefixo)) {
      const resto = sigla.slice(prefixo.length).replace(/^[.\/\s]+/, '').trim();
      const catKey = prefixo.replace('.', '');
      const categoria = CATEGORIAS[catKey];
      const marcaKey = resto.toUpperCase().replace(/\s+/g, '');
      const marca = MARCAS[marcaKey];
      if (categoria && marca) return `${categoria} ${marca}`;
      if (categoria && resto) return `${categoria} (${resto})`;
      if (categoria) return categoria;
    }
  }

  // Padrão geral: "CATEGORIA. MARCA" ou "CATEGORIA/ MARCA"
  const partes = sigla.split(/[.\/]/).map(p => p.trim()).filter(Boolean);
  if (partes.length >= 2) {
    const catKey = partes[0].toUpperCase().replace(/\s+/g, '');
    const marcaKey = partes[partes.length - 1].toUpperCase().replace(/\s+/g, '');
    const categoria = CATEGORIAS[catKey];
    const marca = MARCAS[marcaKey];
    if (categoria && marca) return `${categoria} ${marca}`;
    if (categoria) return `${categoria} (${partes.slice(1).join(' ')})`;
  }

  // Fallback: não reconheceu o padrão, retorna a sigla original
  return sigla;
}

const SHEET_FALLBACK = 'Estoque';

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

function lerPlanilha() {
  const FILE = getFilePath();
  if (!fs.existsSync(FILE)) {
    console.error(`[Estoque] Arquivo não encontrado em: ${FILE} | STOCK_FILE_PATH=${process.env.STOCK_FILE_PATH}`);
    throw new Error(`Arquivo de estoque não encontrado: ${FILE}. Suba a planilha .xlsx mais recente pro caminho configurado em STOCK_FILE_PATH.`);
  }

  const wb = XLSX.readFile(FILE);

  // Tenta achar a aba certa: primeiro pelo nome esperado (mês atual ou
  // STOCK_SHEET_NAME), depois pelo nome fixo "Estoque" (compatibilidade
  // com formato antigo), e por último usa a primeira aba disponível.
  const nomeEsperado = getNomeAbaEsperado();
  const nomesAbas = wb.SheetNames || [];
  let sheetName = nomesAbas.find(n => n.toLowerCase().trim() === nomeEsperado);
  if (!sheetName) sheetName = nomesAbas.find(n => n.toLowerCase().trim() === SHEET_FALLBACK.toLowerCase());
  if (!sheetName) sheetName = nomesAbas[0];

  if (!sheetName) throw new Error('Nenhuma aba encontrada no arquivo Excel.');

  const ws = wb.Sheets[sheetName];
  console.log(`[Estoque] Lendo aba: "${sheetName}" (esperado: "${nomeEsperado}")`);

  const formatoNovo = sheetName.toLowerCase().trim() !== SHEET_FALLBACK.toLowerCase();

  return { wb, ws, sheetName, formatoNovo };
}

// Lê os dados no FORMATO NOVO (planilha financeira real: coluna A=sigla,
// B=custo, H=estoque, sem cabeçalho padronizado, começando por volta da
// linha 7). Percorre o range inteiro da planilha procurando linhas que
// tenham uma sigla de produto na coluna A.
function lerDadosFormatoNovo(ws) {
  if (!ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const dados = [];

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cellA = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    const cellB = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    const cellH = ws[XLSX.utils.encode_cell({ r, c: 7 })];

    const siglaBruta = cellA?.v;
    if (!siglaBruta || typeof siglaBruta !== 'string') continue;
    const siglaLimpa = siglaBruta.trim();
    const siglaCheck = siglaLimpa.toUpperCase();
    // Filtra cabeçalhos de outras tabelas na mesma planilha (despesas,
    // balanço) que não são produtos de estoque de verdade.
    if (!siglaLimpa || ['PRODUTO', 'DESPESAS', 'BALANÇO', 'BALANCO'].includes(siglaCheck)) continue;

    const custo = cellB?.v != null ? Number(cellB.v) : null;
    const estoqueVal = cellH?.v != null ? Number(cellH.v) : 0;

    dados.push({
      id: siglaLimpa,                       // sigla original é o ID único
      nome: traduzirSigla(siglaLimpa),       // nome legível traduzido
      siglaOriginal: siglaLimpa,
      custo: custo,
      preco: custo,                          // sem preço de venda fixo na planilha; custo serve de referência
      estoque: isNaN(estoqueVal) ? 0 : estoqueVal,
      unidade: 'un',
      linha: r + 1
    });
  }

  return dados;
}

// Lê os dados no FORMATO ANTIGO (planilha simples: aba "Estoque" com
// cabeçalho id/nome/preco/estoque/unidade na primeira linha).
function lerDadosFormatoAntigo(ws) {
  return XLSX.utils.sheet_to_json(ws);
}

function carregarDados() {
  const { ws, formatoNovo } = lerPlanilha();
  return formatoNovo ? lerDadosFormatoNovo(ws) : lerDadosFormatoAntigo(ws);
}

function erroEdicaoNaoSuportada() {
  return 'Edição automática de estoque (baixar/entrar/atualizar preço) ainda não é suportada com a planilha financeira real — a estrutura tem fórmulas e colunas de controle que não devem ser sobrescritas automaticamente. Peça pro Luiz humano atualizar a planilha manualmente por enquanto.';
}

// Normaliza texto para busca (sem acento, minúsculo)
function normalizar(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ─────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────

/**
 * Lista todos os produtos com estoque > 0
 * @returns {Array} lista de produtos disponíveis
 */
function listarProdutos() {
  const dados = carregarDados();
  return dados.filter(p => Number(p.estoque) > 0);
}

/**
 * Lista TODOS os produtos (inclusive sem estoque)
 */
function listarTodosProdutos() {
  return carregarDados();
}

/**
 * Busca produto por nome (busca parcial, sem acento) — busca tanto no
 * nome traduzido legível quanto na sigla original e em apelidos.
 * @param {string} termo - texto digitado pelo cliente
 * @returns {Array} produtos encontrados
 */
function buscarProduto(termo) {
  const dados = carregarDados();

  const nomeReal = resolverApelido(termo);
  const t = normalizar(nomeReal || termo);

  // Match direto (substring exata) primeiro — mais preciso quando bate.
  const matchDireto = dados.filter(p =>
    normalizar(p.nome).includes(t) ||
    normalizar(p.siglaOriginal || p.id).includes(t)
  );
  if (matchDireto.length) return matchDireto;

  // Fallback tolerante: separa o termo em palavras e exige que TODAS
  // as palavras apareçam no nome do produto, em qualquer ordem — cobre
  // casos como "masteron lander" quando o nome real é "Masteron
  // Propionato Lander Land".
  const palavras = t.split(/\s+/).filter(Boolean);
  if (palavras.length > 1) {
    return dados.filter(p => {
      const nomeNorm = normalizar(p.nome);
      return palavras.every(palavra => nomeNorm.includes(palavra));
    });
  }

  return [];
}

/**
 * Consulta estoque de um produto pelo id (sigla) ou nome exato/aproximado
 * @param {string} idOuNome
 * @returns {object|null}
 */
function consultarEstoque(idOuNome) {
  const dados = carregarDados();

  const nomeReal = resolverApelido(idOuNome);
  const t = normalizar(nomeReal || idOuNome);

  const matchExato = dados.find(
    p => normalizar(p.id) === t ||
         normalizar(p.nome) === t ||
         normalizar(p.siglaOriginal || '') === t
  );
  if (matchExato) return matchExato;

  const matchParcial = dados.find(
    p => normalizar(p.nome).includes(t) ||
         normalizar(p.siglaOriginal || '').includes(t)
  );
  if (matchParcial) return matchParcial;

  // Fallback tolerante a ordem de palavras diferente.
  const palavras = t.split(/\s+/).filter(Boolean);
  if (palavras.length > 1) {
    return dados.find(p => {
      const nomeNorm = normalizar(p.nome);
      return palavras.every(palavra => nomeNorm.includes(palavra));
    }) || null;
  }

  return null;
}

/**
 * Baixa (subtrai) quantidade do estoque após venda confirmada.
 * NOTA: com a planilha financeira real, edição automática ainda não é
 * suportada. Retorna erro explicativo claro pra IA poder comunicar bem.
 */
function baixarEstoque(idOuNome, quantidade) {
  return { ok: false, erro: erroEdicaoNaoSuportada() };
}

/**
 * Dá entrada de produto no estoque (novo ou existente).
 * NOTA: mesma limitação do baixarEstoque acima.
 */
function entrarEstoque(idOuNome, quantidade, novoPreco = null) {
  return { ok: false, erro: erroEdicaoNaoSuportada() };
}

/**
 * Atualiza apenas o preço de um produto existente.
 * NOTA: mesma limitação do baixarEstoque acima.
 */
function atualizarPreco(idOuNome, novoPreco) {
  return { ok: false, erro: erroEdicaoNaoSuportada() };
}

module.exports = {
  listarProdutos,
  listarTodosProdutos,
  buscarProduto,
  consultarEstoque,
  baixarEstoque,
  entrarEstoque,
  atualizarPreco,
  traduzirSigla, // exportado para testes e para o admin.js poder usar se precisar
  definirAbaAtiva,
  getNomeAbaEsperado
};
