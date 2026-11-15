// Optional incident notifications: generic webhook + Telegram.
export class Notifier {
  constructor({ config, log = console, fetchImpl = globalThis.fetch }) {
    const options = config.notifications || {};
    this.webhookUrl = options.webhookUrl || '';
    this.telegram = options.telegram || {};
    this.notifyOnRecovery = options.notifyOnRecovery !== false;
    this.timeoutMs = Math.min(15000, Math.max(2000, Number(options.timeoutMs) || 8000));
    this.log = log;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.webhookUrl || (this.telegram.botToken && this.telegram.chatId));
  }

  async send(event, incident, node) {
    if (!this.enabled) return;
    if (event === 'incident.resolved' && !this.notifyOnRecovery) return;
    const payload = {
      source: 'eleganza',
      event,
      sentAt: new Date().toISOString(),
      node: node ? {
        id: node.id,
        name: node.name,
        status: node.status,
        latencyMs: node.latencyMs,
        availability30d: node.availability30d,
      } : null,
      incident: {
        id: incident.id,
        targetId: incident.targetId,
        targetName: incident.targetName,
        startedAt: new Date(incident.startedAt).toISOString(),
        endedAt: incident.endedAt ? new Date(incident.endedAt).toISOString() : null,
        durationMs: incident.durationMs ?? null,
        error: incident.error,
      },
    };
    const jobs = [];
    if (this.webhookUrl) jobs.push(this.postWebhook(payload));
    if (this.telegram.botToken && this.telegram.chatId) jobs.push(this.postTelegram(payload));
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === 'rejected') this.log.warn?.(`[Eleganza] 通知发送失败: ${result.reason?.message || result.reason}`);
    }
  }

  async postWebhook(payload) {
    const response = await this.fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Eleganza-Notifier/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
  }

  async postTelegram(payload) {
    const { incident, node } = payload;
    const duration = incident.durationMs != null
      ? formatDuration(incident.durationMs)
      : '';
    const text = payload.event === 'incident.opened'
      ? [
        `🔴 Eleganza · ${node?.name || incident.targetName} 离线`,
        `${incident.error || '探测失败'}`,
        `开始 ${new Date(incident.startedAt).toLocaleString('zh-CN', { hour12: false })}`,
        node?.availability30d != null ? `30 天可用率 ${node.availability30d}%` : '',
      ].filter(Boolean).join('\n')
      : [
        `🟢 Eleganza · ${node?.name || incident.targetName} 已恢复`,
        `故障持续 ${duration}`,
        `恢复 ${new Date(incident.endedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`,
      ].filter(Boolean).join('\n');
    const url = `https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.telegram.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`telegram HTTP ${response.status}`);
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
