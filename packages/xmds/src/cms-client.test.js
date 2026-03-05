// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CMS_CLIENT_METHODS, assertCmsClient } from './cms-client.js';
import { RestClient } from './rest-client.js';
import { XmdsClient } from './xmds-client.js';

const mockConfig = {
  cmsUrl: 'https://example.com',
  cmsKey: 'test',
  hardwareKey: 'hw-001',
  displayName: 'Test Display',
  xmrChannel: '',
};

describe('CmsClient interface conformance', () => {
  const restClient = new RestClient(mockConfig);
  const xmdsClient = new XmdsClient(mockConfig);

  it('CMS_CLIENT_METHODS lists 12 methods', () => {
    expect(CMS_CLIENT_METHODS).toHaveLength(12);
  });

  for (const method of CMS_CLIENT_METHODS) {
    it(`RestClient implements ${method}()`, () => {
      expect(typeof restClient[method]).toBe('function');
    });

    it(`XmdsClient implements ${method}()`, () => {
      expect(typeof xmdsClient[method]).toBe('function');
    });
  }

  it('assertCmsClient passes for RestClient', () => {
    expect(() => assertCmsClient(restClient, 'RestClient')).not.toThrow();
  });

  it('assertCmsClient passes for XmdsClient', () => {
    expect(() => assertCmsClient(xmdsClient, 'XmdsClient')).not.toThrow();
  });

  it('assertCmsClient throws for incomplete client', () => {
    const partial = { registerDisplay: () => {} };
    expect(() => assertCmsClient(partial, 'partial')).toThrow('partial missing CmsClient method');
  });

  it('assertCmsClient throws for non-function property', () => {
    const bad = Object.fromEntries(CMS_CLIENT_METHODS.map(m => [m, () => {}]));
    bad.schedule = 'not a function';
    expect(() => assertCmsClient(bad, 'bad')).toThrow('bad missing CmsClient method: schedule()');
  });
});
