/**
 * SYNTHETIC site configuration for the AI-citation tests: the invented brand
 * "Qwertle Tools" on reserved *.test hostnames. Not an owner's configuration.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteConfig } from '../../../src/config/site-schema.js';
import { testSiteConfig } from '../../helpers/context.js';

export const AEO_FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const OBSERVATIONS_CSV = path.join(AEO_FIXTURES_DIR, 'observations.synthetic.csv');
export const OBSERVATIONS_JSON = path.join(AEO_FIXTURES_DIR, 'observations.synthetic.json');

/** Business time zone of the synthetic site (dates without a time are read in this zone). */
export const AEO_TIME_ZONE = 'America/New_York';

export function aeoSiteConfig(opts: { enabled?: boolean; id?: string } = {}): SiteConfig {
  return testSiteConfig({
    site: {
      id: opts.id ?? 'aeo-site',
      businessName: 'Qwertle Tools',
      url: 'https://www.qwertle.test/',
      allowedHostnames: ['www.qwertle.test', 'qwertle.test'],
    },
    brand: { aliases: ['Qwertle'] },
    reporting: { businessTimezone: AEO_TIME_ZONE },
    ...(opts.enabled === false ? {} : { features: { aiCitations: true } }),
  });
}
