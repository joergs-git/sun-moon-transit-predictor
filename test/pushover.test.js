import { describe, expect, it } from 'vitest';
import { PushoverClient } from '../src/pushover.js';

describe('PushoverClient', () => {
  it('returns "disabled" when not enabled', async () => {
    const c = new PushoverClient({ token: 't', user: 'u', enabled: false });
    const r = await c.send({ message: 'hi' });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('posts form-encoded body to the pushover endpoint', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() { return { status: 1, request: 'abc' }; },
      };
    };
    const c = new PushoverClient(
      { token: 'TKN', user: 'USR', enabled: true, device: 'phone' },
      { fetchImpl: fakeFetch },
    );
    const r = await c.send({
      message: 'Hello',
      title: 'Title',
      priority: 1,
      url: 'http://pi/',
      urlTitle: 'Pi UI',
      timestamp: 1234567890,
    });
    expect(r.sent).toBe(true);
    expect(calls[0].url).toBe('https://api.pushover.net/1/messages.json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(calls[0].init.body);
    expect(params.get('token')).toBe('TKN');
    expect(params.get('user')).toBe('USR');
    expect(params.get('message')).toBe('Hello');
    expect(params.get('title')).toBe('Title');
    expect(params.get('priority')).toBe('1');
    expect(params.get('url')).toBe('http://pi/');
    expect(params.get('url_title')).toBe('Pi UI');
    expect(params.get('timestamp')).toBe('1234567890');
    expect(params.get('device')).toBe('phone');
  });

  it('throws when the API rejects the message', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 400,
      async json() { return { status: 0, errors: ['bad token'] }; },
    });
    const c = new PushoverClient({ token: 't', user: 'u', enabled: true }, { fetchImpl: fakeFetch });
    await expect(c.send({ message: 'x' })).rejects.toThrow(/Pushover error 400/);
  });
});
