// src/webhook/handler.js
const fs   = require('fs');
const path = require('path');
const { processarMensagem, getSessao, registrarMensagemHumana, getClienteDoAviso, processarRespostaLuizParaCliente } = require('../agent/agente');
const { enviarTexto, marcarComoLida, marcarComoNaoLida, digitando } = require('./evolution');
const { isAutorizado, adicionarContato, removerContato } = require('../stock/contatos');
const { adicionarApelidos, removerApelidos, verApelidos, listarTodosApelidos } = require('../stock/apelidos');
const adminAgent = require('../agent/admin');
const midiaAdmin = require('./midia-admin');

const OWNER     = process.env.OWNER_NUMBER;
const ADMIN_JID = process.env.ADMIN_GROUP_JID;

const NUMEROS_BLOQUEADOS = new Set([
  '5521964191319','5521969686730','5521984517516','5521999434305',
  '5518981887592','5585974700079','595975183457','5521972790712',
  '595992607680','5521982529614','5521981536611','5521995324342',
  '5521965696252','5521980480797','5521965184171','5521996881985',
  '5521978237000','5521990928899','5522999917676','5521964947668',
  '5521971776922','5521998162579','5521982750274','5521992126548',
  '5521998030180','595993461127','595992097662',
]);

function limparNumero(n) { return String(n).replace(/\D/g,''); }
function ehBloqueado(n)  { return NUMEROS_BLOQUEADOS.has(limparNumero(n)); }

const PEDIDOS_FILE = path.resolve(process.env.PEDIDOS_FILE || './data/pedidos-despachados.json');
function carregarPedidos() {
  try { if (fs.existsSync(PEDIDOS_FILE)) return new Map(Object.entries(JSON.parse(fs.readFileSync(PEDIDOS_FILE,'utf-8')))); } catch(e){}
  return new Map();
}
function salvarPedidos(m) {
  try {
    const dir = path.dirname(PEDIDOS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    const obj={}; for(const [k,v] of m.entries()) obj[k]=v;
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(obj,null,2),'utf-8');
  } catch(e){ console.error('[Pedidos] Erro ao salvar:',e.message); }
}
const pedidosDespachados = carregarPedidos();
console.log(`[Pedidos] ${pedidosDespachados.size} pedido(s) carregado(s).`);

const idsEnviadosPelaIA = new Set();
function registrarIdDaIA(id) {
  if (!id) return;
  idsEnviadosPelaIA.add(id);
  if (idsEnviadosPelaIA.size > 500) idsEnviadosPelaIA.delete(idsEnviadosPelaIA.values().next().value);
}

const GRUPOS_REVENDEDORES = {
  '120363426913801854@g.us':'Daniel','120363418902001474@g.us':'Gabriel',
  '120363398195263032@g.us':'Rafael','120363405252871406@g.us':'Carlos',
  '120363398953557075@g.us':'Neguett','120363403741398789@g.us':'Felipe',
  '120363419343091632@g.us':'Raphael Leal','120363305190062448@g.us':'David',
  '120363420845403813@g.us':'Big Jeff','120363400248813120@g.us':'Ziraldo',
  '120363383370702200@g.us':'DVD','120363427597386558@g.us':'Fornecedor',
};
const GRUPOS_BLOQUEADOS = new Set([
  '120363407039455353@g.us','120363304267841815@g.us','120363376341821982@g.us',
  '120363404306878361@g.us','120363022703847296@g.us','120363375512280777@g.us',
  '120363418454463330@g.us',
]);
const CLIENTES_ESPECIAIS = {};

adminAgent.registrarReferencias({
  numerosBloqueados: NUMEROS_BLOQUEADOS, gruposBloqueados: GRUPOS_BLOQUEADOS,
  gruposRevendedores: GRUPOS_REVENDEDORES, clientesEspeciais: CLIENTES_ESPECIAIS,
  regrasExtras: { texto: '' }, pedidosDoDia: [],
});

function extrairNumero(jid) { return jid.replace(/@.+$/,''); }
function ehGrupo(jid)        { return jid.endsWith('@g.us'); }
function ehGrupoRevendedor(jid) { return !!GRUPOS_REVENDEDORES[jid]; }
function nomeRevendedor(jid) { return GRUPOS_REVENDEDORES[jid] || 'Revendedor'; }

// FIX: detecta se pushName é número (contato não salvo na agenda)
function ehDesconhecido(pushName, numero) {
  if (!pushName) return true;
  const semFormatacao = pushName.replace(/[\s\+\-\(\)]/g,'');
  return /^\d{8,}$/.test(semFormatacao) || semFormatacao === numero;
}

function registrarPedidoDespachado(messageId, clienteNumero, clienteNome, itens) {
  pedidosDespachados.set(messageId,{clienteNumero,clienteNome,itens,timestamp:Date.now()});
  salvarPedidos(pedidosDespachados);
}

async function handleWebhook(req, res) {
  res.status(200).json({ ok: true });
  let remoteJid = null;
  try {
    const body = req.body;
    console.log('PAYLOAD RAW:', JSON.stringify(body));
    const event = body?.event;
    console.log('[Debug] evento:', event);

    if (event === 'messages.update') { await handleMessagesUpdate(body); return; }
    if (event !== 'messages.upsert') return;

    const data     = body?.data;
    const mensagem = data?.key ? data : (data?.messages?.[0] || null);
    if (!mensagem) return;

    console.log('[TIPO_MSG]', mensagem?.messageType || Object.keys(mensagem?.message||{}).join(','));

    remoteJid = mensagem?.key?.remoteJid || data?.remoteJid;
    if (!remoteJid) return;

    // FIX: adminJidAtual declarado UMA VEZ
    const adminJidAtual = process.env.ADMIN_GROUP_JID;

    if (mensagem?.key?.fromMe) {
      const idMsg  = mensagem?.key?.id;
      const foiAIA = idMsg && idsEnviadosPelaIA.has(idMsg);
      if (foiAIA) return;

      if (ehGrupo(remoteJid) && remoteJid === adminJidAtual) {
        const textoCheck = await extrairTexto(mensagem);
        if (/^🔔 \*Atenção Luiz!\*|^🚨 \*/.test(textoCheck||'')) return;
        await handleGrupoAdmin(mensagem, remoteJid);
        return;
      }
      if (!ehGrupo(remoteJid)) {
        registrarMensagemHumana(extrairNumero(remoteJid), await extrairTexto(mensagem));
      }
      return;
    }

    if (ehGrupo(remoteJid) && ehGrupoRevendedor(remoteJid)) { await handleGrupoRevendedor(mensagem,remoteJid,data); return; }
    if (ehGrupo(remoteJid) && remoteJid === adminJidAtual)   { await handleGrupoAdmin(mensagem,remoteJid); return; }
    if (ehGrupo(remoteJid)) return;

    const numero   = extrairNumero(remoteJid);
    const pushName = mensagem?.pushName || data?.pushName || '';

    if (ehBloqueado(numero)) return;

    // FIX: bloqueia atendimento a desconhecidos (não salvos na agenda)
    if (ehDesconhecido(pushName, numero)) {
      console.log(`[Desconhecido] ${numero} não está na agenda, notificando Luiz.`);
      const adminJid = process.env.ADMIN_GROUP_JID;
      if (adminJid) {
        await enviarTexto(adminJid,
          `🔔 *Número desconhecido tentou contato*\n\n` +
          `📱 Número: ${numero}\n` +
          `⚠️ Contato não está salvo na agenda. Verificar quem é antes de liberar atendimento.`
        );
      }
      return;
    }

    let textoMensagem = await extrairTexto(mensagem);

    let conteudoMultimodalCliente = null;
    const imgCliente = midiaAdmin.montarConteudoImagem(mensagem, textoMensagem);
    if (imgCliente) { conteudoMultimodalCliente = imgCliente; if (!textoMensagem) textoMensagem = '[IMAGEM RECEBIDA]'; }
    if (!conteudoMultimodalCliente) {
      const pdfCliente = await midiaAdmin.montarConteudoPdf(mensagem, textoMensagem);
      if (pdfCliente) { conteudoMultimodalCliente = pdfCliente; if (!textoMensagem) textoMensagem = '[PDF RECEBIDO]'; }
    }

    const contextInfo = mensagem?.message?.extendedTextMessage?.contextInfo ||
                        mensagem?.message?.imageMessage?.contextInfo ||
                        mensagem?.message?.documentMessage?.contextInfo ||
                        mensagem?.message?.contextInfo;
    const textoMsgCitada = contextInfo?.quotedMessage?.conversation ||
                           contextInfo?.quotedMessage?.extendedTextMessage?.text;
    if (textoMsgCitada && textoMensagem) textoMensagem = `[Em resposta a: "${textoMsgCitada}"] ${textoMensagem}`;

    if (!textoMensagem) return;

    console.log(`[Webhook] ${numero} (${pushName}): ${textoMensagem}`);

    if (numero === OWNER) {
      const tratado = await handleComandosDono(textoMensagem, remoteJid);
      if (tratado) return;
    }

    await digitando(remoteJid, 2500);
    const resposta = await processarMensagem(numero, textoMensagem, pushName, false, conteudoMultimodalCliente);
    if (resposta) {
      const envio = await enviarTexto(remoteJid, resposta);
      if (envio?.messageId) registrarIdDaIA(envio.messageId);
    }

  } catch (err) {
    console.error('[Webhook] Erro não tratado:', err);
    try { if (remoteJid && !remoteJid.endsWith('@g.us')) await enviarTexto(remoteJid,'só um minutinho! 🙏'); } catch(_){}
  }
}

async function handleMessagesUpdate(body) {
  try {
    const updates = body?.data;
    if (!Array.isArray(updates)) return;
    const adminJid = process.env.ADMIN_GROUP_JID;
    for (const update of updates) {
      const remoteJid = update?.key?.remoteJid;
      const messageId = update?.key?.id;
      if (remoteJid !== adminJid) continue;
      const reactions = update?.update?.messageStubParameters || update?.reactions || update?.update?.reactions;
      let temJoinha = Array.isArray(reactions) && reactions.some(r=>r?.text==='👍'||r?.emoji==='👍'||r==='👍');
      if (!temJoinha && update?.update?.reaction?.text==='👍') {
        temJoinha = true;
        const msgIdOriginal = update?.update?.reaction?.key?.id;
        if (msgIdOriginal && pedidosDespachados.has(msgIdOriginal)) { await notificarEntrega(msgIdOriginal); continue; }
      }
      if (temJoinha && messageId && pedidosDespachados.has(messageId)) await notificarEntrega(messageId);
    }
  } catch(err){ console.error('[MessagesUpdate] Erro:',err); }
}

async function notificarEntrega(messageId) {
  const pedido = pedidosDespachados.get(messageId);
  if (!pedido) return;
  console.log(`[Entrega] 👍 detectado! Notificando ${pedido.clienteNumero}`);
  try {
    const estoqueAdmin = require('../stock/estoque-admin');
    if (Array.isArray(pedido.itens)) {
      for (const item of pedido.itens) estoqueAdmin.registrarSaida(item.nome, item.quantidade||1, pedido.clienteNome||pedido.clienteNumero,'normal');
    }
  } catch(err){ console.error('[Entrega] Erro estoque:',err.message); }

  const clienteJid = pedido.clienteNumero.includes('@') ? pedido.clienteNumero : `${pedido.clienteNumero}@s.whatsapp.net`;
  const ehRev = pedido.clienteNumero.includes('@g.us');

  // FIX: mensagem de entrega diferente para revendedor
  await enviarTexto(clienteJid,
    ehRev
      ? `✅ Entregue! Qualquer coisa é só chamar 🫡`
      : `✅️ Está entregue!\n\n🚨 Por favor, confira o pedido no mesmo dia! Não nos responsabilizamos por danos após o dia da entrega.\n\n*MUITO OBRIGADO E BONS GANHOS!* 💪`
  );
  pedidosDespachados.delete(messageId);
  salvarPedidos(pedidosDespachados);
}

async function handleGrupoRevendedor(mensagem, remoteJid, data) {
  try {
    if (mensagem?.key?.fromMe) return;
    const pushName = mensagem?.pushName || data?.pushName || 'revendedor';
    let textoRev   = await extrairTexto(mensagem);
    let mmRev      = null;
    const imgRev   = midiaAdmin.montarConteudoImagem(mensagem, textoRev);
    if (imgRev) { mmRev = imgRev; if (!textoRev) textoRev = '[IMAGEM RECEBIDA]'; }
    if (!mmRev) {
      const pdfRev = await midiaAdmin.montarConteudoPdf(mensagem, textoRev);
      if (pdfRev) { mmRev = pdfRev; if (!textoRev) textoRev = '[PDF RECEBIDO]'; }
    }
    if (!textoRev) return;
    console.log(`[Revendedor] ${nomeRevendedor(remoteJid)}: ${textoRev}`);
    await digitando(remoteJid, 2000);
    const resposta = await processarMensagem(remoteJid, textoRev, nomeRevendedor(remoteJid), true, mmRev);
    if (resposta) {
      const envio = await enviarTexto(remoteJid, resposta);
      if (envio?.messageId) registrarIdDaIA(envio.messageId);
    }
  } catch(err){ console.error('[Webhook] Erro revendedor:',err); }
}

async function handleGrupoAdmin(mensagem, remoteJid) {
  console.log('[Admin] handleGrupoAdmin:', remoteJid);
  try {
    const textoMensagem = await extrairTexto(mensagem);
    if (!textoMensagem) return;

    // FIX: stanzaId nos locais corretos dentro de message.*
    const stanzaId =
      mensagem?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
      mensagem?.message?.imageMessage?.contextInfo?.stanzaId ||
      mensagem?.message?.documentMessage?.contextInfo?.stanzaId ||
      mensagem?.message?.contextInfo?.stanzaId || null;

    if (stanzaId) {
      const aviso = getClienteDoAviso(stanzaId);
      if (aviso) {
        console.log(`[Admin] Reply → repassando pro cliente ${aviso.clienteNumero}`);

        // FIX: se o reply do Luiz tiver valor de frete de Correios,
        // marca enderecoJaCadastrado = true na sessão do cliente
        const sessao = getSessao(aviso.clienteNumero);
        if (/R\$\s*\d+|reais|correios/i.test(textoMensagem) && sessao.endereco) {
          sessao.enderecoJaCadastrado = true;
          const { salvarSessoesNoDisco } = require('../agent/agente');
          salvarSessoesNoDisco();
        }

        await processarRespostaLuizParaCliente(aviso.clienteNumero, aviso.clienteNome, textoMensagem);
        await enviarTexto(remoteJid, `✅ Repassei pro ${aviso.clienteNome || aviso.clienteNumero}!`);
        return;
      }
    }

    const jidOrigemForward = extrairJidForward(mensagem);
    let textoParaAgente = textoMensagem;
    if (jidOrigemForward) textoParaAgente = `[MENSAGEM ENCAMINHADA DE OUTRO CHAT — JID de origem: ${jidOrigemForward}]\n${textoMensagem}`;

    const legendaOuTexto = textoMensagem?.startsWith('[') ? null : textoMensagem;
    let mm = null;
    const img = midiaAdmin.montarConteudoImagem(mensagem, legendaOuTexto);
    if (img) { mm = img; }
    if (!mm) { const pdf = await midiaAdmin.montarConteudoPdf(mensagem, legendaOuTexto); if (pdf) mm = pdf; }
    if (!mm) { const plan = await midiaAdmin.montarConteudoPlanilha(mensagem, legendaOuTexto); if (plan) textoParaAgente = plan; }

    await digitando(remoteJid, 1500);
    const resposta = await adminAgent.processarMensagemAdmin(textoParaAgente, mm);
    if (resposta) {
      const envio = await enviarTexto(remoteJid, resposta);
      if (envio?.messageId) {
        registrarIdDaIA(envio.messageId);
        const r = await marcarComoNaoLida(remoteJid, envio.messageId);
        if (!r?.ok) console.error('[Admin] Não consegui marcar não lido:', r?.erro);
      }
    }
  } catch(err){
    console.error('[Webhook] Erro admin:', err?.message, err?.stack);
    try { await enviarTexto(remoteJid,'⚠️ Deu erro ao processar isso aqui, tenta de novo.'); } catch(_){}
  }
}

function extrairJidForward(mensagem) {
  const msg = mensagem?.message;
  if (!msg) return null;
  const ctx = msg?.extendedTextMessage?.contextInfo || msg?.imageMessage?.contextInfo ||
              msg?.videoMessage?.contextInfo || msg?.audioMessage?.contextInfo ||
              msg?.documentMessage?.contextInfo || msg?.messageContextInfo || null;
  if (!ctx) return null;
  const ehFwd = ctx?.isForwarded || (ctx?.forwardingScore||0) > 0;
  if (!ehFwd) return null;
  return ctx?.remoteJid || ctx?.participant || null;
}

async function extrairTexto(mensagem) {
  if (mensagem?.message?.conversation)                   return mensagem.message.conversation;
  if (mensagem?.message?.extendedTextMessage?.text)      return mensagem.message.extendedTextMessage.text;
  if (mensagem?.message?.audioMessage)                   return '[ÁUDIO RECEBIDO — instrua a pessoa que você não pode ouvir áudios e peça pra ela escrever a mensagem, de forma natural e educada]';
  if (mensagem?.message?.imageMessage) {
    const cap = mensagem.message.imageMessage?.caption || '';
    return cap ? `[IMAGEM ENVIADA] ${cap}` : '[COMPROVANTE DE PAGAMENTO ENVIADO]';
  }
  if (mensagem?.message?.documentMessage) {
    const fn = mensagem.message.documentMessage?.fileName || '';
    if (fn.endsWith('.vcf')) return '[ARQUIVO VCF DE CONTATOS]';
    return '[DOCUMENTO ENVIADO]';
  }
  return '';
}

async function handleComandosDono(texto, remoteJid) {
  const t = texto.toUpperCase();

  if (t.startsWith('CLIENTE ADD:')) {
    const n = texto.split(':')[1]?.trim();
    if (n) { const r=adicionarContato(n); await enviarTexto(remoteJid, r.novo?`✅ ${r.numero} adicionado!`:`⚠️ ${r.numero} já estava na lista.`); }
    return true;
  }
  if (t.startsWith('CLIENTE REMOVE:')) {
    const n = texto.split(':')[1]?.trim();
    if (n) { const r=removerContato(n); await enviarTexto(remoteJid, r.ok?`✅ ${r.numero} removido!`:`⚠️ ${r.erro}`); }
    return true;
  }
  if (t.startsWith('APELIDO ADD:')) {
    const p=texto.slice('APELIDO ADD:'.length).split('|');
    if (p[0]?.trim()&&p[1]?.trim()) { const r=adicionarApelidos(p[0].trim(),p[1].trim()); await enviarTexto(remoteJid,`✅ Apelidos de *${r.produto}* atualizados!\n📝 ${r.apelidos.join(', ')}`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nAPELIDO ADD: nome do produto | apelido1, apelido2');
    return true;
  }
  if (t.startsWith('APELIDO REMOVE:')) {
    const p=texto.slice('APELIDO REMOVE:'.length).split('|');
    if (p[0]?.trim()&&p[1]?.trim()) { const r=removerApelidos(p[0].trim(),p[1].trim()); await enviarTexto(remoteJid, r.ok?`✅ ${r.removidos} removido(s) de *${r.produto}*. Restantes: ${r.apelidos.join(', ')||'nenhum'}`:`⚠️ ${r.erro}`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nAPELIDO REMOVE: nome do produto | apelido1, apelido2');
    return true;
  }
  if (t.startsWith('APELIDO VER')) {
    const nome = texto.slice('APELIDO VER'.length).replace(/^:\s*/,'').trim();
    if (nome) { const r=verApelidos(nome); await enviarTexto(remoteJid, r.apelidos.length>0?`📝 *${r.produto}*\nApelidos: ${r.apelidos.join(', ')}`:`ℹ️ *${r.produto}* não tem apelidos.`); }
    else { const todos=listarTodosApelidos(); await enviarTexto(remoteJid, todos.length===0?'ℹ️ Nenhum apelido cadastrado.':`📋 *Apelidos:*\n\n${todos.map(e=>`• *${e.nomeOriginal}*: ${e.apelidos.join(', ')}`).join('\n')}`); }
    return true;
  }
  if (t.startsWith('REVENDEDOR ADD:')) {
    const p=texto.slice('REVENDEDOR ADD:'.length).split('|');
    if (p[0]?.trim()&&p[1]?.trim()) { GRUPOS_REVENDEDORES[p[0].trim()]=p[1].trim(); await enviarTexto(remoteJid,`✅ Grupo *${p[1].trim()}* adicionado!`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nREVENDEDOR ADD: jid@g.us | Nome');
    return true;
  }
  if (t.startsWith('REVENDEDOR VER')) {
    await enviarTexto(remoteJid,`📋 *Revendedores:*\n\n${Object.entries(GRUPOS_REVENDEDORES).map(([j,n])=>`• *${n}*: ${j}`).join('\n')}`);
    return true;
  }
  if (t.startsWith('BLOQUEAR ADD:')) {
    const n=texto.split(':')[1]?.trim();
    if (n) { NUMEROS_BLOQUEADOS.add(limparNumero(n)); await enviarTexto(remoteJid,`🚫 ${limparNumero(n)} bloqueado.`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nBLOQUEAR ADD: 5521999999999');
    return true;
  }
  if (t.startsWith('BLOQUEAR REMOVE:')) {
    const n=texto.split(':')[1]?.trim();
    if (n) { const l=limparNumero(n); const ex=NUMEROS_BLOQUEADOS.delete(l); await enviarTexto(remoteJid, ex?`✅ ${l} desbloqueado.`:`⚠️ ${l} não estava bloqueado.`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nBLOQUEAR REMOVE: 5521999999999');
    return true;
  }
  if (t.startsWith('BLOQUEAR VER')) {
    await enviarTexto(remoteJid,`🚫 *Bloqueados:*\n\n${Array.from(NUMEROS_BLOQUEADOS).map(n=>`• ${n}`).join('\n')||'Nenhum.'}`);
    return true;
  }
  if (t.startsWith('GRUPO BLOQUEAR ADD:')) {
    const jid=texto.split(':')[1]?.trim();
    if (jid) { GRUPOS_BLOQUEADOS.add(jid); if(GRUPOS_REVENDEDORES[jid]) delete GRUPOS_REVENDEDORES[jid]; await enviarTexto(remoteJid,`🚫 Grupo ${jid} bloqueado.`); }
    else await enviarTexto(remoteJid,'⚠️ Formato:\nGRUPO BLOQUEAR ADD: 120363xxxxxx@g.us');
    return true;
  }
  if (t.startsWith('GRUPO BLOQUEAR VER')) {
    await enviarTexto(remoteJid,`🚫 *Grupos bloqueados:*\n\n${Array.from(GRUPOS_BLOQUEADOS).map(j=>`• ${j}`).join('\n')||'Nenhum.'}`);
    return true;
  }
  return false;
}

module.exports = { handleWebhook, registrarPedidoDespachado };
