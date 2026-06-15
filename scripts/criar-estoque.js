// scripts/criar-estoque.js
// Rode uma vez para criar o arquivo Excel inicial
// Comando: node scripts/criar-estoque.js

const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

const filePath = path.resolve(__dirname, '../data/estoque.xlsx');

// Garante que a pasta data existe
fs.mkdirSync(path.dirname(filePath), { recursive: true });

const produtos = [
  // Exemplo de produtos — edite à vontade
  { id: 'P001', nome: 'Camiseta Básica P', preco: 49.90, estoque: 10, unidade: 'un' },
  { id: 'P002', nome: 'Camiseta Básica M', preco: 49.90, estoque: 8,  unidade: 'un' },
  { id: 'P003', nome: 'Camiseta Básica G', preco: 49.90, estoque: 5,  unidade: 'un' },
  { id: 'P004', nome: 'Calça Jeans 38',   preco: 129.90, estoque: 4,  unidade: 'un' },
  { id: 'P005', nome: 'Calça Jeans 40',   preco: 129.90, estoque: 6,  unidade: 'un' },
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(produtos, {
  header: ['id', 'nome', 'preco', 'estoque', 'unidade']
});

// Largura das colunas
ws['!cols'] = [
  { wch: 8  },  // id
  { wch: 30 },  // nome
  { wch: 12 },  // preco
  { wch: 10 },  // estoque
  { wch: 8  },  // unidade
];

XLSX.utils.book_append_sheet(wb, ws, 'Estoque');
XLSX.writeFile(wb, filePath);

console.log(`✅ Estoque criado em: ${filePath}`);
console.log(`   ${produtos.length} produtos cadastrados.`);
