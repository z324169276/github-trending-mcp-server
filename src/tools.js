import { GitHubClient, resolveToken } from './github.js';

const DAY = 86400000;

/** 参数 → 时间窗口。新项目冒头需要更长的观察期，活跃项目的窗口更短 */
const WINDOW_DAYS = {
  new: { day: 7, week: 30, month: 90 },
  active: { day: 1, week: 7, month: 30 },
};

const MIN_STARS = {
  new: { day: 20, week: 100, month: 300 },
  active: { day: 1000, week: 500, month: 200 },
};

let client = null;

function gh() {
  if (!client) client = new GitHubClient(resolveToken().token);
  return client;
}

function daysAgo(n) {
  return new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function escapeCell(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s || '—';
}

function repoRow(item, index) {
  const desc = escapeCell(item.description);
  const lang = item.language || '—';
  return `| ${index} | [${item.full_name}](${item.html_url}) | ⭐ ${fmtNum(item.stargazers_count)} | ${lang} | ${desc} |`;
}

function repoTable(items, header) {
  const rows = items.map((it, i) => repoRow(it, i + 1));
  return [header, '', '| # | 仓库 | Star | 语言 | 简介 |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** 统一查询：trending 与 search 共用 Search API */
async function query({ q, limit, sort = 'stars' }) {
  const data = await gh().searchRepos({ q, sort, perPage: limit });
  return { items: data.items || [], total: data.total_count || 0, incomplete: !!data.incomplete_results };
}

const TOOLS = [
  {
    name: 'trending_repos',
    description:
      '查询 GitHub 近期热门仓库。mode=new 找最近新建且涨星快的项目（发现新东西）；mode=active 找近期仍有提交的高星项目（找成熟活跃项目）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['new', 'active'],
          default: 'new',
          description: 'new=近期新建的新星项目；active=近期有更新且 Star 较高的活跃项目',
        },
        language: {
          type: 'string',
          description: '限定编程语言，如 Python、TypeScript、C++；不填为全部语言',
        },
        period: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          default: 'week',
          description: '统计窗口。new 模式下分别对应近 7/30/90 天；active 模式下对应近 1/7/30 天',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          default: 10,
          description: '返回条数，1–30',
        },
      },
    },
  },
  {
    name: 'search_repos',
    description: '按关键词搜索 GitHub 仓库，支持语言、最低 Star、排序方式过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如 "vector database"、"mcp server"' },
        language: { type: 'string', description: '限定编程语言' },
        minStars: { type: 'integer', minimum: 0, description: '最低 Star 数，默认 0' },
        sort: {
          type: 'string',
          enum: ['stars', 'forks', 'updated'],
          default: 'stars',
          description: '排序字段',
        },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 10, description: '返回条数' },
      },
      required: ['query'],
    },
  },
  {
    name: 'repo_detail',
    description: '获取单个仓库的详细信息：Star / Fork / Issue、语言、许可证、最近更新、话题标签，以及 README 开头部分。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: '仓库全名，格式 owner/name，例如 "facebook/react"',
        },
        readmeChars: {
          type: 'integer',
          minimum: 0,
          maximum: 8000,
          default: 2000,
          description: '返回 README 的字符数，0 表示不返回 README',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'compare_repos',
    description: '横向对比多个仓库的关键指标（Star、Fork、Issue、语言、许可证、活跃度），用于技术选型。',
    inputSchema: {
      type: 'object',
      properties: {
        repos: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 8,
          description: '仓库全名数组，格式 owner/name，2–8 个',
        },
      },
      required: ['repos'],
    },
  },
];

async function trendingRepos(args = {}) {
  const mode = args.mode === 'active' ? 'active' : 'new';
  const period = WINDOW_DAYS[mode][args.period] ? args.period : 'week';
  const limit = clampInt(args.limit, 1, 30, 10);
  const days = WINDOW_DAYS[mode][period];
  const minStars = MIN_STARS[mode][period];

  const filters =
    mode === 'new'
      ? [`created:>${daysAgo(days)}`, `stars:>${minStars}`]
      : [`pushed:>${daysAgo(days)}`, `stars:>${minStars}`];

  if (args.language) filters.push(`language:"${String(args.language).trim()}"`);

  const q = filters.join(' ');
  const { items, total, incomplete } = await query({ q, limit, sort: 'stars' });

  if (!items.length) {
    return `没有找到符合条件的仓库。\n\n查询条件：\`${q}\`\n可以放宽 period（比如 day → month）或去掉语言限定。`;
  }

  const modeLabel = mode === 'new' ? '近 ' + days + ' 天新建' : '近 ' + days + ' 天有更新';
  const langLabel = args.language ? ` · ${args.language}` : '';
  const header =
    `## GitHub 热门仓库 · ${modeLabel}${langLabel}\n\n` +
    `按 Star 排序，共匹配 ${fmtNum(total)} 个仓库，返回前 ${items.length} 个。\n` +
    (incomplete ? '> 注：GitHub 返回结果不完整，可能有遗漏。\n' : '');

  return repoTable(items, header) + `\n\n查询语句：\`${q}\``;
}

async function searchRepos(args = {}) {
  const keyword = String(args.query || '').trim();
  if (!keyword) throw new Error('query 不能为空');

  const limit = clampInt(args.limit, 1, 30, 10);
  const minStars = clampInt(args.minStars, 0, Number.MAX_SAFE_INTEGER, 0);
  const sort = ['stars', 'forks', 'updated'].includes(args.sort) ? args.sort : 'stars';

  const filters = [keyword];
  if (args.language) filters.push(`language:"${String(args.language).trim()}"`);
  if (minStars > 0) filters.push(`stars:>=${minStars}`);

  const q = filters.join(' ');
  const { items, total } = await query({ q, limit, sort });

  if (!items.length) {
    return `没有搜到仓库。\n\n查询语句：\`${q}\`\n建议减少关键词或降低 minStars。`;
  }

  const header =
    `## 搜索结果：${keyword}\n\n` +
    `共匹配 ${fmtNum(total)} 个仓库，按 ${sort} 排序，返回前 ${items.length} 个。\n`;

  return repoTable(items, header) + `\n\n查询语句：\`${q}\``;
}

async function repoDetail(args = {}) {
  const repo = String(args.repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo 格式应为 owner/name，例如 facebook/react');

  const readmeChars = clampInt(args.readmeChars, 0, 8000, 2000);
  const data = await gh().repo(repo);

  const lines = [
    `## ${data.full_name}`,
    '',
    data.description ? `> ${data.description}` : '',
    '',
    `- 地址：${data.html_url}`,
    `- Star：${fmtNum(data.stargazers_count)}　Fork：${fmtNum(data.forks_count)}　Issue：${fmtNum(data.open_issues_count)}`,
    `- 语言：${data.language || '—'}　许可证：${data.license?.spdx_id || '—'}`,
    `- 创建：${(data.created_at || '').slice(0, 10)}　最近推送：${(data.pushed_at || '').slice(0, 10)}`,
    `- 主页：${data.homepage || '—'}`,
    `- 话题：${(data.topics || []).length ? data.topics.join('、') : '—'}`,
    data.archived ? '- 状态：**已归档（不再维护）**' : '',
  ].filter((l) => l !== '');

  if (readmeChars > 0) {
    try {
      const text = await gh().readme(repo);
      const body = text.slice(0, readmeChars);
      lines.push('', '### README 摘录', '', body, text.length > readmeChars ? '\n\n_(已截断)_' : '');
    } catch {
      lines.push('', '_未获取到 README_');
    }
  }

  return lines.join('\n');
}

async function compareRepos(args = {}) {
  const repos = (Array.isArray(args.repos) ? args.repos : [])
    .map((r) => String(r).trim())
    .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));

  if (repos.length < 2) throw new Error('至少需要 2 个格式为 owner/name 的仓库');

  const rows = [];
  const errors = [];
  for (const name of repos.slice(0, 8)) {
    try {
      const d = await gh().repo(name);
      rows.push(d);
    } catch (err) {
      errors.push(`- ${name}：${err.message}`);
    }
  }

  if (!rows.length) return `全部仓库获取失败：\n${errors.join('\n')}`;

  const lines = [
    '## 仓库对比',
    '',
    '| 仓库 | Star | Fork | Issue | 语言 | 许可证 | 最近推送 | 状态 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (d) =>
        `| [${d.full_name}](${d.html_url}) | ${fmtNum(d.stargazers_count)} | ${fmtNum(d.forks_count)} | ` +
        `${fmtNum(d.open_issues_count)} | ${d.language || '—'} | ${d.license?.spdx_id || '—'} | ` +
        `${(d.pushed_at || '').slice(0, 10)} | ${d.archived ? '已归档' : '活跃'} |`,
    ),
    '',
  ];

  if (errors.length) lines.push('获取失败：', ...errors);

  return lines.join('\n');
}

const HANDLERS = {
  trending_repos: trendingRepos,
  search_repos: searchRepos,
  repo_detail: repoDetail,
  compare_repos: compareRepos,
};

export { TOOLS };

export async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`未知工具：${name}`);
  return handler(args || {});
}
