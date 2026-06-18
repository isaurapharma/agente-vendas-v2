// src/webhook/transcricao.js
// Transcreve mensagens de áudio do WhatsApp usando a API Whisper da OpenAI

/**
 * Transcreve áudio a partir de base64 (formato ogg/opus do WhatsApp)
 * @param {string} base64Audio - áudio em base64 (sem prefixo data:)
 * @param {string} mimetype - tipo do áudio (ex: 'audio/ogg; codecs=opus')
 * @returns {Promise<string>} texto transcrito
 */
async function transcreverAudioBase64(base64Audio, mimetype = 'audio/ogg') {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  console.log('[Transcricao] Iniciando transcrição. Chave configurada?', !!OPENAI_KEY, '| Tamanho do base64:', base64Audio?.length);

  if (!OPENAI_KEY) {
    console.error('[Transcricao] OPENAI_API_KEY não configurada.');
    return null;
  }

  try {
    const buffer = Buffer.from(base64Audio, 'base64');
    const extensao = mimetype.includes('ogg') ? 'ogg' : 'mp3';

    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: mimetype }), `audio.${extensao}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'pt');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: formData
    });

    if (!res.ok) {
      const erro = await res.text();
      console.error('[Transcricao] Erro Whisper:', res.status, erro);

      if (res.status === 429 || /quota|billing|insufficient/i.test(erro)) {
        try {
          const ntfyTopic = process.env.NTFY_TOPIC;
          if (ntfyTopic) {
            await fetch(`https://ntfy.sh/${ntfyTopic}`, {
              method: 'POST',
              headers: { 'Title': 'Creditos da OpenAI esgotados', 'Priority': 'urgent', 'Tags': 'warning' },
              body: 'O agente nao consegue mais transcrever audios. Acessa platform.openai.com e recarrega os creditos.'
            });
          }
        } catch (_) {}
      }

      return null;
    }

    const data = await res.json();
    console.log('[Transcricao] Whisper respondeu com sucesso:', data.text);
    return data.text?.trim() || null;

  } catch (err) {
    console.error('[Transcricao] Erro ao transcrever:', err);
    return null;
  }
}

/**
 * Transcreve áudio a partir de uma URL (quando Evolution API manda link em vez de base64)
 * @param {string} url - URL do arquivo de áudio
 * @returns {Promise<string>} texto transcrito
 */
async function transcreverAudioUrl(url) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    console.error('[Transcricao] OPENAI_API_KEY não configurada.');
    return null;
  }

  try {
    const resAudio = await fetch(url);
    if (!resAudio.ok) {
      console.error('[Transcricao] Erro ao baixar áudio da URL:', resAudio.status);
      return null;
    }
    const arrayBuffer = await resAudio.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');

    return await transcreverAudioBase64(base64, 'audio/ogg');

  } catch (err) {
    console.error('[Transcricao] Erro ao processar URL de áudio:', err);
    return null;
  }
}

module.exports = { transcreverAudioBase64, transcreverAudioUrl };
