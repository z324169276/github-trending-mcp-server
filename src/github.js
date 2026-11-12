import { execFileSync } from 'node:child_process';

const API_BASE = 'https://api.github.com';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub REST 客户端
 * - 未认证：Search API 10 次/分钟，按 6.6s 间隔排队
 * - 已认证：30 次/分钟，按 2.2s 间隔排队
 * - 读取 x-ratelimit-* 响应头，额度耗尽时等待重置
 */
export class GitHubClient {
  constructor(token = '') {
    this.token = token || '';
    this.minInterval = this.token ? 2200 : 6600;
    this.lastRequestAt = 0;
    this.rate = null;
    this.paceQueue = Promise.resolve();
  }

  get rateInfo() {
    return this.rate;
  }

  #pace() {
    const task = async () => {
      if (this.rate && this.rate.remaining <= 0) {
        const waitMs = this.rate.resetAt - Date.now() + 2000;
        if (waitMs > 0) await sleep(Math.min(waitMs, 10 * 60 * 1000));
      }
      const waitMs = this.lastRequestAt + this.minInterval - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      this.lastRequestAt = Date.now();
    };
    const queued = this.paceQueue.then(task).catch(() => {});
    this.paceQueue = queued;
    return queued;
  }

  async request(pathOrUrl, { accept = 'application/vnd.github+json', raw = false, retries = 2 } = {}) {
    await this.#pace();

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    const headers = {
      Accept: accept,
      'User-Agent': 'github-trending-mcp',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (retries > 0) {
        await sleep(2000);
        return this.request(pathOrUrl, { accept, raw, retries: retries - 1 });
      }
      throw new Error(`网络请求失败：${err.message}`);
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.rate = {
        remaining,
        limit: Number(res.headers.get('x-ratelimit-limit')) || null,
        resetAt: reset * 1000,
        resource: res.headers.get('x-ratelimit-resource') || 'core',
      };
    }

    if ((res.status === 403 || res.status === 429) && retries > 0) {
      const waitMs = this.rate ? this.rate.resetAt - Date.now() + 2000 : 60000;
      await sleep(Math.max(2000, Math.min(waitMs, 10 * 60 * 1000)));
      return this.request(pathOrUrl, { accept, raw, retries: retries - 1 });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 403 || res.status === 429 ? '（可能已触发限流，配置 GITHUB_TOKEN 可提升额度）' : '';
      throw new Error(`GitHub API ${res.status}${hint}：${body.slice(0, 200)}`);
    }

    return raw ? res.text() : res.json();
  }

  searchRepos({ q, sort = 'stars', order = 'desc', perPage = 30 }) {
    const url = new URL(`${API_BASE}/search/repositories`);
    url.searchParams.set('q', q);
    url.searchParams.set('sort', sort);
    url.searchParams.set('order', order);
    url.searchParams.set('per_page', String(perPage));
    return this.request(url.toString());
  }

  repo(fullName) {
    return this.request(`/repos/${fullName}`);
  }

  readme(fullName) {
    return this.request(`/repos/${fullName}/readme`, {
      accept: 'application/vnd.github.raw',
      raw: true,
    });
  }
}

/** 优先级：GITHUB_TOKEN > GH_TOKEN > gh CLI 登录态 */
export function resolveToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'env:GITHUB_TOKEN' };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, source: 'env:GH_TOKEN' };

  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return { token: out, source: 'gh-cli' };
  } catch {
    /* 未安装 gh 或未登录 */
  }

  return { token: '', source: 'none' };
}
