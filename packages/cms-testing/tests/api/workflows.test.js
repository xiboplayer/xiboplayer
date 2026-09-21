/**
 * API Integration Tests: Full Workflow Pipelines
 *
 * End-to-end API workflows: create content → schedule → verify → cleanup
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestHelper } from '../../src/cms-test-helper.js';

describe('Full Workflows', () => {
  const helper = createTestHelper();

  beforeAll(async () => {
    await helper.setup();
  });

  afterAll(async () => {
    await helper.teardown();
  });

  it('should complete the full pipeline: layout → campaign → schedule → cleanup', async () => {
    if (!helper.testDisplay) {
      console.log('Skipping: no test display configured');
      return;
    }

    // 1. Create layout with text widget
    const { layoutId, widgetId } = await helper.createSimpleLayout({
      name: `Pipeline Test ${Date.now()}`,
      widgetType: 'text',
      widgetProps: {
        text: '<h1 style="color: #2196F3; text-align: center;">Pipeline Test Active</h1>',
        duration: 30
      }
    });

    expect(layoutId).toBeGreaterThan(0);
    expect(widgetId).toBeDefined();

    // 2. Create campaign and assign layout
    const campaignId = await helper.createCampaignWithLayouts(
      `Pipeline Campaign ${Date.now()}`,
      [layoutId]
    );

    expect(campaignId).toBeGreaterThan(0);

    // 3. Schedule on test display
    const eventId = await helper.scheduleOnTestDisplay(campaignId);

    expect(eventId).toBeDefined();

    // 4. Verify the layout is retrievable
    const layouts = await helper.getApi().listLayouts({ layoutId });

    expect(layouts.length).toBe(1);
    expect(layouts[0].layoutId).toBe(layoutId);

    // Teardown handles cleanup automatically
  });

  it('should create a multi-region layout with different widget types', async () => {
    const result = await helper.createMultiRegionLayout({
      name: `Multi-Region ${Date.now()}`,
      regions: [
        {
          width: 960, height: 1080, top: 0, left: 0,
          widgetType: 'text',
          widgetProps: { text: '<h2>Left Panel</h2>', duration: 10 }
        },
        {
          width: 960, height: 1080, top: 0, left: 960,
          widgetType: 'text',
          widgetProps: { text: '<h2>Right Panel</h2>', duration: 10 }
        }
      ]
    });

    expect(result.layoutId).toBeGreaterThan(0);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0].widgetId).toBeDefined();
    expect(result.regions[1].widgetId).toBeDefined();
  });

  it('should create a campaign with 3 layouts for rotation', async () => {
    const layouts = [];

    for (let i = 1; i <= 3; i++) {
      const result = await helper.createSimpleLayout({
        name: `Rotation ${i} ${Date.now()}`,
        widgetProps: { text: `<h1>Layout ${i}</h1>`, duration: 10 }
      });
      layouts.push(result.layoutId);
    }

    const campaignId = await helper.createCampaignWithLayouts(
      `Rotation Campaign ${Date.now()}`,
      layouts
    );

    expect(campaignId).toBeGreaterThan(0);
  });

  it('should handle layout background editing', async () => {
    const api = helper.getApi();

    const layout = await api.createLayout({
      name: `Background Test ${Date.now()}`,
      resolutionId: helper.defaultResolutionId
    });
    helper.track('layout', layout.layoutId);

    // Xibo v4: find auto-created draft (editable copy)
    const draft = await api.getDraftLayout(layout.layoutId);
    const draftId = draft?.layoutId || layout.layoutId;

    // Edit background color on the draft (backgroundColor and backgroundzIndex
    // are the fields the Xibo API docs mark required, but the controller also
    // dereferences resolutionId unconditionally — without it the CMS 500s in
    // ResolutionFactory::getById() before it ever reads backgroundColor).
    const updated = await api.editLayoutBackground(draftId, {
      backgroundColor: '#FF5722',
      backgroundzIndex: 0,
      resolutionId: draft?.resolutionId || helper.defaultResolutionId
    });

    // The edit returns the updated layout — verify the change took effect
    expect(updated).toHaveProperty('layoutId', draftId);
    expect(updated.backgroundColor).toBe('#FF5722');
  });
});
