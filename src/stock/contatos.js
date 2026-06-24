// src/stock/contatos.js
// Whitelist de contatos autorizados a receber atendimento do agente.
// Se a whitelist estiver vazia, TODOS são atendidos (modo aberto).
// Se tiver pelo menos 1 contato, só esses são atendidos (modo restrito).

const fs   = require('fs');
const path = require('path');

const FILE = path.resolve(process.env.CONTATOS_FILE_PATH || './data/contatos.json');

// ── Helpers ───────────────────────────────────

function carregar() {
  try {
    if (!fs.existsSync(FILE)) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify([], null, 2));
      return [];
    }
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (err) {
    console.error('[Contatos] Erro ao carregar contatos:', err.message);
    return [];
  }
}

function salvar(lista) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(lista, null, 2));
  } catch (err) {
    console.error('[Contatos] Erro ao salvar contatos:', err.message);
  }
}

function limparNumero(numero) {
  return String(numero).replace(/\D/g, '');
}

// ── API pública ───────────────────────────────

/**
 * Verifica se um número está autorizado a receber atendimento.
 * Se a lista estiver vazia, todos são autorizados (modo aberto).
 * @param {string} numero
 * @returns {boolean}
 */
function isAutorizado(numero) {
  const lista = carregar();
  if (lista.length === 0) return true; // modo aberto
  return lista.includes(limparNumero(numero));
}

/**
 * Adiciona um número à whitelist de contatos autorizados.
 * @param {string} numero
 * @returns {{ ok: boolean, numero: string, novo: boolean }}
 */
function adicionarContato(numero) {
  const n = limparNumero(numero);
  const lista = carregar();
  if (lista.includes(n)) {
    return { ok: true, numero: n, novo: false };
  }
  lista.push(n);
  salvar(lista);
  return { ok: true, numero: n, novo: true };
}

/**
 * Remove um número da whitelist de contatos autorizados.
 * @param {string} numero
 * @returns {{ ok: boolean, numero: string, erro?: string }}
 */
function removerContato(numero) {
  const n = limparNumero(numero);
  const lista = carregar();
  const idx = lista.indexOf(n);
  if (idx === -1) {
    return { ok: false, numero: n, erro: `Número ${n} não estava na lista.` };
  }
  lista.splice(idx, 1);
  salvar(lista);
  return { ok: true, numero: n };
}

/**
 * Lista todos os contatos autorizados.
 * @returns {string[]}
 */
function listarContatos() {
  return carregar();
}

module.exports = {
  isAutorizado,
  adicionarContato,
  removerContato,
  listarContatos
};
