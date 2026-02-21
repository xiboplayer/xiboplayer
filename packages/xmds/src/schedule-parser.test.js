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

  it('should parse dependants on default layout', () => {
    const xml = `<schedule>
      <default file="100.xlf">
        <dependants><file>bg.jpg</file><file>logo.png</file></dependants>
      </default>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.default).toBe('100.xlf');
    expect(result.defaultDependants).toEqual(['bg.jpg', 'logo.png']);
  });

  it('should parse dependants on standalone layouts', () => {
    const xml = `<schedule>
      <layout file="200.xlf" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
              scheduleid="5" priority="1">
        <dependants><file>video.mp4</file></dependants>
      </layout>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.layouts[0].dependants).toEqual(['video.mp4']);
  });

  it('should parse dependants on campaign layouts', () => {
    const xml = `<schedule>
      <campaign id="c1" priority="5" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
                scheduleid="30">
        <layout file="300.xlf">
          <dependants><file>font.woff2</file></dependants>
        </layout>
      </campaign>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.campaigns[0].layouts[0].dependants).toEqual(['font.woff2']);
  });

  it('should return empty array when no dependants', () => {
    const xml = `<schedule>
      <layout file="400.xlf" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
              scheduleid="20" priority="0"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.layouts[0].dependants).toEqual([]);
  });

  it('should parse duration, cyclePlayback, groupKey, playCount on standalone layouts', () => {
    const xml = `<schedule>
      <layout file="500.xlf" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
              scheduleid="60" priority="1" duration="120"
              cyclePlayback="1" groupKey="group-A" playCount="3"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    const layout = result.layouts[0];
    expect(layout.duration).toBe(120);
    expect(layout.cyclePlayback).toBe(true);
    expect(layout.groupKey).toBe('group-A');
    expect(layout.playCount).toBe(3);
  });

  it('should parse command code attribute correctly', () => {
    const xml = `<schedule>
      <command code="collectNow" date="2026-01-01"/>
      <command code="reboot" date="2026-01-02"/>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0].code).toBe('collectNow');
    expect(result.commands[1].code).toBe('reboot');
  });

  it('should parse dataConnectors with connector child elements', () => {
    const xml = `<schedule>
      <dataConnectors>
        <connector id="dc1" dataSetId="42" dataParams="limit=10" js="render.js"
                   url="http://cms.example.com/data" updateInterval="60"/>
      </dataConnectors>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.dataConnectors).toHaveLength(1);
    expect(result.dataConnectors[0].id).toBe('dc1');
    expect(result.dataConnectors[0].dataSetId).toBe('42');
    expect(result.dataConnectors[0].dataParams).toBe('limit=10');
    expect(result.dataConnectors[0].js).toBe('render.js');
    expect(result.dataConnectors[0].url).toBe('http://cms.example.com/data');
    expect(result.dataConnectors[0].updateInterval).toBe(60);
  });

  it('should return empty dataConnectors when no dataConnectors element', () => {
    const xml = '<schedule><default file="0"/></schedule>';
    const result = parseScheduleResponse(xml);
    expect(result.dataConnectors).toEqual([]);
  });

  it('should parse global dependants from schedule root', () => {
    const xml = `<schedule>
      <default file="0"/>
      <dependants><file>global-font.woff2</file><file>shared-bg.jpg</file></dependants>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.dependants).toEqual(['global-font.woff2', 'shared-bg.jpg']);
  });

  it('should default global dependants to empty array', () => {
    const xml = '<schedule><default file="0"/></schedule>';
    const result = parseScheduleResponse(xml);
    expect(result.dependants).toEqual([]);
  });

  it('should parse campaign-level geo/sync/shareOfVoice attributes', () => {
    const xml = `<schedule>
      <campaign id="c1" priority="5" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
                scheduleid="30" shareOfVoice="50" isGeoAware="1"
                geoLocation="51.5,-0.1" syncEvent="1">
        <layout file="500.xlf"/>
      </campaign>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    const campaign = result.campaigns[0];
    expect(campaign.shareOfVoice).toBe(50);
    expect(campaign.isGeoAware).toBe(true);
    expect(campaign.geoLocation).toBe('51.5,-0.1');
    expect(campaign.syncEvent).toBe(true);
  });

  it('should parse criteria on campaigns', () => {
    const xml = `<schedule>
      <campaign id="c1" priority="5" fromdt="2025-01-01 00:00:00" todt="2025-12-31 23:59:59"
                scheduleid="30">
        <criteria metric="temperature" condition="gt" type="number">25</criteria>
        <layout file="500.xlf"/>
      </campaign>
    </schedule>`;
    const result = parseScheduleResponse(xml);
    expect(result.campaigns[0].criteria).toHaveLength(1);
    expect(result.campaigns[0].criteria[0].metric).toBe('temperature');
    expect(result.campaigns[0].criteria[0].value).toBe('25');
  });
});
