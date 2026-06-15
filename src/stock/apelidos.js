// src/stock/apelidos.js
// Gerencia apelidos/sinônimos dos produtos (nomes alternativos que o cliente usa)

const fs   = require('fs');
const path = require('path');

const FILE = path.resolve('./data/apelidos.json');

// ── Helpers ──────────────────────────────────

function carregar() {
  if (!fs.existsSync(FILE)) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
}

function salvar(dados) {
  fs.writeFileSync(FILE, JSON.stringify(dados, null, 2));
}

function normalizar(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ── API pública ───────────────────────────────

/**
 * Adiciona apelidos a um produto
 * @param {string} nomeProduto - nome exato do produto na planilha
 * @param {string} apelidosStr - apelidos separados por vírgula
 * @returns {{ ok: boolean, produto: string, apelidos: string[], adicionados: number }}
 */
function adicionarApelidos(nomeProduto, apelidosStr) {
  const dados = carregar();
  const chave = normalizar(nomeProduto);

  if (!dados[chave]) dados[chave] = { nomeOriginal: nomeProduto, apelidos: [] };

  const novos = apelidosStr
    .split(',')
    .map(a => normalizar(a))
    .filter(a => a.length > 0 && !dados[chave].apelidos.includes(a));

  dados[chave].apelidos.push(...novos);
  salvar(dados);

  return {
    ok: true,
    produto: nomeProduto,
    apelidos: dados[chave].apelidos,
    adicionados: novos.length
  };
}

/**
 * Remove apelidos específicos de um produto
 * @param {string} nomeProduto
 * @param {string} apelidosStr - apelidos a remover, separados por vírgula
 */
function removerApelidos(nomeProduto, apelidosStr) {
  const dados = carregar();
  const chave = normalizar(nomeProduto);

  if (!dados[chave]) return { ok: false, erro: `Produto "${nomeProduto}" não tem apelidos cadastrados.` };

  const remover = apelidosStr.split(',').map(a => normalizar(a));
  const antes = dados[chave].apelidos.length;
  dados[chave].apelidos = dados[chave].apelidos.filter(a => !remover.includes(a));
  salvar(dados);

  return {
    ok: true,
    produto: nomeProduto,
    apelidos: dados[chave].apelidos,
    removidos: antes - dados[chave].apelidos.length
  };
}

/**
 * Lista os apelidos de um produto
 */
function verApelidos(nomeProduto) {
  const dados = carregar();
  const chave = normalizar(nomeProduto);
  if (!dados[chave] || dados[chave].apelidos.length === 0) {
    return { ok: true, produto: nomeProduto, apelidos: [] };
  }
  return { ok: true, produto: nomeProduto, apelidos: dados[chave].apelidos };
}

/**
 * Dado um termo digitado pelo cliente, retorna o nome original do produto
 * se houver um apelido correspondente. Retorna null se não encontrar.
 * @param {string} termo
 * @returns {string|null} nome original do produto ou null
 */
function resolverApelido(termo) {
  const dados = carregar();
  const t = normalizar(termo);

  for (const chave of Object.keys(dados)) {
    const entrada = dados[chave];
    // Verifica se o termo bate com algum apelido (busca parcial)
    if (entrada.apelidos.some(a => t.includes(a) || a.includes(t))) {
      return entrada.nomeOriginal;
    }
  }
  return null;
}

/**
 * Lista todos os produtos que têm apelidos cadastrados
 */
function listarTodosApelidos() {
  const dados = carregar();
  return Object.values(dados).filter(e => e.apelidos.length > 0);
}

module.exports = {
  adicionarApelidos,
  removerApelidos,
  verApelidos,
  resolverApelido,
  listarTodosApelidos
};
