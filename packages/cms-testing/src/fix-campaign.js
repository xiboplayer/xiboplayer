#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

async function fixCampaign() {
  console.log('\n🔧 Fixing Campaign and Schedule\n');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();
  await client.authenticate();

  // Get campaign
  const campaign = await client.getCampaignByName('Automated Test Campaign');
  console.log('\n📁 Campaign:', campaign.campaign, '(ID:', campaign.campaignId + ')');
  console.log('   Current layouts:', campaign.numberLayouts || 0);

  // Get test layouts
  const layouts = await client.getLayouts();
  const testLayouts = layouts.filter(l => l.layout && l.layout.startsWith('Test Layout'));
  console.log('\n🎨 Test layouts found:', testLayouts.length);
  testLayouts.forEach(l => console.log('   -', l.layout, '(ID:', l.layoutId + ')'));

  // Assign layouts to campaign
  console.log('\n📌 Assigning layouts to campaign...');
  for (let i = 0; i < testLayouts.length; i++) {
    try {
      await client.assignLayoutToCampaign(campaign.campaignId, testLayouts[i].layoutId, i + 1);
    } catch (error) {
      console.log('   Note:', error.message);
    }
  }

  // Verify
  const updatedCampaign = await client.getCampaignByName('Automated Test Campaign');
  console.log('\n✅ Updated campaign layouts:', updatedCampaign.numberLayouts || 0);

  // Create new schedule
  console.log('\n📅 Creating new schedule...');
  const group = await client.getDisplayGroupByName('Test Displays');
  
  const now = new Date();
  const start = new Date(now.getTime() + 60000); // 1 minute from now
  const end = new Date(start.getTime() + 7200000); // 2 hours later

  const formatTime = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  console.log('   Start:', formatTime(start));
  console.log('   End:', formatTime(end));
  console.log('   Display Group:', group.displayGroup, '(ID:', group.displayGroupId + ')');

  const schedule = await client.scheduleEvent({
    campaignId: campaign.campaignId,
    displayGroupIds: [group.displayGroupId],
    fromDt: formatTime(start),
    toDt: formatTime(end),
    isPriority: 10,
  });

  console.log('\n✅ Schedule created (ID:', schedule.eventId + ')');
  console.log('\n' + '='.repeat(60));
  console.log('✅ Campaign fixed!');
  console.log('\n📋 Summary:');
  console.log('   - Campaign ID:', campaign.campaignId);
  console.log('   - Layouts:', testLayouts.length);
  console.log('   - Schedule starts in:', '~1 minute');
  console.log('   - Duration:', '2 hours');
  console.log('\n🎯 Refresh the player in 1 minute to see the campaign!');
}

fixCampaign().catch(console.error);
