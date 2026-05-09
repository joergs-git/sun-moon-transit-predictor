// Minimal Pushover client. Stateless; one POST per message. Uses built-in
// fetch (Node ≥ 20) so it has no network dependencies of its own.

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

/**
 * @typedef {Object} PushoverConfig
 * @property {string} token
 * @property {string} user
 * @property {string} [device]
 * @property {boolean} [enabled]
 */

/**
 * @typedef {Object} PushoverMessage
 * @property {string} message
 * @property {string} [title]
 * @property {-2|-1|0|1|2} [priority]
 * @property {string} [url]
 * @property {string} [urlTitle]
 * @property {number} [timestamp]   - unix seconds
 * @property {boolean} [html]
 */

export class PushoverClient {
  /**
   * @param {PushoverConfig} config
   * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
   */
  constructor(config, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return Boolean(this.config?.enabled && this.config.token && this.config.user);
  }

  /**
   * @param {PushoverMessage} msg
   */
  async send(msg) {
    if (!this.enabled) {
      return { sent: false, reason: 'disabled' };
    }
    const body = new URLSearchParams();
    body.set('token', this.config.token);
    body.set('user', this.config.user);
    body.set('message', msg.message);
    if (msg.title) body.set('title', msg.title);
    if (typeof msg.priority === 'number') body.set('priority', String(msg.priority));
    if (msg.url) body.set('url', msg.url);
    if (msg.urlTitle) body.set('url_title', msg.urlTitle);
    if (typeof msg.timestamp === 'number') body.set('timestamp', String(msg.timestamp));
    if (msg.html) body.set('html', '1');
    if (this.config.device) body.set('device', this.config.device);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(PUSHOVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== 1) {
        const err = new Error(`Pushover error ${res.status}: ${JSON.stringify(json)}`);
        err.response = json;
        throw err;
      }
      return { sent: true, response: json };
    } finally {
      clearTimeout(timer);
    }
  }
}
