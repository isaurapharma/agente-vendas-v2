// src/index.js
// Ponto de entrada do servidor
require('dotenv').config();
const express = require('express');
const { handleWebhook } = require('./webhook/handler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validação de variáveis de ambiente obrigatórias ────────────
// FIX: falha rápido no startup em vez de só errar na primeira mensagem
const ENV_OBRIGATORIAS = [
  'ANTHROPIC_API_KEY',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'PIX_KEY',
  'ADMIN_GROUP_JID',
];
const envFaltando = ENV_OBRIGATORIAS.filter(k => !process.env[k]);
if (envFaltando.length > 0) {
  console.error(`\n❌ Variáveis de ambiente obrigatórias não configuradas:\n   ${envFaltando.join(', ')}\n`);
  console.error('Configure essas variáveis antes de iniciar o servidor.\n');
  process.exit(1);
}

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
  console.log(`\n📦 Estoque:    ${process.env.STOCK_FILE_PATH || './data/estoque.xlsx'}`);
  console.log(`💳 PIX:        ${process.env.PIX_KEY}`);
  console.log(`🛵 Admin:      ${process.env.ADMIN_GROUP_JID}\n`);

  // Inicia monitor de conexão APÓS o servidor estar pronto
  iniciarMonitorConexao();
});

// ── Monitor de conexão (verifica a cada 5 min) ─────────────────
// FIX: extraído em função separada e com timeout no fetch para não travar
function iniciarMonitorConexao() {
  setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(
        `${process.env.EVOLUTION_API_URL}/instance/connectionState/${process.env.EVOLUTION_INSTANCE}`,
        {
          headers: { 'apikey': process.env.EVOLUTION_API_KEY },
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);

      const data = await res.json();
      const state = data?.instance?.state;
      console.log('[Monitor] Estado da instância:', state);

      if (state !== 'open') {
        console.log('[Monitor] Instância desconectada! Tentando reconectar...');
        const ctrlRecon = new AbortController();
        const tIdRecon = setTimeout(() => ctrlRecon.abort(), 10000);
        await fetch(
          `${process.env.EVOLUTION_API_URL}/instance/connect/${process.env.EVOLUTION_INSTANCE}`,
          {
            method: 'GET',
            headers: { 'apikey': process.env.EVOLUTION_API_KEY },
            signal: ctrlRecon.signal
          }
        );
        clearTimeout(tIdRecon);
      }
    } catch (e) {
      console.error('[Monitor] Erro ao verificar conexão:', e.message);
    }
  }, 5 * 60 * 1000);
}

// ── Tratamento de erros não capturados ────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise não tratada:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não capturada:', err);
  // Não chama process.exit() para manter o servidor rodando,
  // mas loga para diagnóstico. Recomenda-se usar PM2 com restart automático.
});
