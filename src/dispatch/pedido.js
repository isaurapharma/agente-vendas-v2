// src/dispatch/pedido.js
// Monta a mensagem de pedido e envia pro grupo do motoboy/ajudante

const { enviarTexto } = require('../webhook/evolution');

const GRUPO = process.env.DELIVERY_GROUP_JID;

/**
 * Envia o pedido confirmado para o grupo de entrega
 * @param {object} pedido
 * @param {string} pedido.clienteNome
 * @param {string} pedido.clienteNumero
 * @param {Array}  pedido.itens  — [{ nome, quantidade, precoUnit }]
 * @param {number} pedido.subtotal
 * @param {number} pedido.frete
 * @param {number} pedido.total
 * @param {string} pedido.enderecoEntrega
 * @param {string} pedido.observacoes
 */
async function despacharPedido(pedido) {
  if (!GRUPO) {
    console.warn('[Dispatch] DELIVERY_GROUP_JID não configurado. Pedido não enviado ao grupo.');
    return { ok: false, erro: 'Grupo de entrega não configurado.' };
  }

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const numero = String(pedido.numeroPedido || Date.now()).slice(-6);

  // ── Monta mensagem do pedido ──────────────────────────────────
  const itensTexto = pedido.itens
    .map(i => `  • ${i.nome} x${i.quantidade} — R$ ${Number(i.precoUnit * i.quantidade).toFixed(2)}`)
    .join('\n');

  const msg = [
    `🛵 *NOVO PEDIDO #${numero}*`,
    `📅 ${agora}`,
    ``,
    `👤 *Cliente:* ${pedido.clienteNome}`,
    `📱 *WhatsApp:* ${pedido.clienteNumero}`,
    ``,
    `🛍️ *Itens:*`,
    itensTexto,
    ``,
    `💰 Subtotal: R$ ${Number(pedido.subtotal).toFixed(2)}`,
    `🚚 Frete: R$ ${Number(pedido.frete).toFixed(2)}`,
    `✅ *TOTAL: R$ ${Number(pedido.total).toFixed(2)}*`,
    ``,
    pedido.enderecoEntrega
      ? `📍 *Endereço:*\n${pedido.enderecoEntrega}`
      : `📍 Endereço: não informado`,
    ``,
    pedido.observacoes
      ? `📝 *Obs:* ${pedido.observacoes}`
      : null,
    ``,
    `💳 *Pagamento: PIX CONFIRMADO ✅*`
  ]
    .filter(l => l !== null)
    .join('\n');

  const resultado = await enviarTexto(GRUPO, msg);

  if (resultado.ok) {
    console.log(`[Dispatch] Pedido #${numero} enviado ao grupo de entrega.`);
  }

  return { ...resultado, numeroPedido: numero };
}

module.exports = { despacharPedido };
