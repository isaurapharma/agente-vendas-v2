// src/stock/estoque-admin.js
// Controle de estoque simples pelo Admin — só entrada e saída de quantidade.
// Sem valores, sem preços, sem balanço financeiro.
// Os dados ficam salvos em disco (Volume do Railway) e não somem entre deploys.

const fs   = require('fs');
const path = require('path');

const ESTOQUE_FILE = path.resolve(process.env.ESTOQUE_ADMIN_FILE || './data/estoque-admin.json');
const MOVIMENTOS_FILE = path.resolve(process.env.MOVIMENTOS_FILE || './data/movimentos.json');

// ── Tradução completa das siglas da planilha ──────────────────
const TRADUCAO = {
  'E. M':          'Enantato de Testosterona - Muscle Pharma',
  'E. L':          'Enantato de Testosterona - Lander Land',
  'E. K':          'Enantato de Testosterona - King Pharma',
  'E. B':          'Enantato de Testosterona - Bratva Labs',
  'E. C':          'Enantato de Testosterona - Cooper Pharma',
  'E. PH':         'Enantato de Testosterona - Pharmacom',
  'E. S':          'Enantato de Testosterona - Swiss Pharma',
  'E. Z':          'Enantato de Testosterona - ZPHC',
  'E. O':          'Enantato de Testosterona - Oxygen',
  'D. M':          'Durateston - Muscle Pharma',
  'D. L':          'Durateston - Lander Land',
  'D. K':          'Durateston - King Pharma',
  'D. B':          'Durateston - Bratva Labs',
  'D. C':          'Durateston - Cooper Pharma',
  'D. PH':         'Durateston - Pharmacom',
  'D. S':          'Durateston - Swiss Pharma',
  'D. Z':          'Durateston - ZPHC',
  'D. O':          'Durateston - Oxygen',
  'M. M':          'Masteron Propionato - Muscle Pharma',
  'M. L':          'Masteron Propionato - Lander Land',
  'M. K':          'Masteron Propionato - King Pharma',
  'ME. K':         'Masteron Enantato - King Pharma',
  'M.B (amp)':     'Masteron Propionato - Bratva Labs (Ampola)',
  'M. B':          'Masteron Propionato - Bratva Labs',
  'M. C':          'Masteron - Cooper Pharma',
  'M. PH':         'Masteron - Pharmacom',
  'ME. S':         'Masteron Enantato - Swiss Pharma',
  'M. S':          'Masteron Propionato - Swiss Pharma',
  'M. Z':          'Masteron - ZPHC',
  'M. O':          'Masteron - Oxygen',
  'DC. M':         'Deca - Muscle Pharma',
  'DC. L':         'Deca - Lander Land',
  'DC. K':         'Deca - King Pharma',
  'DC. B':         'Deca - Bratva Labs',
  'DC. C':         'Deca - Cooper Pharma',
  'DC. Amp/ PH':   'Deca - Pharmacom (Ampola)',
  'DC. PH':        'Deca - Pharmacom (Bujão)',
  'DC. S':         'Deca - Swiss Pharma',
  'DC. Z':         'Deca - ZPHC',
  'DC. O':         'Deca - Oxygen',
  'NP. M':         'NPP - Muscle Pharma',
  'NP. L':         'NPP - Lander Land',
  'NP. Z':         'NPP - ZPHC',
  'DE./AMP. L':    'Deposteron - Lander Land (Ampola)',
  'DE. L':         'Deposteron - Lander Land (Bujão)',
  'DE. S':         'Deposteron - Swiss Pharma',
  'DE. M':         'Deposteron - Muscle Pharma',
  'T.A. M':        'Trembolona Acetato - Muscle Pharma',
  'T.A. L':        'Trembolona Acetato - Lander Land',
  'T.A. STACK':    'Blend Cut Stack - Muscle Pharma',
  'T.E. M':        'Trembolona Enantato - Muscle Pharma',
  'T.E. L':        'Trembolona Enantato - Lander Land',
  'T.E. S':        'Trembolona Enantato - Swiss Pharma',
  'T.E. CAN':      'Trembolona Enantato - Canada Labs',
  'T.E Blend PH':  'Blend Mix 6 - Pharmacom',
  'Di. M':         'Dianabol - Muscle Pharma',
  'Di. L':         'Dianabol - Lander Land',
  'Di. S':         'Dianabol - Swiss Pharma',
  'He. M':         'Hemogenim - Muscle Pharma',
  'He. L':         'Hemogenim - Lander Land',
  'He. K':         'Hemogenim - King Pharma',
  'ST. 30. L':     'Stanozolol 30ml - Lander Land',
  'ST. 15. L':     'Stanozolol 15ml - Lander Land',
  'ST. Cp/ L':     'Stanozolol 100cps - Lander Land',
  'ST. Cp/ M':     'Stanozolol 100cps - Muscle Pharma',
  'ST. Cp/ S':     'Stanozolol 100cps - Swiss Pharma',
  'PM. M':         'Primobolan - Muscle Pharma',
  'PM. L':         'Primobolan - Lander Land',
  'PM. K':         'Primobolan - King Pharma',
  'PM. S':         'Primobolan - Swiss Pharma',
  'OX. M':         'Oxandrolona - Muscle Pharma',
  'OX/5. L':       'Oxandrolona 5mg 100cps - Lander Land',
  'OX/10. L':      'Oxandrolona 10mg 50cps - Lander Land',
  'OX/10. Manp.':  'Oxandrolona Manipulada 10mg 100cps',
  'OX/20. Manp.':  'Oxandrolona Manipulada 20mg 100cps',
  'B. M':          'Boldenona - Muscle Pharma',
  'B. L':          'Boldenona - Lander Land',
  'B. Z':          'Boldenona - ZPHC',
  'PV. M':         'Proviron - Muscle Pharma',
  'PV. L':         'Proviron - Lander Land',
  'HA. M':         'Halotestin - Muscle Pharma',
  'HC. M':         'HCG Choriomum - Muscle Labs',
  'HC. L':         'HCG - Lander Land',
  'TU. M':         'Turinabol - Muscle Pharma',
  'TU. Z':         'Turinabol - ZPHC',
  'Tes. GL':       'Testosterona Gel',
  'G/ 4':          'GH Biomanguinhos cx 4ui',
  'G/ 12':         'GH Biomanguinhos cx 12ui',
  'G/ C':          'GH Caneta Genotropin',
  'Tir. Cx/ T':    'Tirzepatida TG - Caixa Fechada',
  'Tir. Fr/ T':    'Tirzepatida TG - 1 Frasco 15mg',
  'Tir. Cx./ LPss':'Tirzepatida Lipoless - Caixa Fechada',
  'Tir. Fr./ LPss':'Tirzepatida Lipoless - 1 Frasco 15mg',
  'Tir. 10/ MJ':   'Tirzepatida Mounjaro - Caneta 10mg',
  'Tir. 2.5/ MJ':  'Tirzepatida Mounjaro - Caneta 2.5mg',
  'RT/ 15. Z':     'Retatrutida ZPHC 15mg',
  'RT/ 24. Z':     'Retatrutida ZPHC 24mg',
  'RT/ 120. Z':    'Retatrutida ZPHC 120mg',
  'RT. SY':        'Retatrutida Synedica 40mg',
  'RT. O':         'Retatrutida Oxygen 40mg',
  'CLB. L':        'Clembuterol 50cps - Lander Land',
  'CLB. GL':       'Clembuterol Vet. Gel 500ml',
  'CLB. BTEL':     'Clembuterol 20cps - Brontel',
  'Lisp.':         'Lipostabil cx 5 ampolas',
  'Rtna. Or':      'Ritalina Original',
  'Rtna. Ge':      'Ritalina Genérico',
  'Rcn. Or':       'Roaccutan Original',
  'Rcn. Ge':       'Roaccutan Genérico',
  'Anstl':         'Anastrozol',
  'SBMNA':         'Sibutramina',
  'Cab.':          'Cabergolina',
  'TDLA.':         'Tadalafila 5mg 30cps',
  'TAMXF':         'Citrato de Tamoxifeno',
  'Pep. ip/ GN':   'Peptídeo Ipamorelin - Gen Heath',
  'Pep. ip/ BTT':  'Peptídeo Ipamorelin - Better Performance',
  'Pep. Fr/ GN':   'Peptídeo Frag 176 - Gen Heath',
  'Pep. Fr/BTT':   'Peptídeo Frag 176 - Better Performance',
  'Pep. Tb/ GN':   'Peptídeo TB500 - Gen Heath',
  'Pep. Tb/ BTT':  'Peptídeo TB500 - Better Performance',
  'Pep. GK-C/ GN': 'Peptídeo GHK-CU - Gen Heath',
  'Pep. GK-C/ BTT':'Peptídeo GHK-CU - Better Performance',
  'Pep. GK-C/ O':  'Peptídeo GHK-CU - Oxygen',
  'Pep. GK-C/ Z':  'Peptídeo GHK-CU - ZPHC',
  'Pep. Msc/ GN':  'Peptídeo Most-C - Gen Heath',
  'Pep. BPC/ GN':  'Peptídeo BPC 157 - Gen Heath',
  'Pep. BPC/ BTT': 'Peptídeo BPC 157 - Better Performance',
  'Pep. Slu/ BTT': 'Peptídeo Slugp 332 - Better Performance',
  'Pep. Tsa/ BTT': 'Peptídeo Tesamorelin - Better Performance',
  'Pep. Rp6/ BTT': 'Peptídeo GRP6 - Better Performance',
  'Vnz':           'Pré Treino Vasodilatador Veinz',
  'FMTP':          'Fematrop',
  'MeG':           'Mega Man',
  'Curcuma':       'Cúrcuma'
};

// ── Busca sigla pelo nome completo ou parcial ─────────────────
// Permite falar "Masteron Cooper" e achar "M. C"
function buscarSigla(termoBusca) {
  const termo = termoBusca.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Busca direta pela sigla
  for (const [sigla, nome] of Object.entries(TRADUCAO)) {
    if (sigla.toLowerCase() === termo) return sigla;
  }

  // Busca pelo nome completo (parcial)
  const resultados = [];
  for (const [sigla, nome] of Object.entries(TRADUCAO)) {
    const nomeNorm = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (nomeNorm.includes(termo)) resultados.push({ sigla, nome });
  }

  if (resultados.length === 1) return resultados[0].sigla;
  if (resultados.length > 1) return { ambiguo: true, opcoes: resultados };
  return null;
}

// ── Persistência ───────────────────────────────────────────────
function carregarEstoque() {
  try {
    if (fs.existsSync(ESTOQUE_FILE)) return JSON.parse(fs.readFileSync(ESTOQUE_FILE, 'utf-8'));
  } catch (e) {}
  return {};
}

function salvarEstoque(estoque) {
  try {
    const dir = path.dirname(ESTOQUE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ESTOQUE_FILE, JSON.stringify(estoque, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[EstoqueAdmin] Erro ao salvar estoque:', e.message);
    return false;
  }
}

function carregarMovimentos() {
  try {
    if (fs.existsSync(MOVIMENTOS_FILE)) return JSON.parse(fs.readFileSync(MOVIMENTOS_FILE, 'utf-8'));
  } catch (e) {}
  return [];
}

function salvarMovimentos(movimentos) {
  try {
    const dir = path.dirname(MOVIMENTOS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MOVIMENTOS_FILE, JSON.stringify(movimentos, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[EstoqueAdmin] Erro ao salvar movimentos:', e.message);
    return false;
  }
}

// ── API pública ────────────────────────────────────────────────

function registrarEntrada(termoProduto, quantidade, nomeCliente = null) {
  const busca = buscarSigla(termoProduto);
  if (!busca) return { ok: false, erro: `Produto "${termoProduto}" não encontrado na tradução. Verifique o nome ou sigla.` };
  if (busca.ambiguo) return { ok: false, erro: `Encontrei mais de um produto com "${termoProduto}":`, opcoes: busca.opcoes };

  const sigla = busca;
  const nome = TRADUCAO[sigla];
  const estoque = carregarEstoque();
  estoque[sigla] = (estoque[sigla] || 0) + Number(quantidade);
  salvarEstoque(estoque);

  const movimentos = carregarMovimentos();
  movimentos.push({
    tipo: 'entrada',
    sigla,
    nome,
    quantidade: Number(quantidade),
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    cliente: nomeCliente || null
  });
  salvarMovimentos(movimentos);

  return { ok: true, sigla, nome, quantidade: Number(quantidade), estoqueAtual: estoque[sigla] };
}

function registrarSaida(termoProduto, quantidade, nomeCliente = null, tipoVenda = 'normal') {
  const busca = buscarSigla(termoProduto);
  if (!busca) return { ok: false, erro: `Produto "${termoProduto}" não encontrado na tradução.` };
  if (busca.ambiguo) return { ok: false, erro: `Encontrei mais de um produto com "${termoProduto}":`, opcoes: busca.opcoes };

  const sigla = busca;
  const nome = TRADUCAO[sigla];
  const estoque = carregarEstoque();
  const atual = estoque[sigla] || 0;

  if (atual < Number(quantidade)) {
    return { ok: false, erro: `Estoque insuficiente. Tem ${atual} unidade(s) de ${nome}, mas tentou dar saída de ${quantidade}.` };
  }

  estoque[sigla] = atual - Number(quantidade);
  salvarEstoque(estoque);

  const movimentos = carregarMovimentos();
  movimentos.push({
    tipo: 'saida',
    sigla,
    nome,
    quantidade: Number(quantidade),
    tipoVenda, // 'normal' ou 'revendedor'
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    cliente: nomeCliente || null
  });
  salvarMovimentos(movimentos);

  return { ok: true, sigla, nome, quantidade: Number(quantidade), estoqueAtual: estoque[sigla], tipoVenda };
}

function relatorioEstoque() {
  const estoque = carregarEstoque();
  const resultado = [];
  for (const [sigla, qtd] of Object.entries(estoque)) {
    resultado.push({ sigla, nome: TRADUCAO[sigla] || sigla, quantidade: qtd });
  }
  return resultado.sort((a, b) => a.nome.localeCompare(b.nome));
}

function relatorioVendas(data = null) {
  const movimentos = carregarMovimentos();
  const hoje = data || new Date().toLocaleDateString('pt-BR');
  return movimentos.filter(m => m.tipo === 'saida' && m.data === hoje);
}

function buscarVendaPorCliente(nomeCliente) {
  const movimentos = carregarMovimentos();
  const termo = nomeCliente.toLowerCase();
  return movimentos.filter(m => m.cliente && m.cliente.toLowerCase().includes(termo));
}

function relatorioEntradas(data = null) {
  const movimentos = carregarMovimentos();
  const hoje = data || new Date().toLocaleDateString('pt-BR');
  return movimentos.filter(m => m.tipo === 'entrada' && m.data === hoje);
}

module.exports = {
  registrarEntrada,
  registrarSaida,
  relatorioEstoque,
  relatorioVendas,
  relatorioEntradas,
  buscarVendaPorCliente,
  buscarSigla,
  TRADUCAO
};
