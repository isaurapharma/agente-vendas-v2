// src/index.js
// Ponto de entrada do servidor
require('dotenv').config();
const express = require('express');
const { handleWebhook } = require('./webhook/handler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares ────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rotas ──────────────────────────────────────
app.post('/webhook', handleWebhook);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({ mensagem: 'Agente de Vendas WhatsApp — rodando ✅' });
});

// ── Inicia servidor ────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`\n📦 Estoque:    ${process.env.STOCK_FILE_PATH}`);
  console.log(`💳 PIX:        ${process.env.PIX_KEY}`);
  console.log(`🛵 Grupo:      ${process.env.DELIVERY_GROUP_JID}\n`);
});

// ── Monitor de conexão (verifica a cada 5 min) ─
// Reconecta automaticamente se a instância WhatsApp desconectar,
// evitando que o agente pare de responder sem que ninguém perceba.
setInterval(async () => {
  try {
    const res = await fetch(`${process.env.EVOLUTION_API_URL}/instance/connectionState/${process.env.EVOLUTION_INSTANCE}`, {
      headers: { 'apikey': process.env.EVOLUTION_API_KEY }
    });
    const data = await res.json();
    const state = data?.instance?.state;
    console.log('[Monitor] Estado da instância:', state);
    if (state !== 'open') {
      console.log('[Monitor] Instância desconectada! Reconectando...');
      await fetch(`${process.env.EVOLUTION_API_URL}/instance/connect/${process.env.EVOLUTION_INSTANCE}`, {
        method: 'GET',
        headers: { 'apikey': process.env.EVOLUTION_API_KEY }
      });
    }
  } catch (e) {
    console.error('[Monitor] Erro ao verificar conexão:', e.message);
  }
}, 5 * 60 * 1000);

// ── Tratamento de erros não capturados ────────
// IMPORTANTE: não usa process.exit() aqui — isso derrubava o servidor
// a cada erro inesperado, fazendo o agente parar de responder.
// Agora só loga o erro e continua rodando.
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise não tratada:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não capturada:', err);
});
