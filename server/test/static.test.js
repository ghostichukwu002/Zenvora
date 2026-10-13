import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveStaticPath } from '../src/static.js';

const root = resolve('/srv/zenvora-web');

test('the root path maps to index.html', () => {
  assert.equal(resolveStaticPath(root, '/'), resolve(root, 'index.html'));
});

test('ordinary asset paths resolve inside the web root', () => {
  assert.equal(resolveStaticPath(root, '/css/app.css'), resolve(root, 'css/app.css'));
});

test('parent-directory traversal is refused', () => {
  assert.equal(resolveStaticPath(root, '/../secret.txt'), null);
  assert.equal(resolveStaticPath(root, '/css/../../secret.txt'), null);
});

test('percent-encoded traversal is refused after decoding', () => {
  assert.equal(resolveStaticPath(root, '/%2e%2e/secret.txt'), null);
  assert.equal(resolveStaticPath(root, '/%2E%2E%2Fsecret.txt'), null);
});

test('a sibling folder that shares the root prefix is refused', () => {
  // "/srv/zenvora-web-evil" starts with the root string but is a different folder.
  assert.equal(resolveStaticPath(root, '/../zenvora-web-evil/x.js'), null);
});

test('null bytes and malformed encodings are refused', () => {
  assert.equal(resolveStaticPath(root, '/index.html%00.txt'), null);
  assert.equal(resolveStaticPath(root, '/%E0%A4%A'), null);
});
