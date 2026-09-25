/**
 * Public entry point of the Google integration (Search Console + GA4).
 * Integration code should import from here.
 */
export { GOOGLE_SCOPES, type GoogleApiClient, type GoogleAuthProvider, type GoogleRequest, type GoogleResponse } from './types.js';
export { GoogleApiError, classifyGoogleError, isQuotaStop, parseGoogleErrorBody, type GoogleErrorKind } from './errors.js';
export { AuthorizedGoogleApiClient, type AuthHeaderSource } from './http-client.js';
export { discoverGscProperties, assertConfiguredPropertyAccessible, type DiscoveredProperty, type PropertyDiscovery } from './gsc-properties.js';
export { syncGsc, computeGscRange, segmentKeyOf, GSC_TRANSFORMATION_VERSION, type SyncGscOptions, type SyncGscResult } from './gsc-sync.js';
export { GSC_TIME_ZONE, validateGscPropertyFormat, validateSearchAnalyticsRequest, urlBelongsToProperty, normalizePermissionLevel } from './gsc-client.js';
export { inspectUrls, selectPriorityUrls, describeInspection, INDEXED_STATE_NOTE, type InspectUrlsResult } from './url-inspection.js';
export { syncGa4, computeGa4Range, CHANNEL_VIEWS, GA4_TRANSFORMATION_VERSION, type SyncGa4Options, type SyncGa4Result } from './ga4-sync.js';
export { planGa4Metrics, loadCachedGa4Metadata, type Ga4MetricPlan } from './ga4-metadata.js';
export { ga4ConversionChecklist } from './ga4-checklist.js';
export { googleStatus } from './status.js';
export { createFixtureGoogleAuthProvider, FixtureGoogleAuthProvider, type FixtureProviderOptions } from './fixture-provider.js';
export { createGoogleAuthProvider } from '../../auth/providers.js';
