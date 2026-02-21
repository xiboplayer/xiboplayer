/**
 * Shared schedule XML parser used by both RestClient and XmdsClient.
 *
 * Both transports return the same XML structure for the Schedule endpoint,
 * so the parsing logic lives here to avoid duplication.
 */

/**
 * Parse criteria child elements from a layout/overlay element.
 * Criteria are conditions that must be met for the item to display.
 *
 * XML format: <criteria metric="dayOfWeek" condition="equals" type="string">Monday</criteria>
 *
 * @param {Element} parentEl - Parent XML element containing <criteria> children
 * @returns {Array<{metric: string, condition: string, type: string, value: string}>}
 */
function parseCriteria(parentEl) {
  const criteria = [];
  for (const child of parentEl.children) {
    if (child.tagName !== 'criteria') continue;
    criteria.push({
      metric: child.getAttribute('metric') || '',
      condition: child.getAttribute('condition') || '',
      type: child.getAttribute('type') || 'string',
      value: child.textContent || ''
    });
  }
  return criteria;
}

/**
 * Parse Schedule XML response into a normalized schedule object.
 *
 * @param {string} xml - Raw XML string from CMS schedule endpoint
 * @returns {Object} Parsed schedule with default, layouts, campaigns, overlays, actions, commands, dataConnectors
 */
export function parseScheduleResponse(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  const schedule = {
    default: null,
    defaultDependants: [],
    dependants: [], // Global dependants that gate ALL layouts
    layouts: [],
    campaigns: [],
    overlays: [],
    actions: [],
    commands: [],
    dataConnectors: []
  };

  // Parse global dependants (root-level <dependants> — must be cached before any layout plays)
  const scheduleEl = doc.querySelector('schedule');
  if (scheduleEl) {
    const globalDeps = Array.from(scheduleEl.children).filter(
      el => el.tagName === 'dependants'
    );
    for (const depContainer of globalDeps) {
      // Skip if this is nested inside <default>, <layout>, etc.
      if (depContainer.parentElement !== scheduleEl) continue;
      for (const fileEl of depContainer.querySelectorAll('file')) {
        if (fileEl.textContent) schedule.dependants.push(fileEl.textContent);
      }
    }
  }

  const defaultEl = doc.querySelector('default');
  if (defaultEl) {
    schedule.default = defaultEl.getAttribute('file');
    // Parse dependants — files that must be cached before this layout plays
    const defaultDeps = defaultEl.querySelectorAll('dependants > file');
    if (defaultDeps.length > 0) {
      schedule.defaultDependants = [...defaultDeps].map(el => el.textContent);
    }
  }

  // Parse campaigns (groups of layouts with shared priority)
  for (const campaignEl of doc.querySelectorAll('campaign')) {
    const campaign = {
      id: campaignEl.getAttribute('id'),
      priority: parseInt(campaignEl.getAttribute('priority') || '0'),
      fromdt: campaignEl.getAttribute('fromdt'),
      todt: campaignEl.getAttribute('todt'),
      scheduleid: campaignEl.getAttribute('scheduleid'),
      maxPlaysPerHour: parseInt(campaignEl.getAttribute('maxPlaysPerHour') || '0'),
      shareOfVoice: parseInt(campaignEl.getAttribute('shareOfVoice') || '0'),
      isGeoAware: campaignEl.getAttribute('isGeoAware') === '1',
      geoLocation: campaignEl.getAttribute('geoLocation') || '',
      syncEvent: campaignEl.getAttribute('syncEvent') === '1',
      recurrenceType: campaignEl.getAttribute('recurrenceType') || null,
      recurrenceDetail: parseInt(campaignEl.getAttribute('recurrenceDetail') || '0') || null,
      recurrenceRepeatsOn: campaignEl.getAttribute('recurrenceRepeatsOn') || null,
      recurrenceRange: campaignEl.getAttribute('recurrenceRange') || null,
      criteria: parseCriteria(campaignEl),
      layouts: []
    };

    // Parse layouts within this campaign
    for (const layoutEl of campaignEl.querySelectorAll('layout')) {
      const fileId = layoutEl.getAttribute('file');
      const depEls = layoutEl.querySelectorAll('dependants > file');
      campaign.layouts.push({
        id: String(fileId), // Normalized string ID for consistent type usage
        file: fileId,
        // Layouts in campaigns inherit timing from campaign level
        fromdt: layoutEl.getAttribute('fromdt') || campaign.fromdt,
        todt: layoutEl.getAttribute('todt') || campaign.todt,
        scheduleid: campaign.scheduleid,
        priority: campaign.priority, // Priority at campaign level
        campaignId: campaign.id,
        maxPlaysPerHour: parseInt(layoutEl.getAttribute('maxPlaysPerHour') || '0'),
        isGeoAware: layoutEl.getAttribute('isGeoAware') === '1',
        geoLocation: layoutEl.getAttribute('geoLocation') || '',
        syncEvent: layoutEl.getAttribute('syncEvent') === '1',
        shareOfVoice: parseInt(layoutEl.getAttribute('shareOfVoice') || '0'),
        duration: parseInt(layoutEl.getAttribute('duration') || '0'),
        cyclePlayback: layoutEl.getAttribute('cyclePlayback') === '1',
        groupKey: layoutEl.getAttribute('groupKey') || null,
        playCount: parseInt(layoutEl.getAttribute('playCount') || '0'),
        dependants: depEls.length > 0 ? [...depEls].map(el => el.textContent) : [],
        criteria: parseCriteria(layoutEl)
      });
    }

    schedule.campaigns.push(campaign);
  }

  // Parse standalone layouts (not in campaigns)
  for (const layoutEl of doc.querySelectorAll('schedule > layout')) {
    const fileId = layoutEl.getAttribute('file');
    const depEls = layoutEl.querySelectorAll('dependants > file');
    schedule.layouts.push({
      id: String(fileId), // Normalized string ID for consistent type usage
      file: fileId,
      fromdt: layoutEl.getAttribute('fromdt'),
      todt: layoutEl.getAttribute('todt'),
      scheduleid: layoutEl.getAttribute('scheduleid'),
      priority: parseInt(layoutEl.getAttribute('priority') || '0'),
      campaignId: null, // Standalone layout
      maxPlaysPerHour: parseInt(layoutEl.getAttribute('maxPlaysPerHour') || '0'),
      isGeoAware: layoutEl.getAttribute('isGeoAware') === '1',
      geoLocation: layoutEl.getAttribute('geoLocation') || '',
      syncEvent: layoutEl.getAttribute('syncEvent') === '1',
      shareOfVoice: parseInt(layoutEl.getAttribute('shareOfVoice') || '0'),
      duration: parseInt(layoutEl.getAttribute('duration') || '0'),
      cyclePlayback: layoutEl.getAttribute('cyclePlayback') === '1',
      groupKey: layoutEl.getAttribute('groupKey') || null,
      playCount: parseInt(layoutEl.getAttribute('playCount') || '0'),
      recurrenceType: layoutEl.getAttribute('recurrenceType') || null,
      recurrenceDetail: parseInt(layoutEl.getAttribute('recurrenceDetail') || '0') || null,
      recurrenceRepeatsOn: layoutEl.getAttribute('recurrenceRepeatsOn') || null,
      recurrenceRange: layoutEl.getAttribute('recurrenceRange') || null,
      dependants: depEls.length > 0 ? [...depEls].map(el => el.textContent) : [],
      criteria: parseCriteria(layoutEl)
    });
  }

  // Parse overlay layouts (appear on top of main layouts)
  const overlaysContainer = doc.querySelector('overlays');
  if (overlaysContainer) {
    for (const overlayEl of overlaysContainer.querySelectorAll('overlay')) {
      const fileId = overlayEl.getAttribute('file');
      schedule.overlays.push({
        id: String(fileId), // Normalized string ID for consistent type usage
        duration: parseInt(overlayEl.getAttribute('duration') || '60'),
        file: fileId,
        fromdt: overlayEl.getAttribute('fromdt'),
        todt: overlayEl.getAttribute('todt'),
        priority: parseInt(overlayEl.getAttribute('priority') || '0'),
        scheduleid: overlayEl.getAttribute('scheduleid'),
        isGeoAware: overlayEl.getAttribute('isGeoAware') === '1',
        geoLocation: overlayEl.getAttribute('geoLocation') || '',
        syncEvent: overlayEl.getAttribute('syncEvent') === '1',
        maxPlaysPerHour: parseInt(overlayEl.getAttribute('maxPlaysPerHour') || '0'),
        recurrenceType: overlayEl.getAttribute('recurrenceType') || null,
        recurrenceDetail: parseInt(overlayEl.getAttribute('recurrenceDetail') || '0') || null,
        recurrenceRepeatsOn: overlayEl.getAttribute('recurrenceRepeatsOn') || null,
        recurrenceRange: overlayEl.getAttribute('recurrenceRange') || null,
        criteria: parseCriteria(overlayEl)
      });
    }
  }

  // Parse action events (scheduled triggers)
  const actionsContainer = doc.querySelector('actions');
  if (actionsContainer) {
    for (const actionEl of actionsContainer.querySelectorAll('action')) {
      schedule.actions.push({
        actionType: actionEl.getAttribute('actionType') || '',
        triggerCode: actionEl.getAttribute('triggerCode') || '',
        layoutCode: actionEl.getAttribute('layoutCode') || '',
        commandCode: actionEl.getAttribute('commandCode') || '',
        duration: parseInt(actionEl.getAttribute('duration') || '0'),
        fromdt: actionEl.getAttribute('fromdt'),
        todt: actionEl.getAttribute('todt'),
        priority: parseInt(actionEl.getAttribute('priority') || '0'),
        scheduleid: actionEl.getAttribute('scheduleid'),
        isGeoAware: actionEl.getAttribute('isGeoAware') === '1',
        geoLocation: actionEl.getAttribute('geoLocation') || ''
      });
    }
  }

  // Parse server commands (remote control)
  for (const cmdEl of doc.querySelectorAll('schedule > command')) {
    schedule.commands.push({
      code: cmdEl.getAttribute('code') || '',
      date: cmdEl.getAttribute('date') || ''
    });
  }

  // Parse data connectors (real-time data sources for widgets)
  // Spec: <dataConnectors><connector dataSetId="" dataParams="" js=""/></dataConnectors>
  const dataConnectorsContainer = doc.querySelector('dataConnectors');
  if (dataConnectorsContainer) {
    for (const dcEl of dataConnectorsContainer.querySelectorAll('connector')) {
      schedule.dataConnectors.push({
        id: dcEl.getAttribute('id') || '',
        dataConnectorId: dcEl.getAttribute('dataConnectorId') || '',
        dataSetId: dcEl.getAttribute('dataSetId') || '',
        dataKey: dcEl.getAttribute('dataKey') || '',
        dataParams: dcEl.getAttribute('dataParams') || '',
        js: dcEl.getAttribute('js') || '',
        url: dcEl.getAttribute('url') || '',
        updateInterval: parseInt(dcEl.getAttribute('updateInterval') || '300', 10)
      });
    }
  }

  return schedule;
}
