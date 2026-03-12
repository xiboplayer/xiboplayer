// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from package root
dotenv.config({ path: join(__dirname, '..', '.env') });

/**
 * Xibo CMS API Client
 *
 * Provides programmatic access to Xibo CMS REST API for creating
 * test layouts, campaigns, and schedules.
 *
 * Authentication uses OAuth2 client credentials flow.
 */
export class XiboCmsClient {
  constructor(cmsUrl = process.env.CMS_URL, clientId = process.env.CLIENT_ID, clientSecret = process.env.CLIENT_SECRET) {
    this.cmsUrl = cmsUrl?.replace(/\/$/, ''); // Remove trailing slash
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Authenticate with Xibo CMS using OAuth2 client credentials
   */
  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken; // Token still valid
    }

    const authUrl = `${this.cmsUrl}/api/authorize/access_token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    try {
      const response = await fetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Authentication failed: ${response.status} ${error}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000);

      console.log('✅ Authenticated successfully');
      return this.accessToken;
    } catch (error) {
      console.error('❌ Authentication error:', error.message);
      throw error;
    }
  }

  /**
   * Make authenticated API request
   */
  async request(endpoint, options = {}) {
    await this.authenticate();

    const url = `${this.cmsUrl}/api${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }

      // Handle empty responses (204 No Content or empty body)
      const contentLength = response.headers.get('content-length');
      if (contentLength === '0' || response.status === 204) {
        return {};
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        return {};
      }

      return JSON.parse(text);
    } catch (error) {
      console.error(`❌ API request error (${endpoint}):`, error.message);
      throw error;
    }
  }

  /**
   * Get all display groups
   */
  async getDisplayGroups() {
    const data = await this.request('/displaygroup');
    // API returns array directly, not wrapped in {data: [...]}
    return Array.isArray(data) ? data : (data.data || []);
  }

  /**
   * Get display group by name
   */
  async getDisplayGroupByName(name) {
    const groups = await this.getDisplayGroups();
    return groups.find(g => g.displayGroup === name);
  }

  /**
   * Get all layouts
   */
  async getLayouts() {
    const data = await this.request('/layout');
    // API returns array directly, not wrapped in {data: [...]}
    return Array.isArray(data) ? data : (data.data || []);
  }

  /**
   * Get layout by name
   */
  async getLayoutByName(name) {
    const layouts = await this.getLayouts();
    return layouts.find(l => l.layout === name);
  }

  /**
   * Create a simple test layout
   *
   * Note: Creating layouts via API is complex due to XLF format.
   * This method creates a basic layout structure. For production use,
   * consider creating layouts manually in CMS and using API to schedule them.
   */
  async createLayout({ name, width = 1920, height = 1080, description = '' }) {
    const params = new URLSearchParams({
      name,
      width,
      height,
      description,
    });

    const data = await this.request(`/layout?${params}`, {
      method: 'POST',
    });

    console.log(`✅ Created layout: ${name} (ID: ${data.layoutId})`);
    return data;
  }

  /**
   * Add a region to a layout
   */
  async addRegion(layoutId, { width = 1920, height = 1080, top = 0, left = 0 }) {
    const params = new URLSearchParams({
      width,
      height,
      top,
      left,
    });

    const data = await this.request(`/region/${layoutId}?${params}`, {
      method: 'POST',
    });

    console.log(`✅ Added region to layout ${layoutId}`);
    return data;
  }

  /**
   * Add a text widget to a region
   */
  async addTextWidget(playlistId, { text, duration = 60, transIn = 'fadeIn', transOut = 'fadeOut' }) {
    const widget = {
      type: 'text',
      duration,
      text,
      effect: transIn,
      transOut,
    };

    const data = await this.request(`/playlist/widget/text/${playlistId}`, {
      method: 'POST',
      body: JSON.stringify(widget),
    });

    console.log(`✅ Added text widget to playlist ${playlistId}`);
    return data;
  }

  /**
   * Get all campaigns
   */
  async getCampaigns() {
    const data = await this.request('/campaign');
    // API returns array directly, not wrapped in {data: [...]}
    return Array.isArray(data) ? data : (data.data || []);
  }

  /**
   * Get campaign by name
   */
  async getCampaignByName(name) {
    const campaigns = await this.getCampaigns();
    return campaigns.find(c => c.campaign === name);
  }

  /**
   * Create a campaign
   */
  async createCampaign(name) {
    const params = new URLSearchParams({ name });

    const data = await this.request(`/campaign?${params}`, {
      method: 'POST',
    });

    console.log(`✅ Created campaign: ${name} (ID: ${data.campaignId})`);
    return data;
  }

  /**
   * Assign a layout to a campaign
   */
  async assignLayoutToCampaign(campaignId, layoutId, displayOrder = null) {
    const params = new URLSearchParams({ layoutId });
    if (displayOrder !== null) {
      params.append('displayOrder', displayOrder);
    }

    const data = await this.request(`/campaign/layout/assign/${campaignId}?${params}`, {
      method: 'POST',
    });

    console.log(`✅ Assigned layout ${layoutId} to campaign ${campaignId}`);
    return data;
  }

  /**
   * Assign multiple layouts to a campaign
   */
  async assignLayoutsToCampaign(campaignId, layoutIds) {
    const results = [];
    for (let i = 0; i < layoutIds.length; i++) {
      const result = await this.assignLayoutToCampaign(campaignId, layoutIds[i], i + 1);
      results.push(result);
    }
    return results;
  }

  /**
   * Create a schedule event
   *
   * @param {Object} params - Schedule parameters
   * @param {number} params.campaignId - Campaign ID to schedule
   * @param {number[]} params.displayGroupIds - Display group IDs
   * @param {string} params.fromDt - Start date/time (ISO format or HH:mm:ss for recurring)
   * @param {string} params.toDt - End date/time (ISO format or HH:mm:ss for recurring)
   * @param {string} params.recurrenceType - 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'
   * @param {string} params.recurrenceDetail - Comma-separated values (e.g., '1,2,3,4,5' for Mon-Fri)
   * @param {number} params.isPriority - Priority level (0-100)
   */
  async scheduleEvent({
    campaignId,
    displayGroupIds,
    fromDt,
    toDt,
    recurrenceType = null,
    recurrenceDetail = null,
    isPriority = 0,
    dayPartId = 0,
  }) {
    const body = {
      eventTypeId: 1, // Layout/Campaign
      campaignId,
      displayGroupIds,
      fromDt,
      toDt,
      isPriority,
      dayPartId,
    };

    if (recurrenceType) {
      body.recurrenceType = recurrenceType;
      body.recurrenceDetail = recurrenceDetail;
    }

    const data = await this.request('/schedule', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    console.log(`✅ Created schedule event for campaign ${campaignId}`);
    return data;
  }

  /**
   * Get schedule for a display
   */
  async getSchedule(displayId) {
    const data = await this.request(`/schedule/data/displaygroup?displayGroupId=${displayId}`);
    return data;
  }

  /**
   * Get displays in a display group
   */
  async getDisplaysInGroup(displayGroupId) {
    const data = await this.request(`/displaygroup/${displayGroupId}/display`);
    // API returns array directly, not wrapped in {data: [...]}
    return Array.isArray(data) ? data : (data.data || []);
  }

  /**
   * Delete a layout
   */
  async deleteLayout(layoutId) {
    await this.request(`/layout/${layoutId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Deleted layout ${layoutId}`);
  }

  /**
   * Delete a campaign
   */
  async deleteCampaign(campaignId) {
    await this.request(`/campaign/${campaignId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Deleted campaign ${campaignId}`);
  }

  /**
   * Delete a schedule event
   */
  async deleteScheduleEvent(eventId) {
    await this.request(`/schedule/${eventId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Deleted schedule event ${eventId}`);
  }
}

export default XiboCmsClient;
