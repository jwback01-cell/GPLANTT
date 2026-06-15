// patch script
const fs = require('fs');
const p = 'c:\\Users\\jwbac\\Desktop\\새 폴더\\index.html';
let s = fs.readFileSync(p, 'utf8');
const bad = `      // 줄바꿈/탭/이중공백 제거 — 이카운트가\n 같은 escape 그대로 보존하지 않도록\n      const _flat = (str) => String(str || '').replace(/[\\r\\n\\t\n]+/g, ' ').replace(/\\s{2,}/g, ' ').trim();\n      const remarkBase = _flat(\`반품(\${r.action || ''})\`);\n      const remark = _flat(\`\${remarkBase} \${custName} \${_flat(r.detail).slice(0, 60)}\`).slice(0, 100);`;
const good = `      // 줄바꿈/탭/이중공백 제거 — 이카운트가 \\u000A 같은 escape 로 보존하지 않도록\n      const _flat = (str) => String(str || '').replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s{2,}/g, ' ').trim();\n      const remarkBase = _flat(\`반품(\${r.action || ''})\`);\n      const remark = _flat(\`\${remarkBase} \${custName} \${_flat(r.detail).slice(0, 60)}\`).slice(0, 100);`;
if (s.indexOf(bad) === -1) { console.error('PATTERN NOT FOUND'); process.exit(1); }
s = s.replace(bad, good);
fs.writeFileSync(p, s);
console.log('PATCHED');
