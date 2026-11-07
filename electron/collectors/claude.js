// Claude plan limits (5-hour and weekly windows) with reset times.
// Two sources, tried in order:
//  1. Claude Code's sign-in file (~/.claude/.credentials.json), if the CLI is signed in.
//  2. A claude.ai session you sign into yourself in the bar's own sign-in window.
// Both use endpoints Anthropic doesn't document, so they can change without notice.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { session, net, BrowserWindow } = require('electron');
const { EventEmitter } = require('events');

const PARTITION = 'persist:claude';
const LABELS = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  seven_day_oauth_apps: '7d apps',
};

function claudeSession() {
  const ses = session.fromPartition(PARTITION);
  if (!ses.__uaFixed) {
    // A plain Chrome user agent, so sign-in pages treat this like a normal browser.
    ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?statusbar\/\S+/, ''));
    ses.__uaFixed = true;
  }
  return ses;
}

function normalize(usage) {
  const windows = [];
  for (const [key, v] of Object.entries(usage || {})) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      windows.push({ key, label: LABELS[key] || key.replace(/_/g, ' '), pct: v.utilization, resetsAt: v.resets_at || null });
    }
  }
  const order = Object.keys(LABELS);
  windows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  const extra = usage && usage.extra_usage && typeof usage.extra_usage === 'object' ? usage.extra_usage : null;
  return { windows, extra };
}

class ClaudeCollector extends EventEmitter {
  constructor(config) {
    super();
    this.pollMs = Math.max(2, config.claudePollMinutes || 5) * 60 * 1000;
    this.state = { status: 'loading', windows: [], extra: null, source: null, updatedAt: null, error: null };
    this.orgId = null;
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.pollMs);
  }

  async refresh() {
    try {
      let result = await this.viaCredentials();
      if (!result) result = await this.viaClaudeAi();
      if (!result) {
        this.state = { ...this.state, status: 'signed-out', error: null };
      } else {
        this.state = { status: 'ok', ...normalize(result.usage), source: result.source, updatedAt: Date.now(), error: null };
      }
    } catch (e) {
      // Keep the last good numbers on screen; just flag the error.
      this.state = { ...this.state, status: this.state.windows.length ? 'stale' : 'error', error: String(e.message || e) };
    }
    this.emit('update');
  }

  async viaCredentials() {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    let token;
    try {
      const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
      token = creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
      if (creds.claudeAiOauth && creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) token = null;
    } catch { return null; }
    if (!token) return null;
    const res = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null; // fall back to the claude.ai session
    return { usage: await res.json(), source: 'Claude Code sign-in' };
  }

  async viaClaudeAi() {
    const ses = claudeSession();
    const cookies = await ses.cookies.get({ domain: 'claude.ai', name: 'sessionKey' });
    if (!cookies.length) return null;
    if (!this.orgId) {
      const orgs = await this.getJSON('https://claude.ai/api/organizations');
      if (!Array.isArray(orgs) || !orgs.length) return null;
      const chatOrg = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
      this.orgId = chatOrg.uuid;
    }
    const usage = await this.getJSON(`https://claude.ai/api/organizations/${this.orgId}/usage`);
    if (!usage || usage.error || usage.type === 'error') { this.orgId = null; return null; }
    return { usage, source: 'claude.ai' };
  }

  // Tries a direct request first; if Cloudflare answers with a challenge page instead of
  // JSON, loads the URL in a hidden window of the same session so the challenge can pass.
  async getJSON(url) {
    const ses = claudeSession();
    try {
      const res = await ses.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      if (res.status === 401) return null;
      return JSON.parse(text);
    } catch {
      return this.getJSONViaWindow(url);
    }
  }

  async getJSONViaWindow(url) {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION } });
    try {
      await win.loadURL(url);
      for (let i = 0; i < 15; i++) {
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
        try { return JSON.parse(text); } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('claude.ai did not return usage data');
    } finally {
      win.destroy();
    }
  }

  openSignIn(parent) {
    if (this.signInWin && !this.signInWin.isDestroyed()) { this.signInWin.focus(); return; }
    claudeSession();
    const win = new BrowserWindow({
      width: 480, height: 720, title: 'Sign in to Claude', autoHideMenuBar: true,
      webPreferences: { partition: PARTITION },
    });
    this.signInWin = win;
    win.loadURL('https://claude.ai/login');
    // Signed in once claude.ai moves on from the login pages.
    win.webContents.on('did-navigate', (_e, url) => {
      if (/claude\.ai\/(new|chat|recents|project)/.test(url)) {
        this.orgId = null;
        this.refresh();
        setTimeout(() => !win.isDestroyed() && win.close(), 800);
      }
    });
    win.on('closed', () => { this.signInWin = null; this.refresh(); });
  }

  async signOut() {
    await claudeSession().clearStorageData();
    this.orgId = null;
    this.state = { status: 'signed-out', windows: [], extra: null, source: null, updatedAt: null, error: null };
    this.emit('update');
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { ClaudeCollector };
