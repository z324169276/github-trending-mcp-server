#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';
import { resolveToken } from './github.js';

const SERVER_NAME = 'github-trending';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

/** 协议消息只走 stdout，日志一律走 stderr，避免污染 JSON-RPC 流 */
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const text = await callTool(name, args);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // 工具级错误按协议要求回填到 content，让模型能看到并自行纠正
        return reply(id, {
          content: [{ type: 'text', text: `工具执行失败：${err.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return reply(id, {});

    default:
      return replyError(id, -32601, `未实现的方法：${method}`);
  }
}

function main() {
  const { source } = resolveToken();
  process.stderr.write(`[github-trending-mcp] 已启动，Token 来源：${source}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let pending = 0;
  let closing = false;

  const exitWhenIdle = () => {
    if (closing && pending === 0) process.exit(0);
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }

    // 通知（没有 id）不需要响应，例如 notifications/initialized
    if (message.id === undefined || message.id === null) return;

    pending += 1;
    handle(message)
      .catch((err) => replyError(message.id, -32603, err.message))
      .finally(() => {
        pending -= 1;
        exitWhenIdle();
      });
  });

  // stdin 关闭后要等在途请求跑完，否则最后一条工具调用会被丢弃
  rl.on('close', () => {
    closing = true;
    exitWhenIdle();
  });
}

main();
