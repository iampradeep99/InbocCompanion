import test from 'node:test';
import assert from 'node:assert/strict';
import { serverConfig } from '../src/config.js';

test('local startup retains loopback binding and OAuth callback', () => {
  assert.deepEqual(serverConfig({}), {
    port: 3210, host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'],
    redirectUri: 'http://127.0.0.1:3210/auth/google/callback'
  });
});

test('Render startup binds publicly on PORT and uses the external OAuth callback', () => {
  const config = serverConfig({ RENDER: 'true', PORT: '10000', RENDER_EXTERNAL_URL: 'https://inbox.onrender.com' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 10000);
  assert.equal(config.redirectUri, 'https://inbox.onrender.com/auth/google/callback');
  assert.deepEqual(config.allowedHosts, ['127.0.0.1', 'localhost', 'inbox.onrender.com']);
});

test('explicit settings override defaults and invalid settings fail early', () => {
  const config = serverConfig({ RENDER: 'true', HOST: '127.0.0.1', PUBLIC_URL: 'https://example.com',
    RENDER_EXTERNAL_URL: 'https://inbox.onrender.com', GOOGLE_REDIRECT_URI: 'https://example.com/callback' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.redirectUri, 'https://example.com/callback');
  assert.ok(config.allowedHosts.includes('example.com'));
  for (const PUBLIC_URL of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1']) {
    assert.throws(() => serverConfig({ PUBLIC_URL }));
  }
  assert.throws(() => serverConfig({ PORT: 'invalid' }));
});
