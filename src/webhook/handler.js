// src/webhook/handler.js
// Recebe eventos da Evolution API e roteia para o agente

const { processarMensagem, getSessao } = require('../agent/agente');
const { enviarTexto, marcarComoLida, digitando } = require('./evolution');
const { isAutorizado, adicionarContato, removerContato } = require('../stock/contatos');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
const { transcreverAudioBase64, transcreverAudioUrl } = require('./transcricao');
const adminAgent = require('../agent/admin');

const OWNER        = process.env.OWNER_NUMBER;
const ADMIN_JID    = process.env.ADMIN_GROUP_JID;
const DELIVERY_JID = process.env.DELIVERY_GROUP_JID;

// ── Números bloqueados ──────────────────────────────────────────
// O agente NUNCA responde esses números, independente de qualquer coisa.
// Adicionar/remover via comando BLOQUEAR ADD / BLOQUEAR REMOVE no grupo admin.
const NUMEROS_BLOQUEADOS = new Set([
  '5522997487799',
  '5521972140886',
  '5521965696252',
  '5521965184171',
  '595975183457',
  '595993461127',
  '59599209662',
  '558597470079',
  '5518981887592',
  '595992607680',
  '5521969926165',
  '5522999454961',
  '5521982529614',
  '5521981536611',
]);

function limparNumero(numero) {
  return String(numero).replace(/\D/g, '');
}

function ehBloqueado(numero) {
  return NUMEROS_BLOQUEADOS.has(limparNumero(numero));
}

// ── Mapa de pedidos despachados: messageId → clienteNumero ─────
const pedidosDespachados = new Map();

// ── Grupos de revendedores ─────────────────────────────────────
const GRUPOS_REVENDEDORES = {
  '120363426913801854@g.us': 'Daniel',
  '120363418902001474@g.us': 'Gabriel',
  '120363398195263032@g.us': 'Rafael',
  '120363405252871406@g.us': 'Carlos',
  '120363398953557075@g.us': 'Neguett',
  '120363403741398789@g.us': 'Felipe',
  '120363418454463330@g.us': 'Tribal',
  '120363022703847296@g.us': 'Zé Rolha',
  '120363419343091632@g.us': 'Raphael Leal',
  '120363305190062448@g.us': 'David',
  '120363420845403813@g.us': 'Big Jeff',
  '120363400248813120@g.us': 'Ziraldo',
  '120363383370702200@g.us': 'DVD',
};

// ── Grupos administrativos/controle — agente NUNCA responde ────
const GRUPOS_BLOQUEADOS = new Set([
  '120363407039455353@g.us', // Grupo Suplespharma Rio
  '120363304267841815@g.us', // Entregas Claudinha
  '120363376341821982@g.us', // Anotações
  '120363404306878361@g.us', // Entregas Vitor
]);

// ── Clientes especiais (desconto, VIP, observações) ────────────
const CLIENTES_ESPECIAIS = {};

// ── Registra as referências compartilhadas no agente admin ────
adminAgent.registrarReferencias({
  numerosBloqueados: NUMEROS_BLOQUEADOS,
  gruposBloqueados: GRUPOS_BLOQUEADOS,
  gruposRevendedores: GRUPOS_REVENDEDORES,
  clientesEspeciais: CLIENTES_ESPECIAIS,
  regrasExtras: { texto: '' },
  pedidosDoDia: [],
});

function extrairNumero(remoteJid) {
  return remoteJid.replace(/@.+$/, '');
}

function ehGrupo(remoteJid) {
  return remoteJid.endsWith('@g.us');
}

function ehGrupoRevendedor(remoteJid) {
  return !!GRUPOS_REVENDEDORES[remoteJid];
}

function nomeRevendedor(remoteJid) {
  return GRUPOS_REVENDEDORES[remoteJid] || 'Revendedor';
}

// ── Registra pedido despachado para rastrear entrega ──────────
function registrarPedidoDespachado(messageId, clienteNumero, clienteNome, itens) {
  pedidosDespachados.set(messageId, { clienteNumero, clienteNome, itens, timestamp: Date.now() });
  console.log(`[Pedido] Registrado: ${messageId} → ${clienteNumero}`);
}

// ── Handler principal ──────────────────────────────────────────
async function handleWebhook(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // 🔍 LOG TEMPORÁRIO DE DEBUG — mostra o payload completo recebido
    console.log('PAYLOAD RAW:', JSON.stringify(body));

    const event = body?.event;
    console.log('[Debug] evento:', event);

    // ── Evento: reação / update de mensagem ───────────────────
    if (event === 'messages.update') {
      await handleMessagesUpdate(body);
      return;
    }

    if (event !== 'messages.upsert') return;

    const data     = body?.data;
    // O payload da Evolution API traz a mensagem direto em "data"
    // (data.key, data.message, data.pushName) — não em data.message.key
    const mensagem = data?.key ? data : (data?.messages?.[0] || null);
    if (!mensagem) {
      console.log('[Debug] Nenhuma "mensagem" encontrada em data');
      return;
    }

    const remoteJid = mensagem?.key?.remoteJid || data?.remoteJid;
    if (!remoteJid) {
      console.log('[Debug] remoteJid não encontrado');
      return;
    }

    // Ignora mensagens do próprio bot
    if (mensagem?.key?.fromMe) {
      console.log('[Debug] Mensagem do próprio bot (fromMe), ignorando');
      return;
    }

    // ── Mensagem de grupo de revendedor ───────────────────────
    if (ehGrupo(remoteJid) && ehGrupoRevendedor(remoteJid)) {
      await handleGrupoRevendedor(mensagem, remoteJid, data);
      return;
    }

    // ── Mensagem do grupo Admin: agente administrativo IA ─────
    if (ehGrupo(remoteJid) && remoteJid === ADMIN_JID) {
      await handleGrupoAdmin(mensagem, remoteJid);
      return;
    }

    // Ignora outros grupos
    if (ehGrupo(remoteJid)) {
      console.log('[Debug] Mensagem de grupo não-revendedor, ignorando:', remoteJid);
      return;
    }

    // ── Mensagem direta (cliente ou dono) ─────────────────────
    const numero   = extrairNumero(remoteJid);
    const pushName = mensagem?.pushName || data?.pushName || 'cliente';

    // ── Número bloqueado: ignora completamente, sem exceção ───
    if (ehBloqueado(numero)) {
      console.log(`[Bloqueado] Mensagem de ${numero} ignorada (lista de bloqueio).`);
      return;
    }

    let textoMensagem = await extrairTexto(mensagem);
    console.log('[Debug] Texto extraído:', JSON.stringify(textoMensagem));

    if (!textoMensagem) {
      console.log('[Debug] Texto vazio após extração, abortando. Estrutura da mensagem:', JSON.stringify(mensagem?.message));
      return;
    }

    console.log(`[Webhook] Mensagem de ${numero} (${pushName}): ${textoMensagem}`);

    // ── Comandos do dono ──────────────────────────────────────
    if (numero === OWNER) {
      const tratado = await handleComandosDono(textoMensagem, remoteJid);
      if (tratado) return;
    }

    // ── Verifica se número é autorizado ───────────────────────
    //if (!isAutorizado(numero)) {
     // console.log(`[Webhook] Número não autorizado: ${numero} — ignorado.`);
     // return;
    //}

    // ── Marca como lida e simula digitando ────────────────────
    // NÃO marca como lida — assim o Luiz humano vê o badge de não lidas
    // e sabe que teve atividade ali, mesmo que a IA já tenha respondido.
    // await marcarComoLida(remoteJid, mensagem.key.id);
    await digitando(remoteJid, 2500);

    // ── Processa com o agente IA (cliente final) ──────────────
    console.log('[Debug] Chamando processarMensagem...');
    const resposta = await processarMensagem(numero, textoMensagem, pushName, false);
    console.log('[Debug] Resposta do agente:', JSON.stringify(resposta));

    if (resposta) {
      const envio = await enviarTexto(remoteJid, resposta);
      console.log('[Debug] Resultado do envio:', JSON.stringify(envio));
    }

  } catch (err) {
    console.error('[Webhook] Erro não tratado:', err);
    // Garante que o cliente nunca fique sem nenhuma resposta por erro interno
    try {
      const body = req.body;
      const data = body?.data;
      const mensagem = data?.key ? data : (data?.messages?.[0] || null);
      const remoteJid = mensagem?.key?.remoteJid;
      if (remoteJid && !remoteJid.endsWith('@g.us')) {
        await enviarTexto(remoteJid, 'opa, deu um perrengue aqui rapidinho! já volto 🙏');
      }
    } catch (_) {}
  }
}

// ── Detecta 👍 do Luiz humano no grupo Pedidos do dia ─────────
async function handleMessagesUpdate(body) {
  try {
    const updates = body?.data;
    if (!Array.isArray(updates)) return;

    for (const update of updates) {
      const remoteJid  = update?.key?.remoteJid;
      const messageId  = update?.key?.id;

      if (remoteJid !== DELIVERY_JID) continue;

      const reactions = update?.update?.messageStubParameters ||
                        update?.reactions ||
                        update?.update?.reactions;

      let temJoinha = false;

      if (Array.isArray(reactions)) {
        temJoinha = reactions.some(r =>
          r?.text === '👍' || r?.emoji === '👍' || r === '👍'
        );
      }

      if (!temJoinha && update?.update?.reaction?.text === '👍') {
        temJoinha = true;
        const msgIdOriginal = update?.update?.reaction?.key?.id;
        if (msgIdOriginal && pedidosDespachados.has(msgIdOriginal)) {
          await notificarEntrega(msgIdOriginal);
          continue;
        }
      }

      if (temJoinha && messageId && pedidosDespachados.has(messageId)) {
        await notificarEntrega(messageId);
      }
    }
  } catch (err) {
    console.error('[MessagesUpdate] Erro:', err);
  }
}

// ── Envia mensagem de entrega confirmada ao cliente ───────────
async function notificarEntrega(messageId) {
  const pedido = pedidosDespachados.get(messageId);
  if (!pedido) return;

  console.log(`[Entrega] 👍 detectado! Notificando cliente ${pedido.clienteNumero}`);

  const clienteJid = `${pedido.clienteNumero}@s.whatsapp.net`;
  await enviarTexto(clienteJid,
    `✅️ Está entregue!\n\n` +
    `🚨Por favor, confira o pedido no mesmo dia! Não nos responsabilizamos por danos após o dia da entrega.\n\n` +
    `*MUITO OBRIGADO E BONS GANHOS!* 💪😄`
  );

  pedidosDespachados.delete(messageId);
}

// ── Handler de grupos de revendedores ─────────────────────────
async function handleGrupoRevendedor(mensagem, remoteJid, data) {
  try {
    if (mensagem?.key?.fromMe) return;

    const pushName      = mensagem?.pushName || data?.pushName || 'revendedor';
    const textoMensagem = await extrairTexto(mensagem);
    if (!textoMensagem) return;

    const nomeRev = nomeRevendedor(remoteJid);
    console.log(`[Revendedor] ${nomeRev} (${remoteJid}): ${textoMensagem}`);

    await digitando(remoteJid, 2000);

    const resposta = await processarMensagem(remoteJid, textoMensagem, nomeRev, true);
    if (resposta) {
      await enviarTexto(remoteJid, resposta);
    }

  } catch (err) {
    console.error('[Webhook] Erro no grupo revendedor:', err);
  }
}

// ── Handler do grupo Admin: linguagem natural via agente IA ───
async function handleGrupoAdmin(mensagem, remoteJid) {
  try {
    if (mensagem?.key?.fromMe) return;

    const textoMensagem = await extrairTexto(mensagem);
    if (!textoMensagem) return;

    console.log(`[Admin] Mensagem recebida: ${textoMensagem}`);

    await digitando(remoteJid, 1500);

    const resposta = await adminAgent.processarMensagemAdmin(textoMensagem);
    if (resposta) {
      await enviarTexto(remoteJid, resposta);
    }

  } catch (err) {
    console.error('[Webhook] Erro no grupo admin:', err);
    try {
      await enviarTexto(remoteJid, '⚠️ Deu erro ao processar isso aqui, tenta de novo ou me chama.');
    } catch (_) {}
  }
}

// ── Extrator de texto ─────────────────────────────────────────
async function extrairTexto(mensagem) {
  if (mensagem?.message?.conversation) {
    return mensagem.message.conversation;
  }
  if (mensagem?.message?.extendedTextMessage?.text) {
    return mensagem.message.extendedTextMessage.text;
  }

  // ── Áudio: transcreve com Whisper antes de seguir ─────────
  if (mensagem?.message?.audioMessage) {
    const audioMsg  = mensagem.message.audioMessage;
    const mimetype  = audioMsg?.mimetype || 'audio/ogg';
    let transcricao = null;

    // Caso 1: Webhook Base64 ligado — o áudio vem direto em base64
    const base64Audio = mensagem?.message?.base64 || audioMsg?.base64 || mensagem?.base64;
    if (base64Audio) {
      transcricao = await transcreverAudioBase64(base64Audio, mimetype);
    }
    // Caso 2: vem como URL
    else if (audioMsg?.url) {
      transcricao = await transcreverAudioUrl(audioMsg.url);
    }

    if (transcricao) {
      console.log('[Transcricao] Áudio transcrito:', transcricao);
      return `[ÁUDIO TRANSCRITO]: ${transcricao}`;
    }
    return '[ÁUDIO ENVIADO — não foi possível transcrever]';
  }

  if (mensagem?.message?.imageMessage) {
    const caption = mensagem.message.imageMessage?.caption || '';
    return caption ? `[IMAGEM ENVIADA] ${caption}` : '[COMPROVANTE DE PAGAMENTO ENVIADO]';
  }
  if (mensagem?.message?.documentMessage) {
    const fileName = mensagem.message.documentMessage?.fileName || '';
    if (fileName.endsWith('.vcf')) return '[ARQUIVO VCF DE CONTATOS]';
    return '[DOCUMENTO ENVIADO]';
  }
  return '';
}

// ── Comandos do dono ──────────────────────────────────────────
async function handleComandosDono(texto, remoteJid) {
  const t = texto.toUpperCase();

  if (t.startsWith('CLIENTE ADD:')) {
    const novoNumero = texto.split(':')[1]?.trim();
    if (novoNumero) {
      const r = adicionarContato(novoNumero);
      await enviarTexto(remoteJid,
        r.novo ? `✅ Número ${r.numero} adicionado!` : `⚠️ Número ${r.numero} já estava na lista.`
      );
    }
    return true;
  }

  if (t.startsWith('CLIENTE REMOVE:')) {
    const numRemover = texto.split(':')[1]?.trim();
    if (numRemover) {
      const r = removerContato(numRemover);
      await enviarTexto(remoteJid, r.ok ? `✅ Número ${r.numero} removido!` : `⚠️ ${r.erro}`);
    }
    return true;
  }

  if (t.startsWith('APELIDO ADD:')) {
    const partes = texto.slice('APELIDO ADD:'.length).split('|');
    const nomeProduto = partes[0]?.trim();
    const apelidosStr = partes[1]?.trim();
    if (nomeProduto && apelidosStr) {
      const r = adicionarApelidos(nomeProduto, apelidosStr);
      await enviarTexto(remoteJid,
        `✅ Apelidos de *${r.produto}* atualizados!\n📝 Apelidos: ${r.apelidos.join(', ')}`
      );
    } else {
      await enviarTexto(remoteJid, '⚠️ Formato:\nAPELIDO ADD: nome do produto | apelido1, apelido2');
    }
    return true;
  }

  if (t.startsWith('APELIDO REMOVE:')) {
    const partes = texto.slice('APELIDO REMOVE:'.length).split('|');
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
      await enviarTexto(remoteJid, '⚠️ Formato:\nAPELIDO REMOVE: nome do produto | apelido1, apelido2');
    }
    return true;
  }

  if (t.startsWith('APELIDO VER')) {
    const nomeProduto = texto.slice('APELIDO VER'.length).replace(/^:\s*/, '').trim();
    if (nomeProduto) {
      const r = verApelidos(nomeProduto);
      await enviarTexto(remoteJid,
        r.apelidos.length > 0
          ? `📝 *${r.produto}*\nApelidos: ${r.apelidos.join(', ')}`
          : `ℹ️ *${r.produto}* não tem apelidos cadastrados.`
      );
    } else {
      const todos = listarTodosApelidos();
      if (todos.length === 0) {
        await enviarTexto(remoteJid, 'ℹ️ Nenhum apelido cadastrado ainda.');
      } else {
        const lista = todos.map(e => `• *${e.nomeOriginal}*: ${e.apelidos.join(', ')}`).join('\n');
        await enviarTexto(remoteJid, `📋 *Apelidos cadastrados:*\n\n${lista}`);
      }
    }
    return true;
  }

  if (t.startsWith('REVENDEDOR ADD:')) {
    const partes = texto.slice('REVENDEDOR ADD:'.length).split('|');
    const jid  = partes[0]?.trim();
    const nome = partes[1]?.trim();
    if (jid && nome) {
      GRUPOS_REVENDEDORES[jid] = nome;
      await enviarTexto(remoteJid, `✅ Grupo *${nome}* adicionado como revendedor!`);
    } else {
      await enviarTexto(remoteJid, '⚠️ Formato:\nREVENDEDOR ADD: jid@g.us | Nome');
    }
    return true;
  }

  if (t.startsWith('REVENDEDOR VER')) {
    const lista = Object.entries(GRUPOS_REVENDEDORES)
      .map(([jid, nome]) => `• *${nome}*: ${jid}`)
      .join('\n');
    await enviarTexto(remoteJid, `📋 *Grupos de revendedores:*\n\n${lista}`);
    return true;
  }

  if (t.startsWith('BLOQUEAR ADD:')) {
    const novoNumero = texto.split(':')[1]?.trim();
    if (novoNumero) {
      const n = limparNumero(novoNumero);
      NUMEROS_BLOQUEADOS.add(n);
      await enviarTexto(remoteJid, `🚫 Número ${n} adicionado à lista de bloqueio. O agente não vai mais responder ele.`);
    } else {
      await enviarTexto(remoteJid, '⚠️ Formato:\nBLOQUEAR ADD: 5521999999999');
    }
    return true;
  }

  if (t.startsWith('BLOQUEAR REMOVE:')) {
    const numRemover = texto.split(':')[1]?.trim();
    if (numRemover) {
      const n = limparNumero(numRemover);
      const existia = NUMEROS_BLOQUEADOS.delete(n);
      await enviarTexto(remoteJid,
        existia ? `✅ Número ${n} removido da lista de bloqueio.` : `⚠️ Número ${n} não estava bloqueado.`
      );
    } else {
      await enviarTexto(remoteJid, '⚠️ Formato:\nBLOQUEAR REMOVE: 5521999999999');
    }
    return true;
  }

  if (t.startsWith('BLOQUEAR VER')) {
    const lista = Array.from(NUMEROS_BLOQUEADOS).map(n => `• ${n}`).join('\n');
    await enviarTexto(remoteJid, `🚫 *Números bloqueados:*\n\n${lista || 'Nenhum.'}`);
    return true;
  }

  if (t.startsWith('GRUPO BLOQUEAR ADD:')) {
    const jid = texto.split(':')[1]?.trim();
    if (jid) {
      GRUPOS_BLOQUEADOS.add(jid);
      GRUPOS_REVENDEDORES[jid] && delete GRUPOS_REVENDEDORES[jid];
      await enviarTexto(remoteJid, `🚫 Grupo ${jid} adicionado à lista de bloqueio. Agente nunca vai responder nele.`);
    } else {
      await enviarTexto(remoteJid, '⚠️ Formato:\nGRUPO BLOQUEAR ADD: 120363xxxxxx@g.us');
    }
    return true;
  }

  if (t.startsWith('GRUPO BLOQUEAR VER')) {
    const lista = Array.from(GRUPOS_BLOQUEADOS).map(j => `• ${j}`).join('\n');
    await enviarTexto(remoteJid, `🚫 *Grupos bloqueados:*\n\n${lista || 'Nenhum.'}`);
    return true;
  }

  return false;
}

module.exports = { handleWebhook, registrarPedidoDespachado };
