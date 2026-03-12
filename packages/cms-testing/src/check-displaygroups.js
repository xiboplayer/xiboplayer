#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

async function check() {
  const client = new XiboCmsClient();
  await client.authenticate();
  
  console.log('\n🔍 Checking Display Groups API Response\n');
  
  const response = await client.request('/displaygroup');
  console.log('Raw response:', JSON.stringify(response, null, 2));
  
  console.log('\nResponse type:', typeof response);
  console.log('Is array?', Array.isArray(response));
  console.log('Has data property?', response.hasOwnProperty('data'));
  
  if (response.data) {
    console.log('\ndata type:', typeof response.data);
    console.log('data is array?', Array.isArray(response.data));
    console.log('data length:', response.data?.length);
    console.log('data content:', JSON.stringify(response.data, null, 2));
  }
}

check().catch(console.error);
