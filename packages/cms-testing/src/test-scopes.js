#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

async function testScopes() {
  console.log('\n🔐 Testing API Scopes/Permissions\n');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();

  try {
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    const endpoints = [
      { name: 'Display Groups', fn: () => client.request('/displaygroup') },
      { name: 'Layouts', fn: () => client.request('/layout') },
      { name: 'Campaigns', fn: () => client.request('/campaign') },
      { name: 'Schedule', fn: () => client.request('/schedule') },
      { name: 'Displays', fn: () => client.request('/display') },
      { name: 'Media', fn: () => client.request('/library') },
    ];

    console.log('Testing API endpoints:\n');

    for (const endpoint of endpoints) {
      try {
        const result = await endpoint.fn();
        const count = result.data?.length || result.length || 0;
        console.log(`✅ ${endpoint.name.padEnd(20)} - Accessible (${count} items)`);
      } catch (error) {
        if (error.message.includes('403')) {
          console.log(`❌ ${endpoint.name.padEnd(20)} - Access Denied (403)`);
        } else {
          console.log(`⚠️  ${endpoint.name.padEnd(20)} - Error: ${error.message.substring(0, 50)}`);
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n💡 If you see ❌ Access Denied:');
    console.log('   Go to CMS → Applications → Edit your app');
    console.log('   Make sure these scopes are enabled:');
    console.log('   • campaigns (for campaign management)');
    console.log('   • schedules (for scheduling)');
    console.log('   • layouts (for layouts)');
    console.log('   • displaygroups (for display groups)');
    console.log('   • displays (for display management)');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
  }
}

testScopes().catch(console.error);
