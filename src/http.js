'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法 JSON');
  }
}

/** 极简路由：{method, pattern:'/api/rooms/:id', handler} */
class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/:([A-Za-z_]+)/g, (_, k) => {
            keys.push(k);
            return '([^/]+)';
          }) +
        '$'
    );
    this.routes.push({ method, regex, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: 'not_found', message: '文件不存在' });
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * 创建 HTTP 服务。
 * @param {object} opts { router, publicDir, photosDir, onRequest(req) }
 */
function createHttpServer({ router, publicDir, photosDir, beforeApi }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const matched = router.match(req.method, pathname);
        if (!matched) throw new HttpError(404, 'not_found', '接口不存在');
        req.query = Object.fromEntries(url.searchParams.entries());
        req.params = matched.params;
        if (beforeApi) await beforeApi(req);
        const out = await matched.handler(req, res);
        if (!res.writableEnded) sendJson(res, 200, out === undefined ? { ok: true } : out);
        return;
      }
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不允许');
      if (pathname.startsWith('/photos/')) {
        const name = path.basename(pathname); // 防目录穿越
        sendFile(res, path.join(photosDir, name));
        return;
      }
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const filePath = path.join(publicDir, rel);
      if (!filePath.startsWith(publicDir)) throw new HttpError(403, 'forbidden', '禁止访问');
      sendFile(res, filePath);
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error('[http] unexpected:', err);
        sendJson(res, 500, { error: 'internal', message: '服务器内部错误' });
      }
    }
  });
}

module.exports = { Router, createHttpServer, readJson, sendJson };
