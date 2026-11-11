/**
 * Hike App Integration Module
 * This module connects the existing hike GPX viewer with the Cloudflare Worker
 * Place this file in the root directory of your hike app
 */

// Update this with your deployed worker URL
const WORKER_URL = 'https://hike-worker.your-worker-name.workers.dev';

/**
 * Initialize Cloudflare Worker integration
 * @param {Object} options - Configuration options
 * @param {string} options.workerUrl - Worker URL
 * @param {string} options.jinaApiKey - Optional jina.ai API key (stored in browser for demo)
 * @param {boolean} options.useAI - Whether to use AI features (default: true)
 */
export function initWorkerIntegration(options = {}) {
  const workerUrl = options.workerUrl || WORKER_URL;
  const jinaApiKey = options.jinaApiKey || localStorage.getItem('jina_api_key');
  const useAI = options.useAI !== false;

  return {
    // Route Planning
    async planRoute(query, mode = 'hiking') {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const response = await fetch(`${workerUrl}/api/route/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: useAI ? query : null,
          waypoints: !useAI && query ? null : null, // Add waypoints if needed
          mode,
          profile: mode === 'hiking' ? 'foot-hiking' : mode === 'cycling' ? 'cycling-regular' : 'driving-car',
          apiKey: jinaApiKey,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Route planning failed');

      return data;
    },

    // Traditional route planning
    async planRouteWithWaypoints(waypoints, mode = 'hiking') {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const response = await fetch(`${workerUrl}/api/route/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          waypoints,
          mode,
          profile: mode === 'hiking' ? 'foot-hiking' : mode === 'cycling' ? 'cycling-regular' : 'driving-car',
          apiKey: jinaApiKey,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Route planning failed');

      return data;
    },

    // GPX Storage
    async uploadGPX(gpxContent) {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const formData = new FormData();
      formData.append('file', new Blob([gpxContent], { type: 'application/gpx+xml' }));

      const response = await fetch(`${workerUrl}/api/gpx/upload`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'GPX upload failed');

      return data;
    },

    async listGPXFiles() {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const response = await fetch(`${workerUrl}/api/gpx`, {
        method: 'GET',
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to list files');

      return data.files;
    },

    async downloadGPX(key) {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const response = await fetch(`${workerUrl}/api/gpx/${key}`, {
        method: 'GET',
      });

      if (!response.ok) throw new Error('Failed to download GPX');

      return response.blob();
    },

    async deleteGPX(key) {
      if (!workerUrl) throw new Error('Worker URL not configured');

      const response = await fetch(`${workerUrl}/api/gpx/${key}`, {
        method: 'DELETE',
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete GPX');

      return data;
    },

    // GPX Analysis
    async analyzeGPX(gpxKey) {
      if (!workerUrl) throw new Error('Worker URL not configured');
      if (!jinaApiKey) {
        console.warn('jina.ai API key not configured. Analysis will not work.');
        return null;
      }

      const response = await fetch(`${workerUrl}/api/analyze/gpx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gpxKey,
          apiKey: jinaApiKey,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'GPX analysis failed');

      return data;
    },

    // Quick actions
    async uploadAndAnalyzeGPX(gpxContent) {
      try {
        // Upload first
        const uploadResult = await this.uploadGPX(gpxContent);

        // Then analyze
        const analysisResult = await this.analyzeGPX(uploadResult.key);

        return {
          uploadSuccess: true,
          upload: uploadResult,
          analysis: analysisResult,
        };
      } catch (error) {
        throw new Error(`Failed to upload and analyze: ${error.message}`);
      }
    },

    // Save API key to localStorage (for demo purposes)
    saveApiKey(key) {
      localStorage.setItem('jina_api_key', key);
    },

    // Get saved API key
    getApiKey() {
      return localStorage.getItem('jina_api_key');
    },

    // Worker URL
    getWorkerUrl() {
      return workerUrl;
    },
  };
}

/**
 * Convenience wrapper for easy integration
 * This creates a singleton instance
 */
export const hikeWorker = (() => {
  let instance = null;

  return {
    /**
     * Initialize the worker integration
     */
    init(options) {
      if (!instance) {
        instance = initWorkerIntegration(options);
      }
      return instance;
    },

    /**
     * Get the current instance
     */
    getInstance() {
      return instance;
    },

    /**
     * Reset the singleton (for testing)
     */
    reset() {
      instance = null;
    },
  };
})();

// Global function for easy access
window.hikeWorker = hikeWorker;