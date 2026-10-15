import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env already exists; preserved your settings. Your API_TOKEN pairs the extension.');
} else {
  const token = randomBytes(32).toString('hex');
  const env = readFileSync('.env.example', 'utf8')
    .replace('API_TOKEN=\n', `API_TOKEN=${token}\n`)
    .replace('ENCRYPTION_KEY=\n', `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`);
  writeFileSync('.env', env, { mode: 0o600, flag: 'wx' });
  console.log('Created .env. Add your Google credentials and NVIDIA_API_KEY.');
  console.log(`Extension pairing token (API_TOKEN): ${token}`);
}
