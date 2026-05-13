import type { Env } from './index';
import { executeTool, listTools } from './tools';

interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function handleMCP(request: Request, env: Env, repo: string): Promise<Response> {
  if (env.MCP_AUTH_TOKEN) {
    const auth = request.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
      return Response.json(rpcError(null, -32001, 'Unauthorized'), { status: 401 });
    }
  }

  let rpc: RpcRequest;
  try {
    rpc = (await request.json()) as RpcRequest;
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'));
  }

  const result = await dispatch(rpc, env.DB, repo);
  return Response.json(result);
}

async function dispatch(rpc: RpcRequest, db: D1Database, repo: string): Promise<RpcResponse> {
  const { id, method, params } = rpc;

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'codegraph', version: '1.0.0' },
        });

      case 'notifications/initialized':
      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: listTools() });

      case 'tools/call': {
        const { name, arguments: args = {} } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        const text = await executeTool(db, repo, name, args);
        return ok(id, {
          content: [{ type: 'text', text }],
          isError: false,
        });
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(id, -32603, `Internal error: ${msg}`);
  }
}

function ok(id: RpcRequest['id'], result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: RpcRequest['id'],
  code: number,
  message: string,
): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
