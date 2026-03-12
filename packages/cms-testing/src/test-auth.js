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

async function testAuth() {
  console.log('\n🔐 Testing OAuth Authentication\n');
  console.log('='.repeat(60));

  const cmsUrl = process.env.CMS_URL;
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  console.log('\n📋 Configuration:');
  console.log('   CMS URL:', cmsUrl);
  console.log('   Client ID:', clientId);
  console.log('   Client Secret:', clientSecret ? `${clientSecret.substring(0, 20)}...` : 'NOT SET');

  if (!clientId || !clientSecret || clientId.includes('your_') || clientSecret.includes('your_')) {
    console.log('\n❌ Error: OAuth credentials not configured!');
    console.log('\nYou need to:');
    console.log(`1. Open ${process.env.CMS_URL || 'your CMS URL'}`);
    console.log('2. Go to Applications menu');
    console.log('3. Add Application (or check if one exists)');
    console.log('4. Copy Client ID and Client Secret to .env file');
    return;
  }

  const authUrl = `${cmsUrl}/api/authorize/access_token`;
  console.log('\n🔗 Auth endpoint:', authUrl);

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  console.log('\n📤 Sending authentication request...');
  console.log('   Grant type: client_credentials');

  try {
    const response = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    console.log('\n📥 Response:');
    console.log('   Status:', response.status, response.statusText);
    console.log('   Headers:', Object.fromEntries(response.headers.entries()));

    const responseText = await response.text();
    console.log('   Body:', responseText);

    if (!response.ok) {
      console.log('\n❌ Authentication failed!');
      
      try {
        const errorData = JSON.parse(responseText);
        console.log('\n📋 Error details:');
        console.log('   Error:', errorData.error);
        console.log('   Description:', errorData.error_description);
        console.log('   Message:', errorData.message);

        if (errorData.error === 'invalid_client') {
          console.log('\n💡 Troubleshooting "invalid_client":');
          console.log('   • Check if OAuth application exists in CMS');
          console.log('   • Verify Client ID and Secret match exactly');
          console.log('   • Try creating a new OAuth application');
          console.log('   • Check CMS logs for more details');
        }
      } catch (e) {
        console.log('\n   Could not parse error response');
      }

      return;
    }

    const data = JSON.parse(responseText);
    console.log('\n✅ Authentication successful!');
    console.log('   Access token:', data.access_token.substring(0, 30) + '...');
    console.log('   Token type:', data.token_type);
    console.log('   Expires in:', data.expires_in, 'seconds');

    // Test using the token
    console.log('\n🧪 Testing token with API call...');
    const testResponse = await fetch(`${cmsUrl}/api/displaygroup`, {
      headers: {
        'Authorization': `Bearer ${data.access_token}`,
      },
    });

    console.log('   Status:', testResponse.status);
    
    if (testResponse.ok) {
      const testData = await testResponse.json();
      console.log('   ✅ API call successful!');
      console.log('   Display groups found:', testData.data?.length || 0);
    } else {
      console.log('   ❌ API call failed');
      console.log('   Response:', await testResponse.text());
    }

  } catch (error) {
    console.error('\n❌ Request failed:', error.message);
    console.error('   Stack:', error.stack);
  }

  console.log('\n' + '='.repeat(60));
}

testAuth().catch(console.error);
