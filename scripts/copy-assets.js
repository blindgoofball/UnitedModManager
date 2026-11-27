// Copies non-TypeScript assets (HTML, CSS) into dist/ after tsc runs.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['index.html', 'styles.css'];
const outDir = path.join(root, 'dist', 'renderer');
fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(root, 'src', 'renderer', f), path.join(outDir, f));
}
