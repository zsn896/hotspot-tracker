'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=|application\/json/i.test(m[1])).map(m => m[2]);
}

async function expand(html) {
  let output;
  const context = {
    Date, console,
    fetch: async url => ({ ok: true, text: async () => {
      const name = String(url).split('?')[0].replace(/^\//, '');
      if (!['index-core.html', 'index-base.html'].includes(name)) throw new Error(`Unexpected shell request: ${name}`);
      return fs.readFileSync(path.join(root, name), 'utf8');
    }}),
    document: { open() {}, write(value) { output = value; }, close() {},
      getElementById() { return { set textContent(value) { throw new Error(value); } }; } }
  };
  await vm.runInNewContext(inlineScripts(html)[0], context, { timeout: 3000 });
  if (!output) throw new Error('Shell failed to produce a document');
  return output;
}

async function expandedDocument() {
  const shell = fs.readFileSync(path.join(root, 'index-shell.html'), 'utf8');
  return expand(await expand(shell));
}

module.exports = { inlineScripts, expandedDocument };
