// Loads a *.snippet.html file's <script> block in a sandboxed VM with DOM stubs
// so the pure-logic namespace (window.FVKickoff / window.FVInvoiceQB) can be
// unit-tested in node without a browser.
'use strict';
const fs = require('fs');
const vm = require('vm');

function loadSnippet(path) {
  const html = fs.readFileSync(path, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) throw new Error('No <script> block found in ' + path);
  const code = blocks[blocks.length - 1][1];

  const elStub = () => ({
    style: {}, innerHTML: '', textContent: '', value: '',
    setAttribute() {}, appendChild() {}, addEventListener() {}
  });
  const sandbox = {
    window: {},
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: () => null,
      createElement: elStub,
      head: { appendChild() {} },
      body: { appendChild() {} }
    },
    location: { origin: 'https://fortivopropertyservices.sharepoint.com' },
    navigator: {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    console,
    URL: { createObjectURL: () => 'blob:test' },
    Blob: function () {},
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    alert() {}, prompt: () => null, setTimeout: (fn) => fn && undefined
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path });
  return sandbox.window;
}

module.exports = { loadSnippet };
