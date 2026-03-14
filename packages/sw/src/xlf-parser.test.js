// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect } from 'vitest';
import { extractMediaIdsFromXlf } from './xlf-parser.js';

describe('extractMediaIdsFromXlf', () => {
  it('extracts fileId from media tags', () => {
    const xlf = `
      <layout width="1920" height="1080">
        <region id="1">
          <media id="10" type="image" fileId="42" />
          <media id="11" type="video" fileId="99" />
        </region>
      </layout>
    `;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has('42')).toBe(true);
    expect(ids.has('99')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('extracts widget id when no fileId (data widgets)', () => {
    const xlf = `
      <layout width="1920" height="1080">
        <region id="1">
          <media id="55" type="ticker" />
        </region>
      </layout>
    `;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids.has('55')).toBe(true);
  });

  it('extracts background attribute from layout tag', () => {
    const xlf = `<layout width="1920" height="1080" background="77"></layout>`;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids.has('77')).toBe(true);
  });

  it('combines all sources', () => {
    const xlf = `
      <layout width="1920" height="1080" background="1">
        <region id="1">
          <media id="10" type="image" fileId="2" />
          <media id="20" type="ticker" />
        </region>
      </layout>
    `;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids.size).toBe(3); // background=1, fileId=2, widget=20
    expect(ids.has('1')).toBe(true);
    expect(ids.has('2')).toBe(true);
    expect(ids.has('20')).toBe(true);
  });

  it('returns empty set for XLF with no media', () => {
    const xlf = `<layout width="1920" height="1080"></layout>`;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids.size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    const ids = extractMediaIdsFromXlf('');
    expect(ids.size).toBe(0);
  });

  it('deduplicates IDs', () => {
    const xlf = `
      <layout width="1920" height="1080">
        <region id="1"><media id="10" type="image" fileId="42" /></region>
        <region id="2"><media id="11" type="image" fileId="42" /></region>
      </layout>
    `;
    const ids = extractMediaIdsFromXlf(xlf);
    expect(ids.size).toBe(1);
  });
});
