// src/stock/catalogo.js
// Catálogo de produtos editável via conversa no grupo Admin.
//
// CATALOGO_PADRAO é o valor inicial (os preços/produtos que já existiam
// fixos no código). O catálogo REAL em uso é persistido em disco e pode
// ser editado pelo Luiz humano através do agente administrativo, sem
// precisar de redeploy: ele pode substituir uma categoria inteira (texto
// novo) ou só marcar/desmarcar um item específico como em falta.
//
// Existem DOIS catálogos independentes, identificados pelo parâmetro
// `tipo`: 'normal' (preço de venda pro cliente final, padrão) e 'revenda'
// (preço diferenciado pra revendedor). Cada um é salvo em arquivo próprio
// no disco, mas usa toda a mesma lógica de edição/consulta.

const fs   = require('fs');
const path = require('path');

const CATALOGO_PADRAO = {
  durateston: `✅ *Durateston - Cooper Farmacêutica* 🇮🇳 ( Linha premium)
*250mg/ml. Cx com 10 AMPOLAS*
R$360

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Pharmacom* 🇪🇺 ( Linha premium)
*300mg/ml. Frasco 10ml*
R$330

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Bratva Labs* ✴️
*250mg/ml. Cx com 10 AMPOLA*
R$250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Lander Land Gold* 🥇
*250mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Muscle Labs* 🐍
*250mg/ml Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - King Pharma* 👑
*250mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Durateston - Swiss Pharma* 🧬
*250mg/ml. Frasco 10ml*
R$140`,

  enantato: `✅ *Enantato de Testosterona - Eminence* 🇮🇳 (Importada)
*250mg/ml. Cx com 10 AMPOLAS*
R$360

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Bratva Labs* ✴️
*250mg/ml. Cx com 10 AMPOLA*
R$250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Lander Land Gold* 🥇
*250mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Muscle Labs* 🐍
*250mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - King Pharma* 👑
*250mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Enantato - Swiss Pharma* 🧬
*250mg/ml. Frasco 10ml*
R$140`,

  masteron: `✅️ *Masteron Propionato - Cooper Pharma* 🇮🇳
*100mg/ml. Cx com 10 Ampolas*
R$450

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Lander Land Gold* 🥇
*100mg/ml. Frasco 10ml*
R$220

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Bratva Labs* ✴️
*100mg/ml. Frasco 10ml*
R$200

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Propionato - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$140

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Enantato - King Pharma* 👑
*100mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Masteron Enantato - Swiss Pharma* 🧬
*200mg/ml. Frasco 10ml*
R$160`,

  primobolan: `✅️ *Primobolan - Muscle Labs* 🐍
*100mg/ml. Frasco 10ml*
R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Primobolan - King Pharma* 👑
*100mg/ml. Frasco 10ml*
R$320

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Primobolan - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$230`,

  deca: `✅ *Deca - Pharmacom* 🇪🇺 (Linha premium)
*300mg/ml. Cx com 10 AMPOLAS*
R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Deca - Oxygen* 🇰🇼 (Importada)
*250mg/ml. Cx com 10 AMPOLAS*
R$270

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - Lander Land Gold* 🥇
*200mg/ml. Frasco 10ml*
R$210

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Deca - Muscle Labs* 🐍
*300mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - King Pharma* 👑
*300mg/ml. Frasco 10ml*
R$180

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Deca - Swiss Pharma* 🧬
*300mg/ml. Frasco 10ml*
R$140`,

  trembolona: `✅️ *Trembolona Acetato - Lander Land Gold* 🥇
*100mg/ml. Frasco 10ml*
R$230

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Trembolona Acetato - Muscle Labs* 🐍
*100mg/ml. Frasco 10ml*
R$190

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Trembolona Acetato - Swiss Pharma* 🧬
*100mg/ml. Frasco 10ml*
R$140

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

☑️ *Trembolona Enantato - Lander Land Gold* 🥇
*200mg/ml. Frasco 10ml*
R$220

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

☑️ *Trembolona Enantato - Swiss Pharma* 🧬
*200mg/ml. Frasco 10ml*
R$150`,

  oxandrolona: `✅️ *Oxandrolona - Lander Land*
*10mg/cps. Frasco 50 comprimidos*
R$240

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona - Lander Land*
*5mg/cps. Frasco 100 comprimidos*
R$240

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona Manipulada* 🧬
*20mg/cps. Frasco 100 comprimidos*
R$200

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Oxandrolona Manipulada* 🧬
*10mg/cps. Frasco 100 comprimidos*
R$150`,

  peptideos: `✅ *Peptídeos - GEN HEATH* 🧬 (Importado)

📍GHK-cu 100mg — R$850
📍Most-C 10mg — R$750
📍Ipamorelin 10mg — R$750
📍HGH Frag 176-191 5mg — R$750
📍BPC 157 10mg — R$750

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Peptídeos - ZPHC* 🧬 (Importado)

Ipamorelin 5mg — R$370
TB500 5mg — R$370

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *NEO Peptídeos* 🧬 (Importado)

GHK-CU 100mg — R$650

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Better Performance* 🧬 (Nacional)

Tesamorelin 5mg — R$180
TB 500 5mg — R$180
GHRp6 5mg — R$180
Slupp 332 5mg — R$180`,

  gh: `💎 *GH Somatropina (Biomanguinhos)*
*Caixa com 4ui* — R$60
🚨 (Valor para pedidos acima de 10 cxs)

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

💎 *GH Genotropin caneta 36ui*
R$1.250`,

  emagrecedores: `✅ *Retatrutida - ZPHC*
Cx fechada 120mg (5 frascos 24mg c/ diluente) — R$4.300
Frasco 24mg c/ diluente — R$920

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅ *Retatrutida - Oxygen*
Frasco 40mg c/ diluente — R$1.450

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *LIPOLESS (Tirzepatida)*
Cx fechada 60mg — R$1.200
Frasco 15mg — R$350

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

✅️ *Ozempic caneta 1mg* — R$1.250

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

🔥 *Clembuterol - Lander Land Gold*
Caixa 50 comprimidos 0.04mg — R$150

🟰🟰🟰🟰🟰🟰🟰🟰🟰🟰

🔥 *Lipostabil*
5 ampolas 5ml cada — R$140`
};


function getCatalogoFilePath(tipo = 'normal') {
  if (tipo === 'revenda') {
    return path.resolve(process.env.CATALOGO_REVENDA_FILE_PATH || './data/catalogo-revenda.json');
  }
  return path.resolve(process.env.CATALOGO_FILE_PATH || './data/catalogo.json');
}

// Carrega o catálogo persistido do disco. Se não existir ainda, usa o
// CATALOGO_PADRAO como ponto de partida (primeira vez rodando) — pro
// catálogo de revenda, começa vazio em vez do padrão, já que não existe
// um "padrão de revenda" predefinido (o Luiz cadastra do zero).
function carregarCatalogo(tipo = 'normal') {
  try {
    const arquivo = getCatalogoFilePath(tipo);
    if (fs.existsSync(arquivo)) {
      const raw = fs.readFileSync(arquivo, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[Catalogo] Erro ao carregar catálogo (${tipo}) do disco, usando padrão:`, err.message);
  }
  return tipo === 'revenda' ? {} : { ...CATALOGO_PADRAO };
}

function salvarCatalogo(catalogo, tipo = 'normal') {
  try {
    const arquivo = getCatalogoFilePath(tipo);
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(catalogo, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[Catalogo] Erro ao salvar catálogo (${tipo}) no disco:`, err.message);
    return false;
  }
}

let _catalogoEmMemoria = carregarCatalogo('normal');
let _catalogoRevendaEmMemoria = carregarCatalogo('revenda');

function getCatalogoAtivo(tipo) {
  return tipo === 'revenda' ? _catalogoRevendaEmMemoria : _catalogoEmMemoria;
}

function setCatalogoAtivo(novoCatalogo, tipo) {
  if (tipo === 'revenda') {
    _catalogoRevendaEmMemoria = novoCatalogo;
  } else {
    _catalogoEmMemoria = novoCatalogo;
  }
}

// Retorna o texto pronto de uma categoria (ou null se não existir)
function getCategoria(categoria, tipo = 'normal') {
  const chave = String(categoria).toLowerCase().trim();
  return getCatalogoAtivo(tipo)[chave] || null;
}

// Lista todas as categorias disponíveis
function listarCategorias(tipo = 'normal') {
  return Object.keys(getCatalogoAtivo(tipo));
}

// Substitui o texto completo de uma categoria (ex: o Luiz humano manda
// uma tabela nova pronta) — cria a categoria se ela não existir ainda.
function definirCategoria(categoria, textoNovo, tipo = 'normal') {
  const chave = String(categoria).toLowerCase().trim();
  const catalogo = getCatalogoAtivo(tipo);
  catalogo[chave] = textoNovo;
  setCatalogoAtivo(catalogo, tipo);
  salvarCatalogo(catalogo, tipo);
  return { ok: true, categoria: chave, tipo };
}

// Marca um item específico (uma linha/marca dentro de uma categoria)
// como em falta ou disponível de novo, inserindo/removendo uma marcação
// visual "❌ EM FALTA" perto do nome do item dentro do texto da categoria.
// Busca por um trecho do nome do item (ex: "Swiss Pharma", "Cooper").
function marcarItemFalta(categoria, trechoNomeItem, emFalta = true, tipo = 'normal') {
  const chave = String(categoria).toLowerCase().trim();
  const catalogo = getCatalogoAtivo(tipo);
  const textoAtual = catalogo[chave];
  if (!textoAtual) {
    return { ok: false, erro: `Categoria "${categoria}" não encontrada no catálogo${tipo === 'revenda' ? ' de revenda' : ''}.` };
  }

  const linhas = textoAtual.split('\n');
  let linhasEncontradas = 0;

  const linhasAtualizadas = linhas.map(linha => {
    const linhaSemMarcacao = linha.replace(/\s*❌\s*EM FALTA\s*$/i, '').trim();
    const contemTrecho = linha.toLowerCase().includes(String(trechoNomeItem).toLowerCase());

    if (contemTrecho) {
      linhasEncontradas++;
      return emFalta ? `${linhaSemMarcacao} ❌ EM FALTA` : linhaSemMarcacao;
    }
    return linha;
  });

  if (linhasEncontradas === 0) {
    return { ok: false, erro: `Não encontrei "${trechoNomeItem}" na categoria "${categoria}". Confira o nome exato como aparece no catálogo.` };
  }

  if (linhasEncontradas > 1) {
    return { ok: false, erro: `"${trechoNomeItem}" encontrado em ${linhasEncontradas} linhas diferentes na categoria "${categoria}" — é ambíguo. Seja mais específico (ex: inclua o tipo do produto junto com a marca, como "Propionato Swiss" em vez de só "Swiss").`, ambiguo: true };
  }

  catalogo[chave] = linhasAtualizadas.join('\n');
  setCatalogoAtivo(catalogo, tipo);
  salvarCatalogo(catalogo, tipo);
  return { ok: true, categoria: chave, item: trechoNomeItem, emFalta, tipo };
}

// Restaura o catálogo de uma categoria (ou de tudo) para o padrão original.
// Só se aplica ao catálogo normal — o de revenda não tem padrão de fábrica.
function restaurarPadrao(categoria = null) {
  if (categoria) {
    const chave = String(categoria).toLowerCase().trim();
    if (!CATALOGO_PADRAO[chave]) return { ok: false, erro: `Categoria "${categoria}" não existe no padrão original.` };
    _catalogoEmMemoria[chave] = CATALOGO_PADRAO[chave];
  } else {
    _catalogoEmMemoria = { ...CATALOGO_PADRAO };
  }
  salvarCatalogo(_catalogoEmMemoria, 'normal');
  return { ok: true };
}

module.exports = {
  getCategoria,
  listarCategorias,
  definirCategoria,
  marcarItemFalta,
  restaurarPadrao
};
