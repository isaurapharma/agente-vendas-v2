// src/stock/estoque.js
// Gerencia leitura, baixa e entrada no Excel de estoque

const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

const FILE = path.resolve(process.env.STOCK_FILE_PATH || './data/estoque.xlsx');
const SHEET = 'Estoque';

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

function lerPlanilha() {
  if (!fs.existsSync(FILE)) {
    throw new Error(`Arquivo de estoque não encontrado: ${FILE}. Rode: node scripts/criar-estoque.js`);
  }
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Aba "${SHEET}" não encontrada no Excel.`);
  const dados = XLSX.utils.sheet_to_json(ws);
  return { wb, ws, dados };
}

function salvarPlanilha(wb, dados) {
  const ws = XLSX.utils.json_to_sheet(dados, {
    header: ['id', 'nome', 'preco', 'estoque', 'unidade']
  });
  ws['!cols'] = [{ wch: 8 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 8 }];
  wb.Sheets[SHEET] = ws;
  XLSX.writeFile(wb, FILE);
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
  const { dados } = lerPlanilha();
  return dados.filter(p => Number(p.estoque) > 0);
}

/**
 * Lista TODOS os produtos (inclusive sem estoque)
 */
function listarTodosProdutos() {
  const { dados } = lerPlanilha();
  return dados;
}

/**
 * Busca produto por nome (busca parcial, sem acento)
 * @param {string} termo - texto digitado pelo cliente
 * @returns {Array} produtos encontrados
 */
function buscarProduto(termo) {
  const { dados } = lerPlanilha();
  const t = normalizar(termo);
  return dados.filter(p => normalizar(p.nome).includes(t));
}

/**
 * Consulta estoque de um produto pelo id ou nome exato
 * @param {string} idOuNome
 * @returns {object|null}
 */
function consultarEstoque(idOuNome) {
  const { dados } = lerPlanilha();
  const t = normalizar(idOuNome);
  return dados.find(
    p => normalizar(p.id) === t || normalizar(p.nome) === t
  ) || null;
}

/**
 * Baixa (subtrai) quantidade do estoque após venda confirmada
 * @param {string} idOuNome
 * @param {number} quantidade
 * @returns {{ ok: boolean, produto: object, estoqueAnterior: number, estoqueNovo: number, erro?: string }}
 */
function baixarEstoque(idOuNome, quantidade) {
  const { wb, dados } = lerPlanilha();
  const t = normalizar(idOuNome);
  const idx = dados.findIndex(
    p => normalizar(p.id) === t || normalizar(p.nome) === t
  );

  if (idx === -1) {
    return { ok: false, erro: `Produto "${idOuNome}" não encontrado no estoque.` };
  }

  const produto = dados[idx];
  const estoqueAtual = Number(produto.estoque);
  const qtd = Number(quantidade);

  if (qtd <= 0) {
    return { ok: false, erro: 'Quantidade deve ser maior que zero.' };
  }
  if (estoqueAtual < qtd) {
    return {
      ok: false,
      erro: `Estoque insuficiente. Disponível: ${estoqueAtual} ${produto.unidade}.`
    };
  }

  const estoqueNovo = estoqueAtual - qtd;
  dados[idx] = { ...produto, estoque: estoqueNovo };
  salvarPlanilha(wb, dados);

  return {
    ok: true,
    produto,
    estoqueAnterior: estoqueAtual,
    estoqueNovo
  };
}

/**
 * Dá entrada de produto no estoque (novo ou existente)
 * @param {string} idOuNome
 * @param {number} quantidade
 * @param {number|null} novoPreco - se informado, atualiza o preço
 * @returns {{ ok: boolean, produto: object, estoqueAnterior: number, estoqueNovo: number, novo: boolean, erro?: string }}
 */
function entrarEstoque(idOuNome, quantidade, novoPreco = null) {
  const { wb, dados } = lerPlanilha();
  const t = normalizar(idOuNome);
  const qtd = Number(quantidade);

  if (qtd <= 0) {
    return { ok: false, erro: 'Quantidade deve ser maior que zero.' };
  }

  const idx = dados.findIndex(
    p => normalizar(p.id) === t || normalizar(p.nome) === t
  );

  if (idx === -1) {
    // Produto novo
    if (!novoPreco || Number(novoPreco) <= 0) {
      return { ok: false, erro: 'Para cadastrar produto novo, informe o preço.' };
    }
    const novoProduto = {
      id: `P${String(dados.length + 1).padStart(3, '0')}`,
      nome: idOuNome,
      preco: Number(novoPreco),
      estoque: qtd,
      unidade: 'un'
    };
    dados.push(novoProduto);
    salvarPlanilha(wb, dados);
    return { ok: true, produto: novoProduto, estoqueAnterior: 0, estoqueNovo: qtd, novo: true };
  }

  // Produto existente
  const produto = dados[idx];
  const estoqueAnterior = Number(produto.estoque);
  const estoqueNovo = estoqueAnterior + qtd;
  dados[idx] = {
    ...produto,
    estoque: estoqueNovo,
    ...(novoPreco && Number(novoPreco) > 0 ? { preco: Number(novoPreco) } : {})
  };
  salvarPlanilha(wb, dados);

  return {
    ok: true,
    produto: dados[idx],
    estoqueAnterior,
    estoqueNovo,
    novo: false
  };
}

module.exports = {
  listarProdutos,
  listarTodosProdutos,
  buscarProduto,
  consultarEstoque,
  baixarEstoque,
  entrarEstoque
};
