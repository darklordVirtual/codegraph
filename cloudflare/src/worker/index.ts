import { handleMCP } from './mcp';
import { handleWebhook } from './webhook';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  MCP_AUTH_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
}

const CORS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // Health check
    if (pathname === '/status') {
      return Response.json({ ok: true, version: '1.0.0' }, { headers: CORS });
    }

    // GitHub webhook
    if (pathname === '/webhook/github' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // MCP endpoint: /{owner}/{repo}/mcp
    const mcpMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/mcp$/);
    if (mcpMatch && request.method === 'POST') {
      const repo = `${mcpMatch[1]}/${mcpMatch[2]}`;
      const response = await handleMCP(request, env, repo);
      // Attach CORS to every MCP response
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }

    return new Response('Not Found', { status: 404 });
  },
};
