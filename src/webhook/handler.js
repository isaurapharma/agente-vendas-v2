// src/webhook/handler.js
// Recebe eventos da Evolution API e roteia para o agente

const { processarMensagem } = require('../agent/agente');
const { enviarTexto, marcarComoLida, digitando } = require('./evolution');
const { isAutorizado, adicionarContato, removerContato, importarVCF } = require('../stock/contatos');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');

const OWNER         = process.env.OWNER_NUMBER;
const STOCK_PW      = process.env.STOCK_PASSWORD || 'ESTOQUE';

function extrairNumero(remoteJid) {
  return remoteJid.replace(/@.+$/, '');
}

function ehGrupo(remoteJid) {
  return remoteJid.endsWith('@g.us');
}

async function handleWebhook(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body?.event !== 'messages.upsert') return;

    const data     = body?.data;
    const mensagem = data?.message || data?.messages?.[0];
    if (!mensagem) return;

    const remoteJid = mensagem?.key?.remoteJid || data?.remoteJid;
    if (!remoteJid) return;

    // Ignora grupos
    if (ehGrupo(remoteJid)) return;

    // Ignora mensagens do próprio bot
    if (mensagem?.key?.fromMe) return;

    const numero   = extrairNumero(remoteJid);
    const pushName = mensagem?.pushName || data?.pushName || 'cliente';

    // ── Extrai texto ──────────────────────────────────────────────
    let textoMensagem = '';

    if (mensagem?.message?.conversation) {
      textoMensagem = mensagem.message.conversation;
    } else if (mensagem?.message?.extendedTextMessage?.text) {
      textoMensagem = mensagem.message.extendedTextMessage.text;
    } else if (mensagem?.message?.imageMessage) {
      const caption = mensagem.message.imageMessage?.caption || '';
      textoMensagem = caption ? `[IMAGEM ENVIADA] ${caption}` : '[COMPROVANTE DE PAGAMENTO ENVIADO]';
    } else if (mensagem?.message?.documentMessage) {
      // Pode ser arquivo VCF de contatos
      const fileName = mensagem.message.documentMessage?.fileName || '';
      if (fileName.endsWith('.vcf')) {
        textoMensagem = '[ARQUIVO VCF DE CONTATOS]';
      } else {
        textoMensagem = '[DOCUMENTO ENVIADO]';
      }
    }

    if (!textoMensagem) return;

    console.log(`[Webhook] Mensagem de ${numero} (${pushName}): ${textoMensagem}`);

    // ── Comandos do dono ──────────────────────────────────────────
    if (numero === OWNER) {

      // Adicionar contato
      if (textoMensagem.toUpperCase().startsWith('CLIENTE ADD:')) {
        const novoNumero = textoMensagem.split(':')[1]?.trim();
        if (novoNumero) {
          const r = adicionarContato(novoNumero);
          await enviarTexto(remoteJid,
            r.novo
              ? `✅ Número ${r.numero} adicionado com sucesso!`
              : `⚠️ Número ${r.numero} já estava na lista.`
          );
        }
        return;
      }

      // Remover contato
      if (textoMensagem.toUpperCase().startsWith('CLIENTE REMOVE:')) {
        const numRemover = textoMensagem.split(':')[1]?.trim();
        if (numRemover) {
          const r = removerContato(numRemover);
          await enviarTexto(remoteJid,
            r.ok
              ? `✅ Número ${r.numero} removido com sucesso!`
              : `⚠️ ${r.erro}`
          );
        }
        return;
      }

      // ── Comandos de apelidos ──────────────────────────────────────
      // Formato: APELIDO ADD: nome do produto | apelido1, apelido2
      if (textoMensagem.toUpperCase().startsWith('APELIDO ADD:')) {
        const partes = textoMensagem.slice('APELIDO ADD:'.length).split('|');
        const nomeProduto = partes[0]?.trim();
        const apelidosStr = partes[1]?.trim();
        if (nomeProduto && apelidosStr) {
          const r = adicionarApelidos(nomeProduto, apelidosStr);
          await enviarTexto(remoteJid,
            `✅ Apelidos de *${r.produto}* atualizados!\n` +
            `📝 Apelidos cadastrados: ${r.apelidos.join(', ')}`
          );
        } else {
          await enviarTexto(remoteJid,
            '⚠️ Formato correto:\nAPELIDO ADD: nome do produto | apelido1, apelido2'
          );
        }
        return;
      }

      // Formato: APELIDO REMOVE: nome do produto | apelido1, apelido2
      if (textoMensagem.toUpperCase().startsWith('APELIDO REMOVE:')) {
        const partes = textoMensagem.slice('APELIDO REMOVE:'.length).split('|');
        const nomeProduto = partes[0]?.trim();
        const apelidosStr = partes[1]?.trim();
        if (nomeProduto && apelidosStr) {
          const r = removerApelidos(nomeProduto, apelidosStr);
          await enviarTexto(remoteJid,
            r.ok
              ? `✅ ${r.removidos} apelido(s) removido(s) de *${r.produto}*.\nRestantes: ${r.apelidos.join(', ') || 'nenhum'}`
              : `⚠️ ${r.erro}`
          );
        } else {
          await enviarTexto(remoteJid,
            '⚠️ Formato correto:\nAPELIDO REMOVE: nome do produto | apelido1, apelido2'
          );
        }
        return;
      }

      // Formato: APELIDO VER: nome do produto  (ou só APELIDO VER para listar tudo)
      if (textoMensagem.toUpperCase().startsWith('APELIDO VER')) {
        const nomeProduto = textoMensagem.slice('APELIDO VER'.length).replace(/^:\s*/, '').trim();
        if (nomeProduto) {
          const r = verApelidos(nomeProduto);
          await enviarTexto(remoteJid,
            r.apelidos.length > 0
              ? `📝 *${r.produto}*\nApelidos: ${r.apelidos.join(', ')}`
              : `ℹ️ *${r.produto}* não tem apelidos cadastrados.`
          );
        } else {
          // Lista tudo
          const todos = listarTodosApelidos();
          if (todos.length === 0) {
            await enviarTexto(remoteJid, 'ℹ️ Nenhum apelido cadastrado ainda.');
          } else {
            const lista = todos.map(e => `• *${e.nomeOriginal}*: ${e.apelidos.join(', ')}`).join('\n');
            await enviarTexto(remoteJid, `📋 *Apelidos cadastrados:*\n\n${lista}`);
          }
        }
        return;
      }

      // Importar VCF
      if (textoMensagem === '[ARQUIVO VCF DE CONTATOS]') {
        await enviarTexto(remoteJid, '📋 Recebi o arquivo de contatos! Processando...');
        // Nota: extração real do VCF requer baixar o arquivo via Evolution API
        // Por ora, retorna instrução
        await enviarTexto(remoteJid, '⚠️ Para importar contatos via VCF, use o comando:\nCLIENTE ADD: número\npara cada novo cliente.');
        return;
      }
    }

    // ── Verifica se número é autorizado ───────────────────────────
    if (!isAutorizado(numero)) {
      // Número não autorizado — ignora silenciosamente
      console.log(`[Webhook] Número não autorizado: ${numero} — ignorado.`);
      return;
    }

    // ── Comandos de estoque (só dono) ─────────────────────────────
    if (textoMensagem.toUpperCase().startsWith(STOCK_PW) && numero !== OWNER) {
      return; // Ignora silenciosamente
    }

    // ── Marca como lida e simula digitando ────────────────────────
    if (mensagem?.key?.id) {
      await marcarComoLida(remoteJid, mensagem.key.id);
    }
    await digitando(remoteJid, 2500);

    // ── Processa com o agente IA ──────────────────────────────────
    const resposta = await processarMensagem(numero, textoMensagem, pushName);
    if (resposta) {
      await enviarTexto(remoteJid, resposta);
    }

  } catch (err) {
    console.error('[Webhook] Erro não tratado:', err);
  }
}

module.exports = { handleWebhook };
