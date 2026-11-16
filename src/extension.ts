import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';

const EXT_ID = 'endoflife-ai';
// The settings and commands package.json declares (endoflifeAi.*). Until 1.0.1 the code read
// settings and registered commands under EXT_ID (endoflife-ai.*), so a key or warningDays set in
// the Settings screen was never read and both palette commands were missing. The old spelling is
// still read for the key, because the 1.0.0 README told people to use it.
const CONFIG_NS = 'endoflifeAi';
const API_BASE = 'https://api.endoflife.ai/v1';
const FREE_KEY_URL = 'https://endoflife.ai/api#free-key';
const PLANS_URL = 'https://endoflife.ai/api#get-key';
// Since 2026-11-16 the API refuses data requests without a key (HTTP 401). Each pin that was not
// checked says so in a diagnostic and the status bar shows it; the toasts appear once per session.
let keyRequiredShown = false;
let limitShown = false;
// What the API last said about the key. The status bar shows it.
let apiState: 'ok' | 'key' | 'limit' = 'ok';
// Raised when the settings change or a scan is asked for, so that a lookup still in flight with
// the old key cannot overwrite the newer result.
let generation = 0;
let statusBar: vscode.StatusBarItem | undefined;

// ─── Cache ────────────────────────────────────────────────────────────────────
// Avoid hammering the API — cache answers for 1 hour per slug+version

// The outcome of one lookup. Only 'ok' carries a status; none of the others may look like
// "supported", so each one gets its own diagnostic on the pin.
type Lookup =
  | { kind: 'ok'; status: EolStatus }
  | { kind: 'untracked' }                 // 404: product or version not tracked
  | { kind: 'key'; keyStatus?: string }   // no key set, or 401 (X-EOL-Key-Status: unknown | inactive)
  | { kind: 'limit' }                     // 429: the key's daily limit was reached
  | { kind: 'failed' };                   // network error or an unexpected answer

interface CacheEntry {
  data: Lookup;
  ts: number;
}

interface EolStatus {
  is_eol: boolean;
  is_supported: boolean;
  eol_approaching: boolean;
  eol_date: string | null;
  days_until_eol: number | null;
  days_past_eol: number | null;
  latest_release: string | null;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function fetchJson(url: string, apiKey: string): Promise<Lookup> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      'User-Agent': 'vscode-eol-check/1.0',
      'X-API-Key': apiKey,
    };

    https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 404) resolve({ kind: 'untracked' });
        else if (res.statusCode === 401) resolve({ kind: 'key', keyStatus: String(res.headers['x-eol-key-status'] || '') });
        else if (res.statusCode === 429) resolve({ kind: 'limit' });
        else resolve({ kind: 'failed' });
        return;
      }
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try { resolve({ kind: 'ok', status: JSON.parse(data) }); }
        catch { resolve({ kind: 'failed' }); }
      });
    }).on('error', () => resolve({ kind: 'failed' }));
  });
}

async function getStatus(slug: string, version: string, apiKey: string): Promise<Lookup> {
  // Without a key the API answers 401, so do not ask.
  if (!apiKey) return { kind: 'key' };

  const key = `${slug}:${version}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const gen = generation;
  const url = `${API_BASE}/status/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
  const data = await fetchJson(url, apiKey);
  if (gen !== generation) return data; // the settings changed while this was in flight

  if (data.kind === 'key' || data.kind === 'limit') apiState = data.kind;
  else if (data.kind !== 'failed') apiState = 'ok';
  // Cache answers only. A refused key, a reached limit or a network error is asked again on the
  // next scan, so a new key takes effect at once.
  if (data.kind === 'ok' || data.kind === 'untracked') cache.set(key, { data, ts: Date.now() });
  return data;
}

function getApiKey(): string {
  return (vscode.workspace.getConfiguration(CONFIG_NS).get<string>('apiKey', '')
    || vscode.workspace.getConfiguration(EXT_ID).get<string>('apiKey', '')).trim();
}

function openKeySetting(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_NS}.apiKey`);
}

// ─── Status bar and toasts ────────────────────────────────────────────────────

function updateStatusBar(): void {
  if (!statusBar) return;
  let text = 'EOL: on';
  let tooltip = 'EOL Check is checking version pins against endoflife.ai.';
  let warn = false;
  if (!vscode.workspace.getConfiguration(CONFIG_NS).get<boolean>('enabled', true)) {
    text = 'EOL: off';
    tooltip = 'EOL Check is turned off (endoflifeAi.enabled).';
  } else if (!getApiKey()) {
    text = 'EOL: key needed';
    tooltip = 'EOL Check is not checking version pins. The endoflife.ai API needs a key and none is set. A free key gives 150 requests a day and does not expire.';
    warn = true;
  } else if (apiState === 'key') {
    text = 'EOL: key needed';
    tooltip = 'EOL Check is not checking version pins. The endoflife.ai API refused the key in endoflifeAi.apiKey. A free key gives 150 requests a day and does not expire.';
    warn = true;
  } else if (apiState === 'limit') {
    text = 'EOL: limit reached';
    tooltip = 'EOL Check is not checking version pins. The daily request limit of your endoflife.ai API key was reached. The count resets at 00:00 UTC.';
    warn = true;
  }
  statusBar.text = text;
  statusBar.tooltip = `${tooltip} Click to open the setting.`;
  statusBar.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

function showKeyNeeded(refused: boolean): void {
  if (keyRequiredShown) return;
  keyRequiredShown = true;
  vscode.window.showWarningMessage(
    refused
      ? 'EOL Check is not checking version pins. The endoflife.ai API refused the key in endoflifeAi.apiKey. A free key gives 150 requests a day and does not expire.'
      : 'EOL Check is not checking version pins. The endoflife.ai API needs a key. A free key gives 150 requests a day and does not expire. Set it in endoflifeAi.apiKey.',
    'Open Setting', 'Get Free Key'
  ).then(choice => {
    if (choice === 'Open Setting') openKeySetting();
    if (choice === 'Get Free Key') vscode.env.openExternal(vscode.Uri.parse(FREE_KEY_URL));
  });
}

function showLimitReached(): void {
  if (limitShown) return;
  limitShown = true;
  vscode.window.showWarningMessage(
    'EOL Check is not checking version pins. The daily request limit of your endoflife.ai API key was reached. The count resets at 00:00 UTC.',
    'See Plans'
  ).then(choice => {
    if (choice === 'See Plans') vscode.env.openExternal(vscode.Uri.parse(PLANS_URL));
  });
}

// ─── Version detectors ────────────────────────────────────────────────────────

interface Detection {
  slug: string;
  version: string;
  line: number;   // 0-based line number
  col: number;    // 0-based column of the version string
  len: number;    // length of the version string
}

function detectNvmrc(text: string): Detection[] {
  const raw = text.trim().replace(/^v/, '');
  const major = raw.split('.')[0];
  if (major && !isNaN(Number(major))) {
    const col = text.indexOf(raw.split('.')[0]);
    return [{ slug: 'nodejs', version: major, line: 0, col: Math.max(0, col), len: raw.length }];
  }
  return [];
}

function detectPythonVersion(text: string): Detection[] {
  const raw = text.trim();
  const parts = raw.split('.');
  if (parts.length >= 2) {
    const version = `${parts[0]}.${parts[1]}`;
    return [{ slug: 'python', version, line: 0, col: 0, len: raw.length }];
  }
  return [];
}

function detectRubyVersion(text: string): Detection[] {
  const raw = text.trim().replace(/^ruby-/, '');
  const parts = raw.split('.');
  if (parts.length >= 2) {
    const version = `${parts[0]}.${parts[1]}`;
    return [{ slug: 'ruby', version, line: 0, col: 0, len: raw.length }];
  }
  return [];
}

function detectPackageJson(text: string): Detection[] {
  const results: Detection[] = [];
  try {
    const pkg = JSON.parse(text);
    if (pkg.engines?.node) {
      const match = pkg.engines.node.match(/(\d+)/);
      if (match) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('"node"')) {
            const col = lines[i].indexOf(pkg.engines.node);
            results.push({ slug: 'nodejs', version: match[1], line: i, col: Math.max(0, col), len: pkg.engines.node.length });
            break;
          }
        }
      }
    }
  } catch { /* skip */ }
  return results;
}

function detectDockerfile(text: string): Detection[] {
  const results: Detection[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/^FROM\s+(\S+)/i);
    if (!fromMatch) continue;
    const img = fromMatch[1].toLowerCase();
    const nodeMatch  = img.match(/^node:(\d+)/);
    const pythonMatch = img.match(/^python:(\d+\.\d+)/);
    const phpMatch   = img.match(/^php:(\d+\.\d+)/);
    const rubyMatch  = img.match(/^ruby:(\d+\.\d+)/);

    const addResult = (slug: string, version: string) => {
      const col = line.toLowerCase().indexOf(version);
      results.push({ slug, version, line: i, col: Math.max(0, col), len: version.length });
    };

    if (nodeMatch)   addResult('nodejs',  nodeMatch[1]);
    if (pythonMatch) addResult('python',  pythonMatch[1]);
    if (phpMatch)    addResult('php',     phpMatch[1]);
    if (rubyMatch)   addResult('ruby',    rubyMatch[1]);
  }
  return results;
}

function detectGoMod(text: string): Detection[] {
  const match = text.match(/^go\s+(\d+\.\d+)/m);
  if (match) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^go\s+(\d+\.\d+)/);
      if (m) {
        const col = lines[i].indexOf(m[1]);
        return [{ slug: 'go', version: m[1], line: i, col, len: m[1].length }];
      }
    }
  }
  return [];
}

function detectComposerJson(text: string): Detection[] {
  try {
    const composer = JSON.parse(text);
    const phpVer = composer?.require?.php;
    if (phpVer) {
      const match = phpVer.match(/(\d+\.\d+)/);
      if (match) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('"php"')) {
            const col = lines[i].indexOf(phpVer);
            return [{ slug: 'php', version: match[1], line: i, col: Math.max(0, col), len: phpVer.length }];
          }
        }
      }
    }
  } catch { /* skip */ }
  return [];
}

function detectToolVersions(text: string): Detection[] {
  const results: Detection[] = [];
  const slugMap: Record<string, string> = { nodejs: 'nodejs', node: 'nodejs', python: 'python', ruby: 'ruby', golang: 'go', go: 'go' };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [tool, ver] = parts;
    const slug = slugMap[tool.toLowerCase()];
    if (!slug || !ver) continue;
    const verParts = ver.split('.');
    const version = slug === 'nodejs' ? verParts[0] : `${verParts[0]}.${verParts[1]}`;
    const col = lines[i].indexOf(ver);
    results.push({ slug, version, line: i, col, len: ver.length });
  }
  return results;
}

function getDetections(fileName: string, text: string): Detection[] {
  const base = path.basename(fileName);
  if (base === '.nvmrc' || base === '.node-version') return detectNvmrc(text);
  if (base === '.python-version') return detectPythonVersion(text);
  if (base === '.ruby-version') return detectRubyVersion(text);
  if (base === 'package.json') return detectPackageJson(text);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return detectDockerfile(text);
  if (base === 'go.mod') return detectGoMod(text);
  if (base === 'composer.json') return detectComposerJson(text);
  if (base === '.tool-versions') return detectToolVersions(text);
  return [];
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

const DIAG_SOURCE = 'endoflife.ai';

async function checkDocument(
  doc: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_NS);
  if (!config.get<boolean>('enabled', true)) {
    diagCollection.delete(doc.uri);
    return;
  }

  const apiKey = getApiKey();
  const warningDays = config.get<number>('warningDays', 90);

  const text = doc.getText();
  const fileName = doc.fileName;
  const detections = getDetections(fileName, text);

  if (detections.length === 0) {
    diagCollection.set(doc.uri, []);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];
  const gen = generation;

  for (const d of detections) {
    const lookup = await getStatus(d.slug, d.version, apiKey);
    if (gen !== generation) return; // a newer scan has started

    const range = new vscode.Range(
      new vscode.Position(d.line, d.col),
      new vscode.Position(d.line, d.col + d.len)
    );

    if (lookup.kind !== 'ok') {
      // Nothing was checked: say so on the pin, so the file never looks clean.
      diagnostics.push(notCheckedDiagnostic(range, d, lookup, apiKey));
      if (lookup.kind === 'key') showKeyNeeded(!!apiKey);
      if (lookup.kind === 'limit') showLimitReached();
      continue;
    }

    const status = lookup.status;
    const scoreUrl = `https://endoflife.ai/score/${d.slug}/${d.version}`;

    if (status.is_eol) {
      const days = status.days_past_eol;
      const msg = `${d.slug} ${d.version} is EOL${status.eol_date ? ` since ${status.eol_date}` : ''}${days ? ` (${days} days past EOL)` : ''}. No security patches. → ${scoreUrl}`;
      const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
      diag.source = DIAG_SOURCE;
      diag.code = { value: 'eol', target: vscode.Uri.parse(scoreUrl) };
      diagnostics.push(diag);
    } else if (status.eol_approaching && status.days_until_eol !== null && status.days_until_eol <= warningDays) {
      const msg = `${d.slug} ${d.version} reaches EOL in ${status.days_until_eol} days${status.eol_date ? ` (${status.eol_date})` : ''}. Plan your upgrade. → ${scoreUrl}`;
      const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
      diag.source = DIAG_SOURCE;
      diag.code = { value: 'eol-approaching', target: vscode.Uri.parse(scoreUrl) };
      diagnostics.push(diag);
    }
  }

  diagCollection.set(doc.uri, diagnostics);
  updateStatusBar();
}

// An Information diagnostic for a pin that could not be checked. Never a warning or an error:
// nothing is known about the version.
function notCheckedDiagnostic(range: vscode.Range, d: Detection, lookup: Lookup, apiKey: string): vscode.Diagnostic {
  let why = 'No answer from the endoflife.ai API. The next save or scan tries again.';
  let code: vscode.Diagnostic['code'] = 'not-checked';
  if (lookup.kind === 'untracked') {
    why = 'endoflife.ai does not track this product or version.';
    code = 'not-tracked';
  } else if (lookup.kind === 'key') {
    const reason = lookup.keyStatus === 'inactive' ? ' (no longer active)' : lookup.keyStatus === 'unknown' ? ' (not recognised)' : '';
    why = apiKey
      ? `The endoflife.ai API refused the key in endoflifeAi.apiKey${reason}. Check the key, or get a free one (150 requests a day, no expiry) at ${FREE_KEY_URL}`
      : `The endoflife.ai API needs a key and none is set. Get a free key (150 requests a day, no expiry) at ${FREE_KEY_URL} and set endoflifeAi.apiKey.`;
    code = { value: 'key-needed', target: vscode.Uri.parse(FREE_KEY_URL) };
  } else if (lookup.kind === 'limit') {
    why = `The daily request limit of your endoflife.ai API key was reached. The count resets at 00:00 UTC. Higher limits: ${PLANS_URL}`;
    code = { value: 'limit-reached', target: vscode.Uri.parse(PLANS_URL) };
  }
  const diag = new vscode.Diagnostic(range, `${d.slug} ${d.version} was not checked. ${why}`, vscode.DiagnosticSeverity.Information);
  diag.source = DIAG_SOURCE;
  diag.code = code;
  return diag;
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const diagCollection = vscode.languages.createDiagnosticCollection(EXT_ID);
  context.subscriptions.push(diagCollection);

  // Check on open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => checkDocument(doc, diagCollection))
  );

  // Check on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => checkDocument(doc, diagCollection))
  );

  // Status bar: shows whether pins are being checked; a click opens the key setting
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = { title: 'Open setting', command: 'workbench.action.openSettings', arguments: [`${CONFIG_NS}.apiKey`] };
  context.subscriptions.push(statusBar);
  updateStatusBar();
  statusBar.show();

  const scanOpenDocuments = () => {
    generation++;
    vscode.workspace.textDocuments.forEach(doc => checkDocument(doc, diagCollection));
    updateStatusBar();
  };

  // Check all open docs on startup
  scanOpenDocuments();

  // Re-scan when a setting changes, so a new key takes effect at once
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      const keyChanged = e.affectsConfiguration(`${CONFIG_NS}.apiKey`) || e.affectsConfiguration(`${EXT_ID}.apiKey`);
      if (!keyChanged && !e.affectsConfiguration(CONFIG_NS)) return;
      if (keyChanged) {
        cache.clear();
        apiState = 'ok';
      }
      scanOpenDocuments();
    })
  );

  // Manual scan command
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_NS}.checkNow`, async () => {
      cache.clear();
      scanOpenDocuments();
      vscode.window.showInformationMessage('EOL Check: Scanning workspace...');
    })
  );

  // Open score card command
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_NS}.openScoreCard`, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const text = doc.getText();
      const detections = getDetections(doc.fileName, text);
      if (detections.length === 0) {
        vscode.window.showInformationMessage('No EOL runtimes detected in this file.');
        return;
      }
      const items = detections.map(d => ({
        label: `${d.slug} ${d.version}`,
        url: `https://endoflife.ai/score/${d.slug}/${d.version}`,
      }));
      const picked = await vscode.window.showQuickPick(items.map(i => i.label));
      if (picked) {
        const item = items.find(i => i.label === picked);
        if (item) vscode.env.openExternal(vscode.Uri.parse(item.url));
      }
    })
  );
}

export function deactivate(): void {}
