#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

/**
 * Debug script to test API connectivity and see what's in the CMS
 */

async function debug() {
  console.log('\n🔍 Debugging CMS API Connection\n');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();

  try {
    // Test 1: Authentication
    console.log('\n1️⃣  Testing Authentication...');
    await client.authenticate();
    console.log('   ✅ Authentication successful');
    console.log('   Token:', client.accessToken.substring(0, 20) + '...');

    // Test 2: Raw API request
    console.log('\n2️⃣  Testing raw API requests...');
    const response = await client.request('/displaygroup');
    console.log('   ✅ API responding');
    console.log('   Response keys:', Object.keys(response));

    // Test 3: Display Groups
    console.log('\n3️⃣  Listing Display Groups...');
    const groups = await client.getDisplayGroups();
    console.log(`   Found ${groups.length} display group(s):`);
    groups.forEach(g => {
      console.log(`   - "${g.displayGroup}" (ID: ${g.displayGroupId})`);
    });

    // Test 4: Layouts
    console.log('\n4️⃣  Listing Layouts...');
    const layouts = await client.getLayouts();
    console.log(`   Found ${layouts.length} layout(s):`);
    const testLayouts = layouts.filter(l => l.layout && l.layout.includes('Test'));
    if (testLayouts.length > 0) {
      console.log('   Test layouts:');
      testLayouts.forEach(l => {
        console.log(`   - "${l.layout}" (ID: ${l.layoutId}, Owner: ${l.owner})`);
      });
    } else {
      console.log('   ⚠️  No layouts with "Test" in name found');
      console.log('   All layouts:');
      layouts.slice(0, 5).forEach(l => {
        console.log(`   - "${l.layout}" (ID: ${l.layoutId})`);
      });
      if (layouts.length > 5) {
        console.log(`   ... and ${layouts.length - 5} more`);
      }
    }

    // Test 5: Campaigns
    console.log('\n5️⃣  Listing Campaigns...');
    const campaigns = await client.getCampaigns();
    console.log(`   Found ${campaigns.length} campaign(s):`);
    if (campaigns.length > 0) {
      campaigns.forEach(c => {
        console.log(`   - "${c.campaign}" (ID: ${c.campaignId}, Layouts: ${c.numberLayouts || 0})`);
      });
    } else {
      console.log('   ⚠️  No campaigns found');
    }

    // Test 6: Try creating a campaign
    console.log('\n6️⃣  Testing Campaign Creation...');
    const testCampaignName = `DEBUG Test Campaign ${Date.now()}`;
    console.log(`   Creating campaign: "${testCampaignName}"`);
    
    try {
      const newCampaign = await client.createCampaign(testCampaignName);
      console.log('   ✅ Campaign created successfully!');
      console.log('   Response:', JSON.stringify(newCampaign, null, 2));

      // Verify it appears in list
      console.log('\n   Verifying campaign appears in CMS...');
      const updatedCampaigns = await client.getCampaigns();
      const found = updatedCampaigns.find(c => c.campaign === testCampaignName);
      
      if (found) {
        console.log('   ✅ Campaign found in list!');
        console.log('   Campaign details:', JSON.stringify(found, null, 2));
      } else {
        console.log('   ❌ Campaign NOT found in list after creation');
        console.log('   All campaigns:', updatedCampaigns.map(c => c.campaign));
      }

      // Clean up
      console.log('\n   Cleaning up test campaign...');
      await client.deleteCampaign(newCampaign.campaignId);
      console.log('   ✅ Test campaign deleted');

    } catch (error) {
      console.error('   ❌ Campaign creation failed:', error.message);
      if (error.stack) {
        console.error('   Stack:', error.stack);
      }
    }

    // Test 7: Check API endpoint format
    console.log('\n7️⃣  Checking API endpoint format...');
    console.log('   CMS URL:', client.cmsUrl);
    console.log('   Campaign endpoint:', `${client.cmsUrl}/api/campaign`);
    console.log('   Display group endpoint:', `${client.cmsUrl}/api/displaygroup`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ Debug complete!');

  } catch (error) {
    console.error('\n❌ Debug failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

debug().catch(console.error);
