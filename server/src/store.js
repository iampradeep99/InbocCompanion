import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Store {
  constructor(file, key) {
    if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('ENCRYPTION_KEY must be 64 hex characters. Run npm run setup.');
    this.file = file;
    this.key = Buffer.from(key, 'hex');
    this.data = { tokens: null, account: null, emails: {}, events: [], lastSync: null, errors: [] };
    if (existsSync(file)) {
      const { iv, tag, ciphertext } = JSON.parse(readFileSync(file, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      this.data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString());
    }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
