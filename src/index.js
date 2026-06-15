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

// Webhook principal da Evolution API
app.post('/webhook', handleWebhook);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Rota raiz
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

// ── Tratamento de erros não capturados ────────
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise não tratada:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não capturada:', err);
});
