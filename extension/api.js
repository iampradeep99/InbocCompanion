export async function settings() {
  return chrome.storage.local.get({ backend: 'http://127.0.0.1:3210', token: '', reminders: true });
}

export async function api(path, options = {}) {
  const config = await settings();
  if (!config.token) throw new Error('Open Settings and paste your backend pairing token.');
  const controller = new AbortController();
  const { timeoutMs = 15000, signal: externalSignal, ...requestOptions } = options;
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(`${config.backend}${path}`, {
      ...requestOptions, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Backend returned ${response.status}.`);
    return data;
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    if (error.name === 'AbortError' && timeoutMs > 15000) throw new Error('AI is taking too long. Your event fields are unchanged; please try again.');
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('Backend unavailable. Run npm start and check the address in Settings.');
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
