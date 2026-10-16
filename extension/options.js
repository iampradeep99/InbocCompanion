import { api, settings } from './api.js';
const $ = selector => document.querySelector(selector);
const config = await settings();
$('#backend').value = config.backend;
$('#token').value = config.token;
$('#reminders').checked = config.reminders;
function result(message, success = false) {
  $('#result').textContent = message;
  $('#result').className = success ? 'saved' : 'warning';
}
async function status() {
  try {
    const data = await api('/api/dashboard');
    $('#google-status').textContent = data.connected ? `Connected as ${data.account}` : 'No Google account connected yet.';
    $('#disconnect').disabled = !data.connected;
    return data;
  } catch (error) { $('#google-status').textContent = error.message; throw error; }
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const url = new URL($('#backend').value);
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    const render = url.protocol === 'https:' && url.hostname.endsWith('.onrender.com') && !url.port;
    if ((!local && !render) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use http://127.0.0.1:3210 or your HTTPS backend address on onrender.com.');
    const token = $('#token').value.trim();
    if (token.length < 32) throw new Error('Paste the complete API_TOKEN from .env (at least 32 characters).');
    await chrome.storage.local.set({ backend: url.origin, token, reminders: $('#reminders').checked });
    await status();
    if (!profileLoaded) await loadProfile();
    result('Settings saved. Backend connected.', true);
    chrome.runtime.sendMessage({ type: 'refresh' });
  } catch (error) { result(error.message); }
  finally { button.disabled = false; }
});
let profileLoaded = false;
async function loadProfile() {
  const data = await api('/api/preferences');
  if (document.activeElement !== $('#job-profile') && !$('#job-profile').dataset.dirty) $('#job-profile').value = data.jobProfile;
  profileLoaded = true;
}
$('#job-profile').addEventListener('input', () => { $('#job-profile').dataset.dirty = 'true'; });
$('#job-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await api('/api/preferences', { method: 'PUT', body: JSON.stringify({ jobProfile: $('#job-profile').value }) });
    delete $('#job-profile').dataset.dirty;
    $('#profile-result').textContent = 'Profile saved. Recent emails will be rechecked with your preferences. Existing Gmail drafts are preserved.';
    $('#profile-result').className = 'saved';
    chrome.runtime.sendMessage({ type: 'refresh' });
  } catch (error) { $('#profile-result').textContent = error.message; $('#profile-result').className = 'warning'; }
  finally { button.disabled = false; }
});
$('#connect-google').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const { url } = await api('/api/auth/url', { method: 'POST' });
    await chrome.tabs.create({ url });
  } catch (error) { result(error.message); }
  finally { button.disabled = false; }
});
$('#disconnect').addEventListener('click', async event => {
  if (!window.confirm('Revoke Google access and clear the local inbox and calendar cache? Existing Gmail drafts will remain.')) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    await api('/api/disconnect', { method: 'POST' });
    await chrome.storage.local.remove('notified');
    $('#job-profile').value = ''; delete $('#job-profile').dataset.dirty;
    await status(); result('Google disconnected. Local data cleared.', true);
    chrome.runtime.sendMessage({ type: 'refresh' });
  } catch (error) { result(error.message); }
  finally { button.disabled = false; }
});
window.addEventListener('focus', () => status().catch(() => {}));
status().catch(() => {});
loadProfile().catch(() => {});
