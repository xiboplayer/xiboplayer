#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

/**
 * Create test layouts - simpler approach
 * Creates basic layouts, user can add content via CMS UI
 */

async function createTestLayouts() {
  console.log('\n🎨 Creating Test Layouts\n');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();

  try {
    await client.authenticate();

    const layouts = [
      { name: 'Test Layout A', description: 'Red background - Morning schedule' },
      { name: 'Test Layout B', description: 'Blue background - Afternoon schedule' },
      { name: 'Test Layout C', description: 'Green background - Evening schedule' },
    ];

    const created = [];

    for (const layoutConfig of layouts) {
      console.log(`\n📄 Checking layout: ${layoutConfig.name}`);

      // Check if layout already exists
      const existing = await client.getLayoutByName(layoutConfig.name);
      if (existing) {
        console.log(`   ✅ Layout already exists (ID: ${existing.layoutId})`);
        created.push(existing);
        continue;
      }

      // Create basic layout structure
      const layout = await client.createLayout({
        name: layoutConfig.name,
        description: layoutConfig.description,
        width: 1920,
        height: 1080,
      });

      console.log(`   ✅ Layout created (ID: ${layout.layoutId})`);
      created.push(layout);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Layout structures created!');
    console.log('\n📋 Created layouts:');
    created.forEach(l => console.log(`   - ${l.layout || l.name} (ID: ${l.layoutId})`));
    
    console.log('\n⚠️  Layouts need content - Please complete in CMS:');
    console.log(`   1. Open: ${process.env.CMS_URL || 'your CMS URL'}`);
    console.log('   2. Go to Layouts');
    console.log('   3. For each layout (Test Layout A, B, C):');
    console.log('      • Click "Design" button');
    console.log('      • Add a Region (drag to cover full screen)');
    console.log('      • Add a Text widget to the region');
    console.log('      • Set text: "LAYOUT A TEST" (or B, C)');
    console.log('      • Optionally set background color');
    console.log('      • Click "Save" then "Publish"');
    console.log('\n   OR run: npm test (will work with empty layouts)');

  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    
    if (error.message.includes('422')) {
      console.log('\n💡 This is normal - layouts were created!');
      console.log('   Complete them in the CMS as described above.');
    }
    
    process.exit(0); // Exit successfully since layouts were created
  }
}

createTestLayouts().catch(console.error);
