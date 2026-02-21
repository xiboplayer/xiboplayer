/**
 * Schedule Parser Tests
 *
 * Tests for XML parsing of schedule responses, ensuring all attributes
 * are correctly extracted — especially recurrence/dayparting fields.
 */

import { describe, it, expect } from 'vitest';
import { parseScheduleResponse } from './schedule-parser.js';

describe('parseScheduleResponse', () => {
  it('should parse default layout', () => {
    const xml = '<schedule><default file="100.xlf"/></schedule>';
    const result = parseScheduleResponse(xml);
    expect(result.default).toBe('100.xlf');
  });

  it('should parse standalone layout with basic attributes', () => {
    const xml = `<schedule>
      <layout file="200.xlf" fromdt="2025-01-01 09:00:00" todt="2025-12-31 17:00:00"
              scheduleid="5" priority="3"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.layouts).toHaveLength(1);
    expect(result.layouts[0].file).toBe('200.xlf');
    expect(result.layouts[0].priority).toBe(3);
    expect(result.layouts[0].scheduleid).toBe('5');
  });

  it('should parse recurrence attributes on standalone layouts', () => {
    const xml = `<schedule>
      <layout file="300.xlf" fromdt="2025-01-06 09:00:00" todt="2025-01-06 17:00:00"
              scheduleid="10" priority="1"
              recurrenceType="Week"
              recurrenceRepeatsOn="1,2,3,4,5"
              recurrenceRange="2025-12-31 23:59:59"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    const layout = result.layouts[0];

    expect(layout.recurrenceType).toBe('Week');
    expect(layout.recurrenceRepeatsOn).toBe('1,2,3,4,5');
    expect(layout.recurrenceRange).toBe('2025-12-31 23:59:59');
  });

  it('should set recurrence fields to null when absent', () => {
    const xml = `<schedule>
      <layout file="400.xlf" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
              scheduleid="20" priority="0"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    const layout = result.layouts[0];

    expect(layout.recurrenceType).toBeNull();
    expect(layout.recurrenceRepeatsOn).toBeNull();
    expect(layout.recurrenceRange).toBeNull();
  });

  it('should parse recurrence attributes on campaigns', () => {
    const xml = `<schedule>
      <campaign id="c1" priority="5" fromdt="2025-01-06 08:00:00" todt="2025-01-06 18:00:00"
                scheduleid="30"
                recurrenceType="Week"
                recurrenceRepeatsOn="6,7">
        <layout file="500.xlf"/>
        <layout file="501.xlf"/>
      </campaign>
    </schedule>`;
    const result = parseScheduleResponse(xml);

    expect(result.campaigns).toHaveLength(1);
    const campaign = result.campaigns[0];
    expect(campaign.recurrenceType).toBe('Week');
    expect(campaign.recurrenceRepeatsOn).toBe('6,7');
    expect(campaign.recurrenceRange).toBeNull();
    expect(campaign.layouts).toHaveLength(2);
  });

  it('should parse recurrence attributes on overlays', () => {
    const xml = `<schedule>
      <overlays>
        <overlay file="600.xlf" fromdt="2025-01-01 12:00:00" todt="2025-01-01 13:00:00"
                 scheduleid="40" priority="2" duration="30"
                 recurrenceType="Week"
                 recurrenceRepeatsOn="1,3,5"/>
      </overlays>
    </schedule>`;
    const result = parseScheduleResponse(xml);

    expect(result.overlays).toHaveLength(1);
    const overlay = result.overlays[0];
    expect(overlay.recurrenceType).toBe('Week');
    expect(overlay.recurrenceRepeatsOn).toBe('1,3,5');
    expect(overlay.recurrenceRange).toBeNull();
  });

  it('should parse criteria on layouts', () => {
    const xml = `<schedule>
      <layout file="700.xlf" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
              scheduleid="50" priority="1">
        <criteria metric="dayOfWeek" condition="equals" type="string">Monday</criteria>
      </layout>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    const layout = result.layouts[0];

    expect(layout.criteria).toHaveLength(1);
    expect(layout.criteria[0].metric).toBe('dayOfWeek');
    expect(layout.criteria[0].condition).toBe('equals');
    expect(layout.criteria[0].value).toBe('Monday');
  });
});
