// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Tests for XMDS overlay parsing
 *
 * Tests that overlays are correctly parsed from Schedule XML response
 */

import { describe, it, expect } from 'vitest';
import { parseScheduleResponse } from './schedule-parser.js';

describe('Schedule Parsing - Overlays', () => {
  describe('parseScheduleResponse()', () => {
    it('should parse overlays from Schedule XML', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <default file="1.xlf"/>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays).toBeDefined();
      expect(schedule.overlays.length).toBe(1);
      expect(schedule.overlays[0].file).toBe('101.xlf');
      expect(schedule.overlays[0].duration).toBe(60);
      expect(schedule.overlays[0].priority).toBe(10);
      expect(schedule.overlays[0].fromdt).toBe('2026-01-01 00:00:00');
      expect(schedule.overlays[0].todt).toBe('2026-12-31 23:59:59');
    });

    it('should parse multiple overlays', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <default file="1.xlf"/>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
    <overlay duration="30" file="102.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="5" scheduleid="556" isGeoAware="0" geoLocation=""/>
    <overlay duration="120" file="103.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="20" scheduleid="557" isGeoAware="1" geoLocation="location-1"/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays.length).toBe(3);
      expect(schedule.overlays[0].file).toBe('101.xlf');
      expect(schedule.overlays[1].file).toBe('102.xlf');
      expect(schedule.overlays[2].file).toBe('103.xlf');
    });

    it('should parse geo-aware overlay', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="1" geoLocation="geo-fence-1"/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays[0].isGeoAware).toBe(true);
      expect(schedule.overlays[0].geoLocation).toBe('geo-fence-1');
    });

    it('should handle overlays with no geo-awareness', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays[0].isGeoAware).toBe(false);
      expect(schedule.overlays[0].geoLocation).toBe('');
    });

    it('should handle schedule with no overlays element', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <default file="1.xlf"/>
  <layout file="2.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" scheduleid="123" priority="0"/>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays).toBeDefined();
      expect(schedule.overlays.length).toBe(0);
    });

    it('should handle empty overlays element', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <default file="1.xlf"/>
  <overlays></overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays).toBeDefined();
      expect(schedule.overlays.length).toBe(0);
    });

    it('should parse overlay priorities correctly', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="100" scheduleid="555" isGeoAware="0" geoLocation=""/>
    <overlay duration="60" file="102.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="0" scheduleid="556" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays[0].priority).toBe(100);
      expect(schedule.overlays[1].priority).toBe(0);
    });

    it('should combine overlays with regular layouts and campaigns', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <default file="1.xlf"/>
  <layout file="2.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" scheduleid="123" priority="5"/>
  <campaign id="1" priority="10" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" scheduleid="456">
    <layout file="3.xlf"/>
    <layout file="4.xlf"/>
  </campaign>
  <overlays>
    <overlay duration="60" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.default).toBe('1.xlf');
      expect(schedule.layouts.length).toBe(1);
      expect(schedule.campaigns.length).toBe(1);
      expect(schedule.overlays.length).toBe(1);
    });

    it('should parse overlay durations correctly', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <overlays>
    <overlay duration="30" file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
    <overlay duration="120" file="102.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="5" scheduleid="556" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays[0].duration).toBe(30);
      expect(schedule.overlays[1].duration).toBe(120);
    });

    it('should use default duration if not specified', () => {
      const xml = `<?xml version="1.0"?>
<schedule>
  <overlays>
    <overlay file="101.xlf" fromdt="2026-01-01 00:00:00" todt="2026-12-31 23:59:59" priority="10" scheduleid="555" isGeoAware="0" geoLocation=""/>
  </overlays>
</schedule>`;

      const schedule = parseScheduleResponse(xml);

      expect(schedule.overlays[0].duration).toBe(60); // Default
    });
  });
});
