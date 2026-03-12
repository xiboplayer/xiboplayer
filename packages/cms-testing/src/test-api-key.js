#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

async function testApiKey() {
  console.log('\n🔑 Testing Xibo API Access Methods\n');
  console.log('='.repeat(60));

  const cmsUrl = process.env.CMS_URL;
  
  console.log('\n📋 Testing different authentication methods...\n');

  // Method 1: Check if there's a simpler API key auth
  console.log('1️⃣  Method: API Key Header');
  try {
    const response = await fetch(`${cmsUrl}/api/displaygroup`, {
      headers: {
        'X-API-KEY': process.env.CLIENT_ID,
      },
    });
    console.log('   Status:', response.status);
    if (response.ok) {
      const data = await response.json();
      console.log('   ✅ Success! Display groups:', data.data?.length);
      return;
    } else {
      console.log('   ❌ Failed:', await response.text());
    }
  } catch (error) {
    console.log('   ❌ Error:', error.message);
  }

  // Method 2: Try the authorize endpoint differently
  console.log('\n2️⃣  Method: Check authorize endpoint format');
  try {
    const response = await fetch(`${cmsUrl}/api/authorize`, {
      method: 'GET',
    });
    console.log('   Status:', response.status);
    console.log('   Response:', await response.text());
  } catch (error) {
    console.log('   ❌ Error:', error.message);
  }

  // Method 3: Try without authentication to see what error we get
  console.log('\n3️⃣  Method: No auth (to see error message)');
  try {
    const response = await fetch(`${cmsUrl}/api/campaign`);
    console.log('   Status:', response.status);
    const text = await response.text();
    console.log('   Response:', text.substring(0, 200));
  } catch (error) {
    console.log('   ❌ Error:', error.message);
  }

  // Method 4: Check if maybe we can access the applications page
  console.log('\n4️⃣  Checking if we can access CMS web interface...');
  try {
    const response = await fetch(`${cmsUrl}/`);
    console.log('   Status:', response.status);
    console.log('   CMS is accessible:', response.ok ? '✅' : '❌');
  } catch (error) {
    console.log('   ❌ Error:', error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n💡 Recommendations:');
  console.log('   1. Log into CMS web interface: ' + cmsUrl);
  console.log('   2. Go to: Applications (under Admin menu)');
  console.log('   3. Check if OAuth application exists');
  console.log('   4. If exists, DELETE it and create a new one');
  console.log('   5. When creating:');
  console.log('      - Name: Automated Testing');
  console.log('      - Leave "Auth Code" field EMPTY');
  console.log('      - Save and copy NEW credentials');
  console.log('   6. Update .env with the NEW credentials');
}

testApiKey().catch(console.error);
