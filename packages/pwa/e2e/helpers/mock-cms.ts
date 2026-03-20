// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * CMS response mocking utilities for Playwright tests.
 *
 * Intercepts XMDS SOAP requests at /xmds-proxy and returns canned responses.
 * Also intercepts REST API v2 requests for protocol auto-detection.
 *
 * Config injection is handled by the test proxy server (see test-server.js),
 * which passes pwaConfig to the proxy's startServer().
 */
import type { Page, Route } from '@playwright/test';

/** SOAP envelope wrapper */
function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

/** RegisterDisplay READY response */
function registerDisplayResponse(displayName: string): string {
  return soapEnvelope(`
    <RegisterDisplayResponse xmlns="urn:xmds">
      <RegisterDisplayResult><![CDATA[<display status="0" code="READY" message="Display is active and ready to start."
        version="4" localDate="2026-03-20 12:00:00"
        displayName="${displayName}"
        screenShotRequested="0"
        screenShotSize="200"
        maxConcurrentDownloads="2"
        collectInterval="900"
        xmrChannel="test-channel"
        xmrPubUrl=""
        latitude="0.0" longitude="0.0"
        />]]></RegisterDisplayResult>
    </RegisterDisplayResponse>`);
}

/** RequiredFiles -- empty (no files to download) */
function requiredFilesResponse(): string {
  return soapEnvelope(`
    <RequiredFilesResponse xmlns="urn:xmds">
      <RequiredFilesResult><![CDATA[<files></files>]]></RequiredFilesResult>
    </RequiredFilesResponse>`);
}

/** Schedule -- single default layout (layoutId=1) */
function scheduleResponse(): string {
  return soapEnvelope(`
    <ScheduleResponse xmlns="urn:xmds">
      <ScheduleResult><![CDATA[<schedule>
        <default file="1.xlf" />
      </schedule>]]></ScheduleResult>
    </ScheduleResponse>`);
}

/** Minimal XLF layout with a single clock widget */
export const TEST_LAYOUT_XLF = `<?xml version="1.0" encoding="UTF-8"?>
<layout schemaVersion="3" width="1920" height="1080" background="#000000"
        layoutId="1" status="1" duration="10">
  <region id="r1" width="1920" height="1080" top="0" left="0">
    <media id="w1" type="clock" duration="10" render="native">
      <options>
        <theme>1</theme>
        <format>[HH:mm:ss]</format>
      </options>
    </media>
  </region>
</layout>`;

/**
 * Extract the SOAP action from a request body.
 * Handles both `<RegisterDisplay xmlns="urn:xmds"` and `<tns:RegisterDisplay>` formats.
 */
export function extractAction(body: string): string | null {
  // Try tns-prefixed format: <tns:RegisterDisplay>
  const prefixed = body.match(/<tns:(\w+)>/);
  if (prefixed) return prefixed[1];
  // Fallback: <RegisterDisplay xmlns="urn:xmds"
  const direct = body.match(/<(\w+)\s+xmlns="urn:xmds"/);
  return direct ? direct[1] : null;
}

/**
 * Install CMS mock routes on a Playwright page.
 * Intercepts /xmds-proxy (SOAP) and /api/v2 (REST) requests.
 */
export async function mockCms(page: Page, options?: { displayName?: string }) {
  const displayName = options?.displayName ?? 'Test Display';

  // Mock XMDS SOAP proxy -- match URL path, ignore query params
  await page.route((url) => url.pathname === '/xmds-proxy', async (route: Route) => {
    const body = route.request().postData() ?? '';
    const action = extractAction(body);

    let response: string;
    switch (action) {
      case 'RegisterDisplay':
        response = registerDisplayResponse(displayName);
        break;
      case 'RequiredFiles':
        response = requiredFilesResponse();
        break;
      case 'Schedule':
        response = scheduleResponse();
        break;
      case 'SubmitStats':
      case 'SubmitLog':
      case 'MediaInventory':
      case 'NotifyStatus':
      case 'ReportFaults':
        response = soapEnvelope(`<${action}Response xmlns="urn:xmds"><${action}Result>true</${action}Result></${action}Response>`);
        break;
      default:
        response = soapEnvelope(`<GenericResponse xmlns="urn:xmds"><Result>ok</Result></GenericResponse>`);
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/xml; charset=utf-8',
      body: response,
    });
  });

  // Mock REST API v2 probe (returns 404 so player falls back to SOAP)
  await page.route('**/api/v2/player/**', async (route: Route) => {
    await route.fulfill({ status: 404, body: 'Not found' });
  });

  // Mock layout XLF file request
  await page.route('**/player/api/layouts/1', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: TEST_LAYOUT_XLF,
    });
  });
}
