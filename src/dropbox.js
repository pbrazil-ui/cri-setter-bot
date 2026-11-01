// Dropbox: the single source for listing documents and SOPs. Read files, make view-only links.
import { config } from './config.js';

const D = config.dropbox;
export const mockFs = { files: [], links: {} }; // DROPBOX_MODE=mock (tests): [{id, path_display, content_hash, size, buffer}]

let token = null; let tokenExp = 0; let pathRoot = null;

async function getToken() {
  if (token && Date.now() < tokenExp - 60e3) return token;
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: D.refreshToken, client_id: D.appKey, client_secret: D.appSecret }),
  });
  if (!res.ok) throw new Error(`Dropbox auth ${res.status}: ${await res.text()}`);
  const j = await res.json();
  token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

// Dropbox-API-Arg must be ASCII: escape anything else (filenames contain en dashes)
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function rpc(endpoint, body, { withRoot = true } = {}) {
  const headers = { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' };
  if (withRoot && pathRoot) headers['Dropbox-API-Path-Root'] = asciiJson({ '.tag': 'root', root: pathRoot });
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers, body: body === null ? null : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Dropbox ${endpoint} ${res.status}: ${text.slice(0, 300)}`); e.body = text; throw e; }
  return text ? JSON.parse(text) : null;
}

/** Team accounts: use the team root so "/Brokerage/..." paths resolve, including shared-folder mounts. */
async function ensureRoot() {
  if (pathRoot) return;
  const acct = await rpc('users/get_current_account', null, { withRoot: false });
  pathRoot = acct.root_info?.root_namespace_id || null;
}

/** Read-only: refresh token works, token is user-linked (not team-linked), team root resolves the listings folder. */
export async function dropboxCheck(listingsRoot) {
  if (D.mode !== 'live') return { mode: D.mode };
  const acct = await rpc('users/get_current_account', null, { withRoot: false });
  await ensureRoot();
  const folders = (await rpc('files/list_folder', { path: listingsRoot, recursive: false, include_mounted_folders: true })).entries.filter((e) => e['.tag'] === 'folder');
  return { ok: folders.length > 0, account: acct.email, root_namespace: pathRoot, listing_folders: folders.map((f) => f.name), problems: folders.length ? [] : [`no folders under ${listingsRoot}`] };
}

export async function listFolder(path, { recursive = true } = {}) {
  if (D.mode === 'mock') {
    const p = path.toLowerCase();
    return mockFs.files.filter((f) => f.path_display.toLowerCase().startsWith(p + '/'))
      .map((f) => ({ '.tag': 'file', id: f.id, name: f.path_display.split('/').pop(), path_display: f.path_display, content_hash: f.content_hash, size: f.size ?? f.buffer.length }))
      .concat(recursive ? [] : [...new Set(mockFs.files.map((f) => f.path_display).filter((x) => x.toLowerCase().startsWith(p + '/')).map((x) => x.slice(path.length + 1).split('/')[0]))]
        .filter((n) => !n.includes('.')).map((n) => ({ '.tag': 'folder', name: n, path_display: `${path}/${n}` })));
  }
  await ensureRoot();
  let page = await rpc('files/list_folder', { path, recursive, include_mounted_folders: true, limit: 2000 });
  const entries = [...page.entries];
  while (page.has_more) { page = await rpc('files/list_folder/continue', { cursor: page.cursor }); entries.push(...page.entries); }
  return entries;
}

export async function download(id) {
  if (D.mode === 'mock') { const f = mockFs.files.find((x) => x.id === id); if (!f) throw new Error('not found'); return f.buffer; }
  await ensureRoot();
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getToken()}`, 'Dropbox-API-Arg': asciiJson({ path: id }), ...(pathRoot ? { 'Dropbox-API-Path-Root': asciiJson({ '.tag': 'root', root: pathRoot }) } : {}) },
  });
  if (!res.ok) throw new Error(`Dropbox download ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * View-only link anyone can open. Returns { url, public } — public=false means team policy
 * restricted it (only CRI accounts can open it), so the caller should attach the file instead.
 */
export async function viewLink(id) {
  if (D.mode === 'mock') { const url = mockFs.links[id] ?? `https://www.dropbox.com/scl/fi/mock-${id}`; return { url, public: !String(url).includes('team-only') }; }
  await ensureRoot();
  const settings = { audience: { '.tag': 'public' }, access: { '.tag': 'viewer' }, allow_download: D.allowDownload };
  let meta;
  try {
    meta = await rpc('sharing/create_shared_link_with_settings', { path: id, settings });
  } catch (e) {
    if (!/shared_link_already_exists/.test(e.body || '')) throw e;
    const list = await rpc('sharing/list_shared_links', { path: id, direct_only: true });
    meta = list.links?.[0];
    if (!meta) throw e;
  }
  const lp = meta.link_permissions || {};
  const audience = lp.effective_audience?.['.tag'] || lp.resolved_visibility?.['.tag'];
  return { url: meta.url, public: audience === 'public' };
}
