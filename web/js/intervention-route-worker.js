import { prepareInterventionGraph, computeInterventionRoutes } from './intervention-routing.js?v=20261025-safe-routes';

let graphPromise = null;
function graph() {
  if (!graphPromise) graphPromise = (async () => {
    const response = await fetch(new URL('../data/routing-roads.json?v=20261018-itineraries-v2', import.meta.url));
    if (!response.ok) throw new Error('routing-data-unavailable');
    const data = await response.json();
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('invalid-routing-data');
    return prepareInterventionGraph(data.features);
  })().catch(error => { graphPromise = null; throw error; });
  return graphPromise;
}

self.onmessage = async ({ data }) => {
  if (!data || data.id == null) return;
  const { id, start, end, blockedFeatures = [], vehicle = null } = data;
  try {
    const prepared = await graph();
    const result = computeInterventionRoutes(start, end, prepared, {
      blockedFeatures, vehicle, maxSnapMeters: 150, maxAlternativeSharedFraction: 0.7,
    });
    self.postMessage({ id, result });
  } catch {
    self.postMessage({ id, error: 'routing-calculation-failed' });
  }
};
