import { busyStates, originPattern } from './common.js';

const status = document.getElementById('status');
const source = document.getElementById('source');
const download = document.getElementById('download');
const permission = document.getElementById('permission');
const cancel = document.getElementById('cancel');
const progress = document.getElementById('progress');
let tabId;
let snapshot = { sources: [], job: null };

async function send(message) {
  const result = await chrome.runtime.sendMessage({ ...message, tabId });
  if (result?.error) throw new Error(result.error);
  return result;
}

function render(next) {
  snapshot = next;
  const previous = source.value;
  const choices = [{ url: 'auto', label: 'Automatic · MP4 first' }, ...(next.sources || [])];
  source.replaceChildren(...choices.map(item => {
    const option = document.createElement('option');
    option.value = item.url;
    option.textContent = item.label + (item.kind ? ' · ' + item.kind.toUpperCase() : '');
    return option;
  }));
  source.value = choices.some(item => item.url === previous) ? previous : 'auto';
  const busy = busyStates.has(next.job?.state);
  download.disabled = busy || !next.sources?.length;
  source.disabled = busy || !next.sources?.length;
  cancel.hidden = !busy;
  progress.hidden = !busy;
  if (Number.isFinite(next.job?.progress)) progress.value = Math.max(0, Math.min(100, next.job.progress));
  else progress.removeAttribute('value');
  permission.hidden = next.job?.state !== 'needs_permission';
  if (!permission.hidden) permission.textContent = 'Allow ' + new URL(next.job.missingOrigin).hostname;
  status.classList.toggle('error', next.job?.state === 'error');
  status.textContent = next.job?.message || (next.sources?.length
    ? 'Choose a player or download the preferred source.' : 'Open a supported video page and refresh it after installation.');
}

function showCurrentSite(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  const websites = [
    { id: 'pinaytg', domain: 'pinaytg.com', label: 'PinayTG' },
    { id: 'lootedpinay', domain: 'lootedpinay.com', label: 'LootedPinay' },
    { id: 'garpf', domain: 'garpf.com', label: 'Garpf player' },
  ];
  const current = websites.find(site => host === site.domain || host.endsWith('.' + site.domain));
  document.getElementById('current-site').textContent = current?.label || 'Current page';
  if (current) {
    const state = document.getElementById('site-' + current.id);
    state.textContent = 'Current';
    state.classList.add('active');
  }
}

download.addEventListener('click', async () => {
  download.disabled = true;
  try { render(await send({ type: 'START_DOWNLOAD', sourceUrl: source.value })); }
  catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
    download.disabled = false;
  }
});

permission.addEventListener('click', async () => {
  const origin = originPattern(snapshot.job.missingOrigin.replace(/\*$/, ''));
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) { status.textContent = 'Host access was declined.'; return; }
    permission.hidden = true;
    status.textContent = 'Host allowed. Click Download video to retry.';
  } catch (error) { status.textContent = error.message; }
});

cancel.addEventListener('click', async () => {
  try { render(await send({ type: 'CANCEL_DOWNLOAD', jobId: snapshot.job.id })); }
  catch (error) { status.textContent = error.message; }
});
document.getElementById('downloads').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://downloads/' });
});

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  showCurrentSite(tab?.url);
  render(await send({ type: 'GET_STATE' }));
} catch (error) { status.textContent = error.message; }

chrome.runtime.onMessage.addListener(message => {
  if (message?.target === 'popup' && message.type === 'STATE_UPDATE' && message.tabId === tabId) {
    send({ type: 'GET_STATE' }).then(render).catch(() => {});
  }
});
