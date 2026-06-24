// src/webhook/midia-admin.js
// Processa arquivos (imagem, PDF, planilha) mandados pelo Luiz humano no
// grupo Admin, pra dar autonomia ampla: ele consegue mandar uma foto, um
// PDF ou uma planilha e o admin processa o conteúdo de fato.

const XLSX = require('xlsx');

/**
 * Constrói o bloco de conteúdo multimodal pra mandar pra API da Anthropic,
 * a partir de uma mensagem de imagem do WhatsApp.
 *
 * @param {object} mensagem - objeto de mensagem completo do webhook
 * @param {string} textoComplementar - texto que o Luiz mandou junto (legenda ou pergunta)
 * @returns {Array|null} bloco de "content" pronto pra API, ou null se não for imagem
 */
function montarConteudoImagem(mensagem, textoComplementar) {
  const imageMsg = mensagem?.message?.imageMessage;
  if (!imageMsg) return null;

  // FIX: busca base64 primeiro no campo específico da imagem, depois nos genéricos —
  // evita pegar base64 de outra mídia que possa estar em mensagem.base64
  const base64Imagem = imageMsg?.base64 || mensagem?.message?.base64 || mensagem?.base64;
  if (!base64Imagem) return null;

  const mimetype = imageMsg?.mimetype || 'image/jpeg';

  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimetype,
        data: base64Imagem
      }
    },
    {
      type: 'text',
      text: textoComplementar || 'O Luiz humano mandou essa imagem no grupo Admin. Veja o que é e responda apropriadamente (pode ser comprovante, tabela de produtos, print de conversa, etc).'
    }
  ];
}

/**
 * Constrói o bloco de conteúdo multimodal a partir de um PDF mandado no Admin.
 *
 * @param {object} mensagem
 * @param {string} textoComplementar
 * @returns {Promise<Array|null>}
 */
async function montarConteudoPdf(mensagem, textoComplementar) {
  const docMsg = mensagem?.message?.documentMessage;
  if (!docMsg) return null;

  const mimetype = docMsg?.mimetype || '';
  const fileName = docMsg?.fileName || '';
  if (!mimetype.includes('pdf') && !fileName.toLowerCase().endsWith('.pdf')) return null;

  // FIX: busca base64 primeiro no campo específico do documento
  let base64Pdf = docMsg?.base64 || mensagem?.message?.base64 || mensagem?.base64;

  if (!base64Pdf && docMsg?.url) {
    base64Pdf = await baixarArquivoComoBase64(docMsg.url);
  }

  if (!base64Pdf) return null;

  return [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Pdf
      }
    },
    {
      type: 'text',
      text: textoComplementar || `O Luiz humano mandou esse PDF (${fileName}) no grupo Admin. Leia o conteúdo e responda apropriadamente.`
    }
  ];
}

/**
 * Processa uma planilha (.xlsx/.xls) mandada no Admin: extrai o conteúdo
 * como texto/tabela legível para a IA ler.
 *
 * @param {object} mensagem
 * @param {string} textoComplementar
 * @returns {Promise<string|null>}
 */
async function montarConteudoPlanilha(mensagem, textoComplementar) {
  const docMsg = mensagem?.message?.documentMessage;
  if (!docMsg) return null;

  const fileName = (docMsg?.fileName || '').toLowerCase();
  const mimetype = docMsg?.mimetype || '';
  const ehPlanilha = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') ||
    mimetype.includes('spreadsheet') || mimetype.includes('excel');
  if (!ehPlanilha) return null;

  // FIX: busca base64 primeiro no campo específico
  let base64Planilha = docMsg?.base64 || mensagem?.message?.base64 || mensagem?.base64;
  if (!base64Planilha && docMsg?.url) {
    base64Planilha = await baixarArquivoComoBase64(docMsg.url);
  }
  if (!base64Planilha) return null;

  try {
    const buffer = Buffer.from(base64Planilha, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const nomesAbas = workbook.SheetNames;

    let textoExtraido = `Planilha "${docMsg.fileName}" recebida no grupo Admin. Abas encontradas: ${nomesAbas.join(', ')}.\n\n`;

    const LIMITE_CHARS = 4000;

    for (const nomeAba of nomesAbas.slice(0, 5)) {
      const aba = workbook.Sheets[nomeAba];
      const csv = XLSX.utils.sheet_to_csv(aba);

      // FIX: trunca na última quebra de linha antes do limite,
      // evitando cortar no meio de uma linha CSV malformando os dados
      let csvLimitado = csv;
      if (csv.length > LIMITE_CHARS) {
        const truncado = csv.slice(0, LIMITE_CHARS);
        const ultimaLinha = truncado.lastIndexOf('\n');
        csvLimitado = (ultimaLinha > 0 ? truncado.slice(0, ultimaLinha) : truncado)
          + '\n[...conteúdo truncado, planilha muito grande...]';
      }

      textoExtraido += `--- Aba "${nomeAba}" ---\n${csvLimitado}\n\n`;
    }

    textoExtraido += textoComplementar
      ? `\nMensagem do Luiz humano sobre essa planilha: "${textoComplementar}"`
      : '\nO Luiz humano não escreveu nada além de mandar a planilha — pergunte o que ele quer fazer com ela, ou aja conforme o contexto da conversa.';

    return textoExtraido;
  } catch (err) {
    console.error('[MidiaAdmin] Erro ao processar planilha:', err.message);
    return `[Erro ao ler a planilha "${docMsg.fileName}": ${err.message}]`;
  }
}

/**
 * Baixa um arquivo de uma URL e retorna em base64.
 * FIX: timeout de 15s para não travar indefinidamente
 */
async function baixarArquivoComoBase64(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const resposta = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resposta.ok) {
      console.error('[MidiaAdmin] Erro ao baixar arquivo da URL:', resposta.status);
      return null;
    }
    const arrayBuffer = await resposta.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (err) {
    console.error('[MidiaAdmin] Erro ao baixar arquivo:', err.message);
    return null;
  }
}

module.exports = {
  montarConteudoImagem,
  montarConteudoPdf,
  montarConteudoPlanilha
};
