// src/webhook/evolution.js
// Cliente para envio de mensagens via Evolution API

const axios = require('axios');

const BASE = process.env.EVOLUTION_API_URL;
const KEY  = process.env.EVOLUTION_API_KEY;
const INST = process.env.EVOLUTION_INSTANCE;

// FIX: instância única com timeout para TODAS as chamadas (antes marcarComoLida
// e digitando usavam axios direto sem timeout, podendo travar indefinidamente)
const api = axios.create({
  baseURL: BASE,
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
    const res = await api.post(`/message/sendText/${INST}`, {
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
async function enviarImagem(para, urlOuBase64, legenda = '', mimetype = 'image/jpeg') {
  try {
    // FIX: detecção de URL mais robusta com regex
    const ehUrl = /^https?:\/\//i.test(urlOuBase64);
    const payload = ehUrl
      ? { number: para, mediatype: 'image', mimetype, media: urlOuBase64, caption: legenda }
      : { number: para, mediatype: 'image', mimetype, media: urlOuBase64, caption: legenda, encoding: 'base64' };

    const res = await api.post(`/message/sendMedia/${INST}`, payload);
    return { ok: true, data: res.data };
  } catch (err) {
    console.error('[Evolution] Erro ao enviar imagem:', err?.response?.data || err.message);
    return { ok: false, erro: err.message };
  }
}

// ── Marcar mensagem como lida ─────────────────────────────────
// FIX: agora usa a instância `api` com timeout configurado
async function marcarComoLida(remoteJid, messageId) {
  try {
    await api.post(`/chat/markMessageAsRead/${INST}`, {
      readMessages: [{ remoteJid, id: messageId, fromMe: false }]
    });
  } catch (_) {}
}

// ── Marcar chat como NÃO lido ─────────────────────────────────
// Usado depois que o agente responde no grupo Admin, pra chamar atenção
// de que teve atividade nova ali. Existe relato de bug nesse endpoint
// em certas versões da Evolution API — por isso loga o erro real.
async function marcarComoNaoLida(remoteJid, messageId) {
  try {
    await api.post(`/chat/markChatUnread/${INST}`, {
      lastMessage: [{ remoteJid, fromMe: true, id: messageId }],
      chat: remoteJid
    });
    return { ok: true };
  } catch (err) {
    console.error('[Evolution] Erro ao marcar chat como não lido:', err?.response?.data || err.message);
    return { ok: false, erro: err?.response?.data || err.message };
  }
}

// ── Simular "digitando..." ────────────────────────────────────
// FIX: agora usa a instância `api` com timeout configurado
async function digitando(remoteJid, duracaoMs = 2000) {
  try {
    await api.post(`/chat/sendPresence/${INST}`, {
      number: remoteJid,
      options: { presence: 'composing', delay: duracaoMs }
    });
  } catch (_) {}
}

module.exports = { enviarTexto, enviarImagem, marcarComoLida, marcarComoNaoLida, digitando };
