// src/stock/contatos.js
// Gerencia lista de contatos autorizados a receber resposta do agente

const fs = require('fs');
const path = require('path');

const FILE = path.resolve('./data/contatos.json');

// ── Helpers ──────────────────────────────────

function carregar() {
  if (!fs.existsSync(FILE)) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ numeros: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
}

function salvar(dados) {
  fs.writeFileSync(FILE, JSON.stringify(dados, null, 2));
}

function limparNumero(numero) {
  return String(numero).replace(/\D/g, '');
}

// ── API pública ───────────────────────────────

/**
 * Verifica se número está autorizado
 */
function isAutorizado(numero) {
  const dados = carregar();
  const n = limparNumero(numero);
  return dados.numeros.includes(n);
}

/**
 * Adiciona número à whitelist
 */
function adicionarContato(numero) {
  const dados = carregar();
  const n = limparNumero(numero);
  if (!dados.numeros.includes(n)) {
    dados.numeros.push(n);
    salvar(dados);
    return { ok: true, novo: true, numero: n };
  }
  return { ok: true, novo: false, numero: n };
}

/**
 * Remove número da whitelist
 */
function removerContato(numero) {
  const dados = carregar();
  const n = limparNumero(numero);
  const idx = dados.numeros.indexOf(n);
  if (idx === -1) return { ok: false, erro: 'Número não encontrado.' };
  dados.numeros.splice(idx, 1);
  salvar(dados);
  return { ok: true, numero: n };
}

/**
 * Importa contatos de arquivo VCF (exportado do celular)
 * @param {string} vcfTexto - conteúdo do arquivo .vcf
 */
function importarVCF(vcfTexto) {
  const dados = carregar();
  const regex = /TEL[^:]*:([\d\s\-\+\(\)]+)/gi;
  let match;
  let adicionados = 0;

  while ((match = regex.exec(vcfTexto)) !== null) {
    const n = limparNumero(match[1]);
    // Só importa números brasileiros (10-13 dígitos)
    if (n.length >= 10 && n.length <= 13) {
      // Adiciona prefixo 55 se não tiver
      const numero = n.startsWith('55') ? n : `55${n}`;
      if (!dados.numeros.includes(numero)) {
        dados.numeros.push(numero);
        adicionados++;
      }
    }
  }

  salvar(dados);
  return { ok: true, adicionados, total: dados.numeros.length };
}

/**
 * Lista todos os contatos autorizados
 */
function listarContatos() {
  const dados = carregar();
  return dados.numeros;
}

module.exports = {
  isAutorizado,
  adicionarContato,
  removerContato,
  importarVCF,
  listarContatos
};
