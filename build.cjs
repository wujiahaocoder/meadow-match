const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
let html = fs.readFileSync(path.join(root, 'index.template.html'), 'utf8').replace(/\r\n/g, '\n');
for (const [tag, file] of [['STYLE','ui.css'],['ENGINE','engine.js'],['VAULT','vault.js'],['APP','app.js']]) {
  const source = fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g, '\n');
  if (/<\/script/i.test(source)) throw new Error('Unexpected script closing tag: '+file);
  html = html.replace('/*__'+tag+'__*/', () => source);
}
fs.writeFileSync(path.join(root,'index.html'), html);
console.log('Built offline index.html ('+Buffer.byteLength(html)+' bytes)');
