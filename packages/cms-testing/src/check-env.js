#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '..', '.env');

console.log('\n🔍 Checking .env file\n');
console.log('='.repeat(60));

console.log('\n📁 File path:', envPath);

// Read raw file content
try {
  const rawContent = readFileSync(envPath, 'utf-8');
  console.log('\n📄 Raw .env content:');
  console.log('---');
  console.log(rawContent);
  console.log('---');
} catch (error) {
  console.error('❌ Could not read .env file:', error.message);
  process.exit(1);
}

// Load with dotenv
dotenv.config({ path: envPath });

console.log('\n🔑 Parsed environment variables:');
console.log('   CMS_URL:', JSON.stringify(process.env.CMS_URL));
console.log('   CLIENT_ID:', JSON.stringify(process.env.CLIENT_ID));
console.log('   CLIENT_SECRET (length):', process.env.CLIENT_SECRET?.length || 0);
console.log('   CLIENT_SECRET (first 20):', JSON.stringify(process.env.CLIENT_SECRET?.substring(0, 20)));
console.log('   CLIENT_SECRET (last 20):', JSON.stringify(process.env.CLIENT_SECRET?.substring(process.env.CLIENT_SECRET.length - 20)));

// Check for common issues
console.log('\n⚠️  Checking for common issues:');

const issues = [];

if (!process.env.CLIENT_ID) {
  issues.push('CLIENT_ID is not set');
} else if (process.env.CLIENT_ID.includes('your_')) {
  issues.push('CLIENT_ID still has placeholder value');
} else if (process.env.CLIENT_ID.trim() !== process.env.CLIENT_ID) {
  issues.push('CLIENT_ID has leading/trailing whitespace');
}

if (!process.env.CLIENT_SECRET) {
  issues.push('CLIENT_SECRET is not set');
} else if (process.env.CLIENT_SECRET.includes('your_')) {
  issues.push('CLIENT_SECRET still has placeholder value');
} else if (process.env.CLIENT_SECRET.trim() !== process.env.CLIENT_SECRET) {
  issues.push('CLIENT_SECRET has leading/trailing whitespace');
}

if (issues.length > 0) {
  console.log('   ❌ Issues found:');
  issues.forEach(issue => console.log('      -', issue));
} else {
  console.log('   ✅ No obvious issues found');
}

console.log('\n💡 Next steps:');
console.log('   1. Verify the OAuth application exists in CMS');
console.log(`      → Open ${process.env.CMS_URL || 'your CMS URL'}`);
console.log('      → Go to Applications menu');
console.log('      → Check if application "Automated Testing" exists');
console.log('   2. If it exists, try regenerating the secret');
console.log('   3. If not, create a new OAuth application');
console.log('   4. Copy the NEW credentials to .env');

console.log('\n' + '='.repeat(60));
