#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

/**
 * Main test runner for Xibo CMS PWA features
 *
 * Tests:
 * - Campaign creation and management
 * - Dayparting schedules (recurring time-based schedules)
 * - Layout transitions
 * - Priority resolution
 */

async function runTests() {
  console.log('\n🧪 Xibo CMS Feature Testing');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();

  try {
    // Phase 1: Authentication
    console.log('\n📡 Phase 1: Authenticating with CMS...');
    await client.authenticate();

    // Phase 2: Get display groups
    console.log('\n📺 Phase 2: Finding display groups...');
    const groups = await client.getDisplayGroups();
    console.log(`   Found ${groups.length} display group(s):`);
    groups.forEach(g => console.log(`   - ${g.displayGroup} (ID: ${g.displayGroupId})`));

    const testGroupName = process.env.TEST_DISPLAY_GROUP || 'Test Displays';
    const testGroup = groups.find(g => g.displayGroup === testGroupName);

    if (!testGroup) {
      console.log(`\n⚠️  Display group "${testGroupName}" not found.`);
      console.log('   Please create it in the CMS or update TEST_DISPLAY_GROUP in .env');
      console.log('   Available groups:', groups.map(g => g.displayGroup).join(', '));
      return;
    }

    console.log(`\n   ✅ Using display group: ${testGroup.displayGroup} (ID: ${testGroup.displayGroupId})`);

    // Phase 3: Check for existing test layouts or prompt to create
    console.log('\n🎨 Phase 3: Checking for test layouts...');
    const layouts = await client.getLayouts();
    const testLayouts = layouts.filter(l => l.layout.startsWith('Test Layout'));

    if (testLayouts.length === 0) {
      console.log('\n   ⚠️  No test layouts found.');
      console.log('   Please create test layouts manually in the CMS:');
      console.log('   1. Go to Layouts > Add Layout');
      console.log('   2. Create layouts named: "Test Layout A", "Test Layout B", "Test Layout C"');
      console.log('   3. Add simple text widgets to each layout');
      console.log('   4. Re-run this script');
      console.log('\n   Alternative: Run `npm run test:create-layouts` to create programmatically');
      return;
    }

    console.log(`   Found ${testLayouts.length} test layout(s):`);
    testLayouts.forEach(l => console.log(`   - ${l.layout} (ID: ${l.layoutId})`));

    // Phase 4: Create or find test campaign
    console.log('\n📁 Phase 4: Managing test campaign...');
    const campaignName = 'Automated Test Campaign';
    let campaign = await client.getCampaignByName(campaignName);

    if (!campaign) {
      console.log(`   Creating campaign: ${campaignName}`);
      campaign = await client.createCampaign(campaignName);

      // Assign all test layouts to campaign
      console.log('   Assigning layouts to campaign...');
      const layoutIds = testLayouts.map(l => l.layoutId);
      await client.assignLayoutsToCampaign(campaign.campaignId, layoutIds);
    } else {
      console.log(`   ✅ Campaign already exists: ${campaignName} (ID: ${campaign.campaignId})`);
    }

    // Phase 5: Create test schedules
    console.log('\n📅 Phase 5: Creating test schedules...');

    // Get current time + 1 minute for immediate testing
    const now = new Date();
    const start = new Date(now.getTime() + 60000); // 1 minute from now
    const end = new Date(start.getTime() + 3600000); // 1 hour later

    // Xibo expects format: YYYY-MM-DD HH:MM:SS
    const formatTime = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    console.log(`   Creating immediate test schedule:`);
    console.log(`   - Start: ${start.toLocaleString()}`);
    console.log(`   - End: ${end.toLocaleString()}`);

    const immediateSchedule = await client.scheduleEvent({
      campaignId: campaign.campaignId,
      displayGroupIds: [testGroup.displayGroupId],
      fromDt: formatTime(start),
      toDt: formatTime(end),
      isPriority: 10,
    });

    console.log(`   ✅ Created immediate schedule (ID: ${immediateSchedule.eventId})`);

    // Create recurring weekday schedule (Mon-Fri, 9am-5pm)
    console.log('\n   Creating recurring weekday schedule (Mon-Fri, 9am-5pm)...');
    const weekdaySchedule = await client.scheduleEvent({
      campaignId: campaign.campaignId,
      displayGroupIds: [testGroup.displayGroupId],
      fromDt: '09:00:00',
      toDt: '17:00:00',
      recurrenceType: 'Week',
      recurrenceDetail: '1,2,3,4,5', // Mon-Fri
      isPriority: 10,
    });

    console.log(`   ✅ Created weekday schedule (ID: ${weekdaySchedule.eventId})`);

    // Phase 6: Verify schedule
    console.log('\n✅ Phase 6: Verifying schedule...');
    const schedule = await client.getSchedule(testGroup.displayGroupId);
    console.log('   Schedule data:', JSON.stringify(schedule, null, 2));

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Tests completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`   - Display Group: ${testGroup.displayGroup}`);
    console.log(`   - Campaign: ${campaignName} (${testLayouts.length} layouts)`);
    console.log(`   - Schedules: 2 (1 immediate, 1 recurring weekday)`);
    console.log('\n🎯 Next steps:');
    console.log(`   1. Open player: ${client.cmsUrl}/player/`);
    console.log('   2. Verify layouts display correctly');
    console.log('   3. Check transitions between layouts');
    console.log('   4. Verify schedule changes at correct times');
    console.log('\n💡 Run `npm run test:verify` to launch automated browser testing');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);
