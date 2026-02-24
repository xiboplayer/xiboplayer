/**
 * XMDS Client Tests - SubmitLog and SubmitScreenShot
 *
 * Tests SOAP XML formatting and CMS integration for logging and screenshots.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { XmdsClient } from './xmds-client.js';

describe('XmdsClient - RegisterDisplay', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      displayName: 'Test Display',
      xmrChannel: 'test-xmr-channel',
      xmrPubKey: '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should include xmrPubKey from config in SOAP envelope', () => {
    const envelope = client.buildEnvelope('RegisterDisplay', {
      serverKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      displayName: 'Test Display',
      clientType: 'chromeOS',
      clientVersion: '0.1.0',
      clientCode: '1',
      operatingSystem: 'test',
      macAddress: 'n/a',
      xmrChannel: 'test-xmr-channel',
      xmrPubKey: client.config.xmrPubKey || ''
    });

    expect(envelope).toContain('<xmrPubKey xsi:type="xsd:string">-----BEGIN PUBLIC KEY-----');
  });

  it('should send empty xmrPubKey when config has no key', () => {
    const clientNoKey = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      displayName: 'Test Display',
      xmrChannel: 'test-xmr-channel',
      retryOptions: { maxRetries: 0 }
    });

    const envelope = clientNoKey.buildEnvelope('RegisterDisplay', {
      serverKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      displayName: 'Test Display',
      clientType: 'chromeOS',
      clientVersion: '0.1.0',
      clientCode: '1',
      operatingSystem: 'test',
      macAddress: 'n/a',
      xmrChannel: 'test-xmr-channel',
      xmrPubKey: clientNoKey.config.xmrPubKey || ''
    });

    expect(envelope).toContain('<xmrPubKey xsi:type="xsd:string"></xmrPubKey>');
  });
});

describe('XmdsClient - URL construction', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should include &method= query parameter in SOAP URLs', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <RegisterDisplayResponse>
      <display code="READY" message="ok"></display>
    </RegisterDisplayResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.call('RegisterDisplay', {
      serverKey: 'test-server-key',
      hardwareKey: 'test-hardware-key'
    });

    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('https://cms.example.com/xmds.php?v=5&method=RegisterDisplay');
  });

  it('should append method to proxy URLs with existing query params', async () => {
    // Simulate Electron proxy URL that already has ?cms=...
    client.rewriteXmdsUrl = () => '/xmds-proxy?cms=https%3A%2F%2Fcms.example.com';

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ScheduleResponse><result></result></ScheduleResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.call('Schedule', {
      serverKey: 'test-server-key',
      hardwareKey: 'test-hardware-key'
    });

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('&v=5&method=Schedule');
  });
});

describe('XmdsClient - SubmitLog', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for SubmitLog', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitLogResponse>
      <success>true</success>
    </SubmitLogResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const logXml = '<logs><log date="2026-02-10 12:00:00" category="Error"><message>Test error</message></log></logs>';

    await client.submitLog(logXml);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=SubmitLog',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:SubmitLog>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<logXml xsi:type="xsd:string">');
  });

  it('should XML-escape log content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitLogResponse>
      <success>true</success>
    </SubmitLogResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const logXml = '<logs><log><message>Error: <test> & "quotes"</message></log></logs>';

    await client.submitLog(logXml);

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('&lt;logs&gt;');
    expect(body).toContain('&amp;');
    expect(body).toContain('&quot;');
  });

  it('should return true on successful submission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitLogResponse>
      <success>true</success>
    </SubmitLogResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.submitLog('<logs></logs>');
    expect(result).toBe(true);
  });

  it('should return false on failed submission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitLogResponse>
      <success>false</success>
    </SubmitLogResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.submitLog('<logs></logs>');
    expect(result).toBe(false);
  });

  it('should handle SOAP fault', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Invalid server key</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.submitLog('<logs></logs>')).rejects.toThrow('SOAP Fault: Invalid server key');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(client.submitLog('<logs></logs>')).rejects.toThrow('Network error');
  });

  it('should handle HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    await expect(client.submitLog('<logs></logs>')).rejects.toThrow('XMDS SubmitLog failed: 500 Internal Server Error');
  });
});

describe('XmdsClient - SubmitScreenShot', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for SubmitScreenShot', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitScreenShotResponse>
      <success>true</success>
    </SubmitScreenShotResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    await client.submitScreenShot(base64Image);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=SubmitScreenShot',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:SubmitScreenShot>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<screenShot xsi:type="xsd:string">');
    expect(body).toContain(base64Image);
  });

  it('should handle large base64 images', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitScreenShotResponse>
      <success>true</success>
    </SubmitScreenShotResponse>
  </soap:Body>
</soap:Envelope>`
    });

    // Generate large base64 string (simulate 1MB image)
    const largeBase64 = 'A'.repeat(1024 * 1024);

    const result = await client.submitScreenShot(largeBase64);

    expect(result).toBe(true);
    const body = mockFetch.mock.calls[0][1].body;
    expect(body.length).toBeGreaterThan(1024 * 1024);
  });

  it('should return true on successful submission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitScreenShotResponse>
      <success>true</success>
    </SubmitScreenShotResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.submitScreenShot('test-base64');
    expect(result).toBe(true);
  });

  it('should return false on failed submission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitScreenShotResponse>
      <success>false</success>
    </SubmitScreenShotResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.submitScreenShot('test-base64');
    expect(result).toBe(false);
  });

  it('should handle SOAP fault', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Screenshot too large</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.submitScreenShot('test')).rejects.toThrow('SOAP Fault: Screenshot too large');
  });

  it('should handle placeholder screenshot', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitScreenShotResponse>
      <success>true</success>
    </SubmitScreenShotResponse>
  </soap:Body>
</soap:Envelope>`
    });

    // Placeholder from upstream (1x1 black PNG)
    const placeholder = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAADIBAMAAABfdrOtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAADUExURQAAAKd6PdoAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAArSURBVHja7cExAQAAAMKg9U9tCU8gAAAAAAAAAAAAAAAAAAAAAAAAALipAU7oAAG73DR2AAAAAElFTkSuQmCC';

    const result = await client.submitScreenShot(placeholder);
    expect(result).toBe(true);
  });
});

describe('XmdsClient - BlackList', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for BlackList', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BlackListResponse>
      <success>true</success>
    </BlackListResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.blackList('42', 'media', 'Corrupt file');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=BlackList',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:BlackList>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<mediaId xsi:type="xsd:string">42</mediaId>');
    expect(body).toContain('<type xsi:type="xsd:string">media</type>');
    expect(body).toContain('<reason xsi:type="xsd:string">Corrupt file</reason>');
  });

  it('should return true when CMS confirms blacklist', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BlackListResponse>
      <success>true</success>
    </BlackListResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.blackList('10', 'media', 'Broken');
    expect(result).toBe(true);
  });

  it('should return false when CMS rejects blacklist', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BlackListResponse>
      <success>false</success>
    </BlackListResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.blackList('10', 'media', 'Broken');
    expect(result).toBe(false);
  });

  it('should use default type and reason when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BlackListResponse>
      <success>true</success>
    </BlackListResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.blackList('99');

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<type xsi:type="xsd:string">media</type>');
    expect(body).toContain('<reason xsi:type="xsd:string">Failed to render</reason>');
  });

  it('should convert numeric mediaId to string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BlackListResponse>
      <success>true</success>
    </BlackListResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.blackList(123, 'layout', 'Missing resource');

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<mediaId xsi:type="xsd:string">123</mediaId>');
  });

  it('should return false on SOAP fault instead of throwing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Media not found</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.blackList('999', 'media', 'Not found');
    expect(result).toBe(false);
  });

  it('should return false on network error instead of throwing', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await client.blackList('10', 'media', 'Broken');
    expect(result).toBe(false);
  });

  it('should return false on HTTP error instead of throwing', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    const result = await client.blackList('10', 'media', 'Broken');
    expect(result).toBe(false);
  });
});

describe('XmdsClient - ReportFaults', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for ReportFaults with JSON fault data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ReportFaultsResponse>
      <success>true</success>
    </ReportFaultsResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const fault = JSON.stringify([{
      code: 'LAYOUT_LOAD_FAILED',
      reason: 'Missing resource',
      date: '2026-02-21 10:00:00',
      layoutId: 5
    }]);

    await client.reportFaults(fault);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=ReportFaults',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:ReportFaults>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<fault xsi:type="xsd:string">');
    expect(body).toContain('LAYOUT_LOAD_FAILED');
  });

  it('should handle SOAP fault', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Display not licensed</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.reportFaults('[]')).rejects.toThrow('SOAP Fault: Display not licensed');
  });
});

describe('XmdsClient - NotifyStatus', () => {
  let client;
  let mockFetch;
  let originalNavigator;
  let originalIntl;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Save originals for restoration
    originalNavigator = global.navigator;
    originalIntl = global.Intl;
  });

  afterEach(() => {
    // Restore navigator and Intl
    global.navigator = originalNavigator;
    global.Intl = originalIntl;
  });

  it('should build correct SOAP envelope for NotifyStatus', async () => {
    // Remove storage API to test basic path
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5', timeZone: 'Europe/Madrid' };
    await client.notifyStatus(status);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=NotifyStatus',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:NotifyStatus>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<status xsi:type="xsd:string">');
  });

  it('should enrich status with storage estimate when available', async () => {
    global.navigator = {
      ...originalNavigator,
      storage: {
        estimate: vi.fn().mockResolvedValue({ quota: 1000000, usage: 250000 })
      }
    };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5', timeZone: 'Europe/Madrid' };
    await client.notifyStatus(status);

    // Verify the status object was enriched before being sent
    const body = mockFetch.mock.calls[0][1].body;
    // The status is JSON.stringify'd and then XML-escaped in the SOAP body
    // Parse the escaped JSON from the body to verify enrichment
    expect(status.availableSpace).toBe(750000);
    expect(status.totalSpace).toBe(1000000);
  });

  it('should add timezone when not provided in status', async () => {
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5' };
    await client.notifyStatus(status);

    // timeZone should have been added from Intl
    expect(status.timeZone).toBeDefined();
    expect(typeof status.timeZone).toBe('string');
    expect(status.timeZone.length).toBeGreaterThan(0);
  });

  it('should not overwrite existing timezone in status', async () => {
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5', timeZone: 'America/New_York' };
    await client.notifyStatus(status);

    expect(status.timeZone).toBe('America/New_York');
  });

  it('should handle storage estimate failure gracefully', async () => {
    global.navigator = {
      ...originalNavigator,
      storage: {
        estimate: vi.fn().mockRejectedValue(new Error('Storage API failed'))
      }
    };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5', timeZone: 'UTC' };
    await client.notifyStatus(status);

    // Should not have storage fields since estimate threw
    expect(status.availableSpace).toBeUndefined();
    expect(status.totalSpace).toBeUndefined();

    // But the call should still succeed
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should handle SOAP fault', async () => {
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Display not found</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.notifyStatus({ currentLayoutId: '5', timeZone: 'UTC' }))
      .rejects.toThrow('SOAP Fault: Display not found');
  });

  it('should handle HTTP errors', async () => {
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable'
    });

    await expect(client.notifyStatus({ currentLayoutId: '5', timeZone: 'UTC' }))
      .rejects.toThrow('XMDS NotifyStatus failed: 503 Service Unavailable');
  });

  it('should JSON-stringify and XML-escape the status object', async () => {
    global.navigator = { ...originalNavigator, storage: undefined };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NotifyStatusResponse>
      <success>true</success>
    </NotifyStatusResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const status = { currentLayoutId: '5', deviceName: 'Test <Player> & "Display"', timeZone: 'UTC' };
    await client.notifyStatus(status);

    const body = mockFetch.mock.calls[0][1].body;
    // JSON special chars get JSON-escaped, then XML-escaped by buildEnvelope
    // The " in JSON becomes \" which XML-escapes to &quot;
    expect(body).toContain('&lt;Player&gt;');
    expect(body).toContain('&amp;');
  });
});

describe('XmdsClient - GetWeather', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for GetWeather', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetWeatherResponse>
      <weather>{"temperature":22,"humidity":65,"windSpeed":10,"condition":"Clear","cloudCover":15}</weather>
    </GetWeatherResponse>
  </soap:Body>
</soap:Envelope>`
    });

    await client.getWeather();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=GetWeather',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:GetWeather>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
  });

  it('should return weather data from SOAP response', async () => {
    const weatherJson = '{"temperature":22,"humidity":65,"windSpeed":10,"condition":"Clear","cloudCover":15}';
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetWeatherResponse>
      <weather>${weatherJson}</weather>
    </GetWeatherResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.getWeather();
    expect(result).toBe(weatherJson);
  });

  it('should handle SOAP fault', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Weather service unavailable</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.getWeather()).rejects.toThrow('SOAP Fault: Weather service unavailable');
  });

  it('should handle HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    await expect(client.getWeather()).rejects.toThrow('XMDS GetWeather failed: 500 Internal Server Error');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(client.getWeather()).rejects.toThrow('Network error');
  });
});

describe('XmdsClient - MediaInventory', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = new XmdsClient({
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-server-key',
      hardwareKey: 'test-hardware-key',
      retryOptions: { maxRetries: 0 }
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should build correct SOAP envelope for MediaInventory', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <MediaInventoryResponse>
      <success>true</success>
    </MediaInventoryResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const inventoryXml = '<files><file type="media" id="42" complete="1" md5="abc123" lastChecked="2026-02-10 12:00:00"/></files>';

    await client.mediaInventory(inventoryXml);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cms.example.com/xmds.php?v=5&method=MediaInventory',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8'
        }
      })
    );

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('<tns:MediaInventory>');
    expect(body).toContain('<serverKey xsi:type="xsd:string">test-server-key</serverKey>');
    expect(body).toContain('<hardwareKey xsi:type="xsd:string">test-hardware-key</hardwareKey>');
    expect(body).toContain('<mediaInventory xsi:type="xsd:string">');
  });

  it('should XML-escape inventory content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <MediaInventoryResponse>
      <success>true</success>
    </MediaInventoryResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const inventoryXml = '<files><file type="media" id="42" complete="1"/></files>';

    await client.mediaInventory(inventoryXml);

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('&lt;files&gt;');
    expect(body).toContain('&lt;/files&gt;');
  });

  it('should return the response text on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <MediaInventoryResponse>
      <success>true</success>
    </MediaInventoryResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.mediaInventory('<files></files>');
    expect(result).toBe('true');
  });

  it('should handle SOAP fault', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>Server</faultcode>
      <faultstring>Invalid media inventory format</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`
    });

    await expect(client.mediaInventory('<files></files>'))
      .rejects.toThrow('SOAP Fault: Invalid media inventory format');
  });

  it('should handle HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway'
    });

    await expect(client.mediaInventory('<files></files>'))
      .rejects.toThrow('XMDS MediaInventory failed: 502 Bad Gateway');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    await expect(client.mediaInventory('<files></files>'))
      .rejects.toThrow('Connection refused');
  });

  it('should handle empty inventory', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <MediaInventoryResponse>
      <success>true</success>
    </MediaInventoryResponse>
  </soap:Body>
</soap:Envelope>`
    });

    const result = await client.mediaInventory('<files></files>');
    expect(result).toBe('true');

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('&lt;files&gt;&lt;/files&gt;');
  });
});
