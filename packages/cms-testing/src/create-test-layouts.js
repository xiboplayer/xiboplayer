#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>

import { XiboCmsClient } from './xibo-api-client.js';

/**
 * Create test layouts with text widgets
 */

async function createTestLayouts() {
  console.log('\n🎨 Creating Test Layouts\n');
  console.log('='.repeat(60));

  const client = new XiboCmsClient();

  try {
    await client.authenticate();

    const layouts = [
      {
        name: 'Test Layout A',
        description: 'Test layout with red background',
        text: 'MORNING SCHEDULE - Layout A',
        backgroundColor: '#FF0000',
      },
      {
        name: 'Test Layout B',
        description: 'Test layout with blue background',
        text: 'AFTERNOON SCHEDULE - Layout B',
        backgroundColor: '#0000FF',
      },
      {
        name: 'Test Layout C',
        description: 'Test layout with green background',
        text: 'EVENING SCHEDULE - Layout C',
        backgroundColor: '#00FF00',
      },
    ];

    for (const layoutConfig of layouts) {
      console.log(`\n📄 Creating layout: ${layoutConfig.name}`);

      // Check if layout already exists
      const existing = await client.getLayoutByName(layoutConfig.name);
      if (existing) {
        console.log(`   ⚠️  Layout already exists (ID: ${existing.layoutId})`);
        console.log('   Skipping creation');
        continue;
      }

      // Create layout
      const layout = await client.createLayout({
        name: layoutConfig.name,
        description: layoutConfig.description,
        width: 1920,
        height: 1080,
      });

      console.log(`   Layout created (ID: ${layout.layoutId})`);

      // Add a full-screen region
      console.log('   Adding region...');
      const region = await client.addRegion(layout.layoutId, {
        width: 1920,
        height: 1080,
        top: 0,
        left: 0,
      });

      console.log(`   Region added (ID: ${region.regionId})`);

      // Add text widget to the region
      console.log('   Adding text widget...');
      
      // Get the playlist ID from the region
      const regionDetails = await client.request(`/region/${region.regionId}`);
      const playlistId = regionDetails.regionPlaylist?.playlistId || region.regionPlaylist?.playlistId;

      if (!playlistId) {
        console.log('   ⚠️  Could not find playlist ID, trying alternative method...');
        // Try getting it from the layout
        const layoutDetails = await client.request(`/layout/${layout.layoutId}`);
        console.log('   Layout details:', JSON.stringify(layoutDetails, null, 2));
      } else {
        await client.addTextWidget(playlistId, {
          text: layoutConfig.text,
          duration: 60,
          transIn: 'fadeIn',
          transOut: 'fadeOut',
        });
        console.log('   ✅ Text widget added');
      }

      console.log(`   ✅ Layout "${layoutConfig.name}" completed!`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ All layouts created!');
    console.log('\n📋 Next steps:');
    console.log(`   1. Check layouts in CMS: ${process.env.CMS_URL || 'your CMS URL'}`);
    console.log('   2. Edit layouts to add background colors and adjust styling');
    console.log('   3. Publish layouts');
    console.log('   4. Run: npm test');

  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

createTestLayouts().catch(console.error);
