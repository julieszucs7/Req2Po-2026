// Inlines src/core.js and src/samples.js into one self-contained page: dist/index.html
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
// Run the tests and put the real number on the page, so the count can never drift.
const { execFileSync } = require('child_process');
let testCount = null;
try {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'test/test.js')], { encoding: 'utf8' });
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (!m) throw new Error('could not read the test summary');
  if (Number(m[2]) > 0) throw new Error(m[2] + ' test(s) failing');
  testCount = m[1];
} catch (e) {
  console.error('BUILD STOPPED: ' + (e.message || e));
  process.exit(1);
}

let html = read('src/index.template.html');
html = html.replace('/*__CSS__*/', () => read('src/ui.css'));
html = html.replace('<!--__BODY__-->', () => read('src/ui.body.html').replace(/(<span id="testcount">)\d+(<\/span>)/, '$1' + testCount + '$2'));
html = html.replace('/*__UI__*/', () => safe(read('src/ui.js')));
html = html.replace('/*__CORE__*/', () => safe(read('src/core.js')));
html = html.replace('/*__SAMPLES__*/', () => safe(read('src/samples.js')));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/index.html'), html);
fs.copyFileSync(path.join(__dirname,'dist/index.html'), path.join(__dirname,'index.html'));
console.log('built dist/index.html (' + html.length + ' bytes, ' + testCount + ' tests passing)');
