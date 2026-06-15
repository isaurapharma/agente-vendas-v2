// src/webhook/handler.js
// Recebe eventos da Evolution API e roteia para o agente

const { processarMensagem } = require('../agent/agente');
const { enviarTexto, marcarComoLida, digitando } = require('./evolution');

const OWNER = process.env.OWNER_NUMBER;
const STOCK_PASSWORD = process.env.STOCK_PASSWORD || 'ESTOQUE';

/**
 * Extrai número limpo do remoteJid do WhatsApp
 * Ex: "5521999999999@s.whatsapp.net" → "5521999999999"
 */
function extrairNumero(remoteJid) {
  return remoteJid.replace(/@.+$/, '');
}

/**
 * Verifica se é mensagem de grupo (não processa grupos exceto o de entrega)
 */
function ehGrupo(remoteJid) {
  return remoteJid.endsWith('@g.us');
}

/**
 * Handler principal do webhook da Evolution API
 */
async function handleWebhook(req, res) {
  // Responde imediatamente para a Evolution API (evita timeout)
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // Evolution API envia eventos de vários tipos — só queremos mensagens recebidas
    const evento = body?.event;
    if (evento !== 'messages.upsert') return;

    const data = body?.data;
    if (!data) return;

    // Pega a mensagem
    const mensagem = data?.message || data?.messages?.[0];
    if (!mensagem) return;

    const remoteJid = mensagem?.key?.remoteJid || data?.remoteJid;
    if (!remoteJid) return;

    // Ignora mensagens de grupos (exceto o do dono via menção — futuro)
    if (ehGrupo(remoteJid)) return;

    // Ignora mensagens enviadas pelo próprio bot
    if (mensagem?.key?.fromMe) return;

    const numero = extrairNumero(remoteJid);
    const pushName = mensagem?.pushName || data?.pushName || 'amigo';

    // ── Extrai texto da mensagem ────────────────────────────────
    let textoMensagem = '';

    // Mensagem de texto simples
    if (mensagem?.message?.conversation) {
      textoMensagem = mensagem.message.conversation;
    }
    // Mensagem estendida (links, formatação)
    else if (mensagem?.message?.extendedTextMessage?.text) {
      textoMensagem = mensagem.message.extendedTextMessage.text;
    }
    // Mensagem de imagem com legenda (comprovante de PIX)
    else if (mensagem?.message?.imageMessage) {
      const caption = mensagem.message.imageMessage?.caption || '';
      textoMensagem = caption
        ? `[IMAGEM ENVIADA] ${caption}`
        : '[COMPROVANTE DE PAGAMENTO ENVIADO]';
    }
    // Mensagem de documento
    else if (mensagem?.message?.documentMessage) {
      textoMensagem = '[DOCUMENTO ENVIADO]';
    }

    if (!textoMensagem) {
      console.log(`[Webhook] Mensagem sem texto de ${numero}, ignorando.`);
      return;
    }

    console.log(`[Webhook] Mensagem de ${numero} (${pushName}): ${textoMensagem}`);

    // ── Validação de segurança para comandos de estoque ─────────
    // Só o dono pode dar entrada no estoque
    if (textoMensagem.toUpperCase().startsWith(STOCK_PASSWORD)) {
      if (numero !== OWNER) {
        await enviarTexto(remoteJid, 'Ei, esse comando é só pra mim não haha 😅');
        return;
      }
    }

    // ── Marca como lida e simula digitando ───────────────────────
    if (mensagem?.key?.id) {
      await marcarComoLida(remoteJid, mensagem.key.id);
    }
    await digitando(remoteJid, 2500);

    // ── Processa com o agente IA ─────────────────────────────────
    const resposta = await processarMensagem(numero, textoMensagem, pushName);

    // ── Envia resposta ao cliente ────────────────────────────────
    if (resposta) {
      await enviarTexto(remoteJid, resposta);
    }

  } catch (err) {
    console.error('[Webhook] Erro não tratado:', err);
  }
}

module.exports = { handleWebhook };
