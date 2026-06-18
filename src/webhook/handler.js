// src/webhook/handler.js
// Recebe eventos da Evolution API e roteia para o agente

const { processarMensagem, getSessao, registrarMensagemHumana, getClienteDoAviso, processarRespostaLuizParaCliente } = require('../agent/agente');
const { enviarTexto, marcarComoLida, marcarComoNaoLida, digitando } = require('./evolution');
const { isAutorizado, adicionarContato, removerContato } = require('../stock/contatos');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
// Transcrição de áudio desativada — agora a IA avisa que não pode ouvir
// áudio e pede pra escrever, em vez de tentar transcrever (ver extrairTexto).
// const { transcreverAudioBase64, transcreverAudioUrl } = require('./transcricao');
const adminAgent = require('../agent/admin');
const midiaAdmin = require('./midia-admin');

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

// ── IDs de mensagens enviadas pela própria IA ──────────────────
// Usado para diferenciar mensagens automáticas (IA) de mensagens
// manuais que o Luiz humano digita/grava direto do WhatsApp dele.
// Quando uma msg fromMe chega e o ID NÃO está aqui, foi o Luiz humano.
const idsEnviadosPelaIA = new Set();
function registrarIdDaIA(messageId) {
  if (!messageId) return;
  idsEnviadosPelaIA.add(messageId);
  // Limpeza simples pra não crescer pra sempre em memória
  if (idsEnviadosPelaIA.size > 500) {
    const primeiro = idsEnviadosPelaIA.values().next().value;
    idsEnviadosPelaIA.delete(primeiro);
  }
}

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

    // 🎯 MARCADOR EXCLUSIVO: mostra o tipo exato da mensagem recebida
    console.log('[TIPO_MSG]', mensagem?.messageType || Object.keys(mensagem?.message || {}).join(','));

    const remoteJid = mensagem?.key?.remoteJid || data?.remoteJid;
    if (!remoteJid) {
      console.log('[Debug] remoteJid não encontrado');
      return;
    }

    // Ignora mensagens do próprio bot — MAS diferencia: se o ID não é
    // conhecido como tendo sido enviado pela IA, foi o Luiz humano
    // digitando ou gravando áudio manualmente.
    if (mensagem?.key?.fromMe) {
      const idMsg = mensagem?.key?.id;
      const foiAIA = idMsg && idsEnviadosPelaIA.has(idMsg);

      if (foiAIA) {
        console.log('[Debug] Mensagem da própria IA (fromMe), ignorando');
        return;
      }

      // Não foi a IA — foi o Luiz humano digitando manualmente.
      const adminJidAtual = process.env.ADMIN_GROUP_JID;

      // Caso 1: Luiz humano mandando mensagem manual NO GRUPO ADMIN —
      // processa normalmente como uma conversa com o agente admin.
      // EXCEÇÃO: se o texto bate com um padrão de aviso automático
      // que o próprio sistema manda (ex: acionar_luiz_humano, alerta de
      // crédito), ignora — evita reprocessar avisos automáticos como se
      // fossem instrução manual do Luiz, caso o ID não tenha sido
      // registrado a tempo por algum motivo.
      if (ehGrupo(remoteJid) && remoteJid === adminJidAtual) {
        const textoCheck = await extrairTexto(mensagem);
        const ehAvisoAutomatico = /^🔔 \*Atenção Luiz!\*|^🚨 \*/.test(textoCheck || '');
        if (ehAvisoAutomatico) {
          console.log('[Admin] Mensagem fromMe bate padrão de aviso automático, ignorando (segurança extra).');
          return;
        }
        console.log('[Admin] Mensagem manual do Luiz humano no grupo Admin, processando.');
        await handleGrupoAdmin(mensagem, remoteJid);
        return;
      }

      // Caso 2: Luiz humano respondendo manualmente direto pro cliente
      // (fora do grupo Admin) — registra pausa de 3min no agente vendedor.
      if (!ehGrupo(remoteJid)) {
        const numeroCliente = extrairNumero(remoteJid);
        const textoLuiz = await extrairTexto(mensagem);
        console.log(`[Humano] Luiz respondeu manualmente para ${numeroCliente}: ${textoLuiz}`);
        registrarMensagemHumana(numeroCliente, textoLuiz);
      }
      return;
    }

    // ── Mensagem de grupo de revendedor ───────────────────────
    if (ehGrupo(remoteJid) && ehGrupoRevendedor(remoteJid)) {
      await handleGrupoRevendedor(mensagem, remoteJid, data);
      return;
    }

    // ── Mensagem do grupo Admin: agente administrativo IA ─────
    const adminJidAtual = process.env.ADMIN_GROUP_JID;
    if (ehGrupo(remoteJid)) {
      console.log('[Debug] Comparando grupo:', remoteJid, '=== ADMIN_GROUP_JID:', adminJidAtual, '?', remoteJid === adminJidAtual);
    }
    if (ehGrupo(remoteJid) && remoteJid === adminJidAtual) {
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
      if (envio?.messageId) registrarIdDaIA(envio.messageId);
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
        await enviarTexto(remoteJid, 'só um minutinho! 🙏');
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
// IMPORTANTE: o chamador (handleWebhook) já decide quando chamar essa
// função, inclusive para mensagens fromMe=true do Luiz humano digitando
// manualmente no grupo Admin — não verificamos fromMe aqui de novo,
// senão cancelamos exatamente as mensagens manuais que queremos processar.
async function handleGrupoAdmin(mensagem, remoteJid) {
  console.log('[Admin] handleGrupoAdmin chamado para remoteJid:', remoteJid);
  try {
    const textoMensagem = await extrairTexto(mensagem);
    if (!textoMensagem) {
      console.log('[Admin] Texto vazio, abortando.');
      return;
    }

    // ── Detecta REPLY (citação) numa mensagem de aviso anterior ────
    // Se o Luiz humano respondeu (reply) em cima de uma mensagem de
    // "Atenção Luiz!" que o sistema mandou sobre um cliente específico,
    // repassa a resposta dele direto pro cliente, sem precisar passar
    // pelo agente administrativo genérico.
    const stanzaId = mensagem?.contextInfo?.stanzaId || mensagem?.message?.contextInfo?.stanzaId;
    if (stanzaId) {
      const avisoEncontrado = getClienteDoAviso(stanzaId);
      if (avisoEncontrado) {
        console.log(`[Admin] Reply detectado! Repassando resposta do Luiz pro cliente ${avisoEncontrado.clienteNumero}`);
        await processarRespostaLuizParaCliente(avisoEncontrado.clienteNumero, avisoEncontrado.clienteNome, textoMensagem);
        await enviarTexto(remoteJid, `✅ Repassei pro ${avisoEncontrado.clienteNome || avisoEncontrado.clienteNumero}!`);
        return;
      }
    }

    // ── Detecta mensagem encaminhada (forward) e captura o JID
    // de origem, pra permitir bloquear um grupo sem o Luiz humano
    // precisar saber o que é JID.
    const jidOrigemForward = extrairJidForward(mensagem);

    let textoParaAgente = textoMensagem;
    if (jidOrigemForward) {
      textoParaAgente = `[MENSAGEM ENCAMINHADA DE OUTRO CHAT — JID de origem: ${jidOrigemForward}]\n${textoMensagem}`;
      console.log(`[Admin] Forward detectado, JID de origem: ${jidOrigemForward}`);
    }

    // ── Detecta imagem, PDF ou planilha mandados no Admin ──────────
    // Permite o Luiz humano mandar foto de comprovante/tabela, PDF ou
    // planilha que o sistema lê o conteúdo de fato, em vez de só
    // registrar "[DOCUMENTO ENVIADO]" genérico.
    const legendaOuTexto = textoMensagem?.startsWith('[') ? null : textoMensagem;
    let conteudoMultimodal = null;

    const conteudoImagem = midiaAdmin.montarConteudoImagem(mensagem, legendaOuTexto);
    if (conteudoImagem) {
      conteudoMultimodal = conteudoImagem;
      console.log('[Admin] Imagem detectada, montando conteúdo multimodal.');
    }

    if (!conteudoMultimodal) {
      const conteudoPdf = await midiaAdmin.montarConteudoPdf(mensagem, legendaOuTexto);
      if (conteudoPdf) {
        conteudoMultimodal = conteudoPdf;
        console.log('[Admin] PDF detectado, montando conteúdo multimodal.');
      }
    }

    if (!conteudoMultimodal) {
      const textoPlanilha = await midiaAdmin.montarConteudoPlanilha(mensagem, legendaOuTexto);
      if (textoPlanilha) {
        textoParaAgente = textoPlanilha;
        console.log('[Admin] Planilha detectada, conteúdo extraído como texto.');
      }
    }

    console.log(`[Admin] Mensagem recebida: ${textoParaAgente}`);

    await digitando(remoteJid, 1500);

    console.log('[Admin] Chamando processarMensagemAdmin...');
    const resposta = await adminAgent.processarMensagemAdmin(textoParaAgente, conteudoMultimodal);
    console.log('[Admin] Resposta recebida:', JSON.stringify(resposta));

    if (resposta) {
      const envio = await enviarTexto(remoteJid, resposta);
      console.log('[Admin] Resultado do envio:', JSON.stringify(envio));
      if (envio?.messageId) {
        registrarIdDaIA(envio.messageId);
        // Marca o grupo Admin como não lido pra chamar atenção de que
        // teve atividade nova. Se falhar, só loga — não interrompe o
        // fluxo (a resposta já foi enviada com sucesso de qualquer forma).
        const resultadoNaoLida = await marcarComoNaoLida(remoteJid, envio.messageId);
        if (!resultadoNaoLida?.ok) {
          console.error('[Admin] Não consegui marcar o grupo como não lido:', resultadoNaoLida?.erro);
        }
      }
    }

  } catch (err) {
    console.error('[Webhook] Erro no grupo admin:', err?.message, err?.stack);
    try {
      await enviarTexto(remoteJid, '⚠️ Deu erro ao processar isso aqui, tenta de novo ou me chama.');
    } catch (_) {}
  }
}

// ── Extrai o JID de origem de uma mensagem encaminhada ─────────
// A Evolution API (baseada no Baileys) traz isso em contextInfo,
// que pode estar em diferentes tipos de mensagem (texto, imagem, etc).
function extrairJidForward(mensagem) {
  const msg = mensagem?.message;
  if (!msg) return null;

  // contextInfo pode estar em qualquer um dos tipos de mensagem
  const contextInfo =
    msg?.extendedTextMessage?.contextInfo ||
    msg?.conversation?.contextInfo ||
    msg?.imageMessage?.contextInfo ||
    msg?.videoMessage?.contextInfo ||
    msg?.audioMessage?.contextInfo ||
    msg?.documentMessage?.contextInfo ||
    msg?.messageContextInfo ||
    null;

  if (!contextInfo) return null;

  // isForwarded indica que foi encaminhada; remoteJid/participant do
  // contextInfo aponta pro chat de origem em alguns formatos da Evolution
  const ehForward = contextInfo?.isForwarded || (contextInfo?.forwardingScore || 0) > 0;
  if (!ehForward) return null;

  return contextInfo?.remoteJid || contextInfo?.participant || null;
}

// ── Extrator de texto ─────────────────────────────────────────
async function extrairTexto(mensagem) {
  if (mensagem?.message?.conversation) {
    return mensagem.message.conversation;
  }
  if (mensagem?.message?.extendedTextMessage?.text) {
    return mensagem.message.extendedTextMessage.text;
  }

  // ── Áudio: não tenta mais transcrever. A transcrição (Whisper) se
  // mostrou pouco confiável em produção e gerava custo/erro sem entregar
  // valor. Agora avisa direto que não pode ouvir e pede pra escrever —
  // vale tanto pra clientes quanto pro grupo Admin, já que essa função
  // é compartilhada por todos os fluxos.
  if (mensagem?.message?.audioMessage) {
    return '[ÁUDIO RECEBIDO — instrua a pessoa que você não pode ouvir áudios e peça pra ela escrever a mensagem, de forma natural e educada]';
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
