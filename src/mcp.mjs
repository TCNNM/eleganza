import { Store } from './store.mjs';

const SERVER_INFO = { name: 'polaris', title: 'Polaris Probe', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'overview',
    title: 'Network overview',
    description: '当前网络总览：节点总数、在线/告警/离线数量、30 天可用率、平均延迟和进行中的事件。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_nodes',
    title: 'List nodes',
    description: '列出所有探针节点。可按状态（online/warning/offline/pending）或类型（https/tcp/agent）过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['online', 'warning', 'offline', 'pending'] },
        type: { type: 'string', enum: ['https', 'http', 'tcp', 'agent'] },
        region: { type: 'string', description: '按 group / country / city 模糊过滤' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_node',
    title: 'Get node detail',
    description: '读取单个节点的详情：当前状态、30 天可用率、资源指标、TLS 证书、服务与历史事件。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '节点 id，例如 hk-core' },
        range: { type: 'string', enum: ['1h', '24h', '7d', '30d'], default: '24h' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_history',
    title: 'Get latency history',
    description: '读取节点的延迟/可用率时间序列，用于趋势分析。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        range: { type: 'string', enum: ['1h', '24h', '7d', '30d'], default: '24h' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_incidents',
    title: 'List incidents',
    description: '列出最近的故障事件，包含开始/结束时间、持续时长和错误原因。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function compactSummary(node) {
  return {
    id: node.id,
    name: node.name,
    region: node.city || node.group || '',
    country: node.country,
    type: node.type,
    status: node.status,
    latencyMs: node.latencyMs,
    availability30d: node.availability30d,
    lastCheck: node.lastCheck ? new Date(node.lastCheck).toISOString() : null,
    reasons: node.reasons,
    error: node.error || undefined,
  };
}

export class McpServer {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  nodeList(args = {}) {
    const overview = this.store.overview();
    let nodes = overview.targets;
    if (args.status) nodes = nodes.filter((node) => node.status === args.status);
    if (args.type) nodes = nodes.filter((node) => node.type === args.type);
    if (args.region) {
      const needle = String(args.region).toLowerCase();
      nodes = nodes.filter((node) => [node.group, node.country, node.city, node.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)));
    }
    return nodes;
  }

  callTool(name, args = {}) {
    if (name === 'overview') {
      const overview = this.store.overview();
      return textResult({
        summary: overview.summary,
        nodes: overview.targets.map(compactSummary),
        openIncidents: overview.incidents.map((incident) => ({
          node: incident.targetName,
          startedAt: new Date(incident.startedAt).toISOString(),
          error: incident.error,
        })),
      });
    }
    if (name === 'list_nodes') {
      const nodes = this.nodeList(args);
      return textResult({
        count: nodes.length,
        nodes: nodes.map(compactSummary),
      });
    }
    if (name === 'get_node') {
      if (!args.node_id) return errorResult('缺少 node_id 参数');
      const detail = this.store.detail(String(args.node_id), args.range || '24h');
      if (!detail) return errorResult(`没有找到节点 ${args.node_id}`);
      return textResult({
        node: { ...compactSummary(detail.target), reasons: detail.target.reasons, endpoint: detail.target.endpoint },
        summary: detail.summary,
        tls: detail.target.tls,
        metrics: detail.target.metrics,
        agent: detail.agent ? {
          hostname: detail.agent.hostname,
          platform: detail.agent.platform,
          version: detail.agent.version,
          uptimeSeconds: detail.agent.uptimeSeconds,
          lastSeen: new Date(detail.agent.lastSeen).toISOString(),
        } : null,
        services: detail.services,
        incidents: detail.incidents.map((incident) => ({
          startedAt: new Date(incident.startedAt).toISOString(),
          endedAt: incident.endedAt ? new Date(incident.endedAt).toISOString() : null,
          durationMs: incident.durationMs,
          ongoing: incident.ongoing,
          error: incident.error,
        })),
      });
    }
    if (name === 'get_history') {
      if (!args.node_id) return errorResult('缺少 node_id 参数');
      const detail = this.store.detail(String(args.node_id), args.range || '24h');
      if (!detail) return errorResult(`没有找到节点 ${args.node_id}`);
      return textResult({
        node: detail.target.name,
        range: detail.range,
        summary: detail.summary,
        points: detail.points.map((point) => ({
          t: new Date(point.t).toISOString(),
          latency: point.latency,
          availability: point.availability,
          up: point.up,
          total: point.total,
        })),
      });
    }
    if (name === 'list_incidents') {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      return textResult({
        count: limit,
        incidents: this.store.incidentsList(limit).map((incident) => ({
          id: incident.id,
          node: incident.targetName,
          startedAt: new Date(incident.startedAt).toISOString(),
          endedAt: incident.endedAt ? new Date(incident.endedAt).toISOString() : null,
          durationMs: incident.durationMs,
          ongoing: incident.ongoing,
          error: incident.error,
        })),
      });
    }
    return errorResult(`未知工具: ${name}`);
  }

  async handle(message) {
    const { id, method, params } = message || {};
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string') {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Polaris 是自建的服务器探针面板。用 overview 获取整体状态，用 list_nodes / get_node 查看节点，用 list_incidents 查看故障。所有时间均为 UTC ISO 字符串。',
        };
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = params?.name;
        if (!name) return { jsonrpc: '2.0', id, error: { code: -32602, message: '缺少工具名称' } };
        try {
          return { jsonrpc: '2.0', id, result: this.callTool(name, params?.arguments || {}) };
        } catch (error) {
          return { jsonrpc: '2.0', id, result: errorResult(`工具执行失败: ${error.message}`) };
        }
      }
      case 'resources/list':
        result = {
          resources: [
            { uri: 'polaris://overview', name: 'Network overview', mimeType: 'application/json' },
            { uri: 'polaris://incidents', name: 'Recent incidents', mimeType: 'application/json' },
          ],
        };
        break;
      case 'resources/read': {
        const uri = params?.uri;
        if (uri === 'polaris://overview') {
          const overview = this.store.overview();
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ summary: overview.summary, nodes: overview.targets.map(compactSummary) }, null, 2),
              }],
            },
          };
        }
        if (uri === 'polaris://incidents') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(this.store.incidentsList(50), null, 2),
              }],
            },
          };
        }
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知资源: ${uri}` } };
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  }
}

export { TOOLS };
