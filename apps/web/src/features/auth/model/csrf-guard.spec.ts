import { describe, expect, it } from 'vitest';
import { isSameOriginJsonRequest, isTrustedSessionRequest } from './csrf-guard';

const base = {
  contentType: 'application/json',
  origin: 'http://localhost:3000',
  requestOrigin: 'http://localhost:3000',
};

describe('isSameOriginJsonRequest', () => {
  it('accepts same-origin JSON', () => {
    expect(isSameOriginJsonRequest(base)).toBe(true);
    expect(
      isSameOriginJsonRequest({ ...base, contentType: 'application/json; charset=utf-8' }),
    ).toBe(true);
  });
  it('rejects text/plain, form types and missing content-type', () => {
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      null,
    ]) {
      expect(isSameOriginJsonRequest({ ...base, contentType })).toBe(false);
    }
  });
  it('rejects missing, null, malformed or cross-site Origin', () => {
    for (const origin of [null, 'null', 'not a url', 'https://evil.example']) {
      expect(isSameOriginJsonRequest({ ...base, origin })).toBe(false);
    }
  });
  it('honours the APP_ORIGIN override', () => {
    const proxied = {
      ...base,
      origin: 'https://ftthtracker.projectflow.site',
      requestOrigin: 'http://web:3000',
    };
    expect(isSameOriginJsonRequest(proxied)).toBe(false);
    expect(
      isSameOriginJsonRequest({ ...proxied, appOrigin: 'https://ftthtracker.projectflow.site' }),
    ).toBe(true);
    expect(
      isSameOriginJsonRequest({ ...base, appOrigin: 'https://ftthtracker.projectflow.site' }),
    ).toBe(false);
  });
});

describe('isTrustedSessionRequest', () => {
  it('derives the origin from the request URL', () => {
    const ok = new Request('http://localhost:3000/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: '{}',
    });
    expect(isTrustedSessionRequest(ok)).toBe(true);
    const evil = new Request('http://localhost:3000/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(isTrustedSessionRequest(evil)).toBe(false);
  });
});
