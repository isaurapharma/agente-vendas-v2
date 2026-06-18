// src/webhook/evolution.js
// Cliente para envio de mensagens via Evolution API

const axios = require('axios');

const BASE = process.env.EVOLUTION_API_URL;
const KEY  = process.env.EVOLUTION_API_KEY;
const INST = process.env.EVOLUTION_INSTANCE;

const api = axios.create({
  baseURL: `${BASE}/message`,
  headers: {
    'Content-Type': 'application/json',
    'apikey': KEY
  },
  timeout: 15000
});

// ── Enviar texto simples ──────────────────────────────────────
// Retorna { ok, messageId, data } para rastrear pedidos despachados
async function enviarTexto(para, texto) {
  try {
    const res = await api.post(`/sendText/${INST}`, {
      number: para,
      text: texto
    });
    const messageId = res.data?.key?.id || res.data?.messageId || null;
    return { ok: true, messageId, data: res.data };
  } catch (err) {
    console.error('[Evolution] Erro ao enviar texto:', err?.response?.data || err.message);
    return { ok: false, erro: err.message };
  }
}

// ── Enviar imagem com legenda ─────────────────────────────────
async function enviarImagem(para, urlOuBase64, legenda = '') {
  try {
    const payload = urlOuBase64.startsWith('http')
      ? { number: para, mediatype: 'image', mimetype: 'image/jpeg', media: urlOuBase64, caption: legenda }
      : { number: para, mediatype: 'image', mimetype: 'image/jpeg', media: urlOuBase64, caption: legenda, encoding: 'base64' };

    const res = await api.post(`/sendMedia/${INST}`, payload);
    return { ok: true, data: res.data };
  } catch (err) {
    console.error('[Evolution] Erro ao enviar imagem:', err?.response?.data || err.message);
    return { ok: false, erro: err.message };
  }
}

// ── Marcar mensagem como lida ─────────────────────────────────
async function marcarComoLida(remoteJid, messageId) {
  try {
    await axios.post(`${BASE}/chat/markMessageAsRead/${INST}`, {
      readMessages: [{ remoteJid, id: messageId, fromMe: false }]
    }, {
      headers: { 'apikey': KEY }
    });
  } catch (_) {}
}

// ── Marcar chat como NÃO lido ─────────────────────────────────
// Usado depois que o agente responde no grupo Admin, pra chamar atenção
// de que teve atividade nova ali. Atenção: existe relato conhecido de
// bug nesse endpoint específico da Evolution API em certas versões
// (erro "myAppStateKey not present") — por isso loga o erro real em
// vez de engolir silenciosamente, pra facilitar diagnóstico se falhar.
async function marcarComoNaoLida(remoteJid, messageId) {
  try {
    await axios.post(`${BASE}/chat/markChatUnread/${INST}`, {
      lastMessage: [{ remoteJid, fromMe: true, id: messageId }],
      chat: remoteJid
    }, {
      headers: { 'apikey': KEY }
    });
    return { ok: true };
  } catch (err) {
    console.error('[Evolution] Erro ao marcar chat como não lido:', err?.response?.data || err.message);
    return { ok: false, erro: err?.response?.data || err.message };
  }
}

// ── Simular "digitando..." ────────────────────────────────────
async function digitando(remoteJid, duracaoMs = 2000) {
  try {
    await axios.post(`${BASE}/chat/sendPresence/${INST}`, {
      number: remoteJid,
      options: { presence: 'composing', delay: duracaoMs }
    }, {
      headers: { 'apikey': KEY }
    });
  } catch (_) {}
}

module.exports = { enviarTexto, enviarImagem, marcarComoLida, marcarComoNaoLida, digitando };
