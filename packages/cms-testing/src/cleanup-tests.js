#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

/**
 * Cleanup test campaigns, layouts, and schedules
 */

async function cleanup() {
  console.log('\n🧹 Cleaning up test content...\n');

  const client = new XiboCmsClient();

  try {
    await client.authenticate();

    // Delete test campaigns
    console.log('📁 Removing test campaigns...');
    const campaigns = await client.getCampaigns();
    const testCampaigns = campaigns.filter(c => c.campaign.includes('Test') || c.campaign.includes('Automated'));

    for (const campaign of testCampaigns) {
      console.log(`   Deleting campaign: ${campaign.campaign}`);
      await client.deleteCampaign(campaign.campaignId);
    }

    console.log(`   ✅ Deleted ${testCampaigns.length} campaign(s)`);

    // Note: We don't delete layouts as they might be used elsewhere
    // Uncomment if you want to delete test layouts too:
    /*
    console.log('\n🎨 Removing test layouts...');
    const layouts = await client.getLayouts();
    const testLayouts = layouts.filter(l => l.layout.startsWith('Test Layout'));

    for (const layout of testLayouts) {
      console.log(`   Deleting layout: ${layout.layout}`);
      await client.deleteLayout(layout.layoutId);
    }

    console.log(`   ✅ Deleted ${testLayouts.length} layout(s)`);
    */

    console.log('\n✅ Cleanup complete!');
    console.log('   Note: Schedules are automatically removed when campaigns are deleted');

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  }
}

cleanup().catch(console.error);
