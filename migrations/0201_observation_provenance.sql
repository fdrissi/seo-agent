-- 0201_observation_provenance: every observation retains its source, site,
-- collection time, applicable date range, dimensions, raw-response reference,
-- and transformation version (spec section 6).
--
-- GSC/GA4 rows already carry this through ingestion_batches. The columns
-- below close the gaps for the other observation tables. Existing rows keep
-- NULL: their transformation/extractor version was never recorded, and NULL
-- means "unknown", never a guessed version.

-- Crawl observations: the extractor version that produced the structured
-- fields, and a reference to the bounded, redacted raw HTTP response
-- (status, redirect chain, relevant headers, body SHA-256, bounded body).
ALTER TABLE crawl_results ADD COLUMN transformation_version TEXT;
ALTER TABLE crawl_results ADD COLUMN raw_ref TEXT;

-- URL Inspection results: the transformation that mapped the API response.
ALTER TABLE url_inspections ADD COLUMN transformation_version TEXT;

-- Technical findings: the checks version that derived the finding.
ALTER TABLE technical_issues ADD COLUMN transformation_version TEXT;

-- DataForSEO observations: the parser/transformation versions
-- (dataforseo-volume@N, dataforseo-serp@N).
ALTER TABLE keyword_metrics ADD COLUMN transformation_version TEXT;
ALTER TABLE serp_snapshots ADD COLUMN transformation_version TEXT;

-- Field performance data describes a collection period, not an instant.
-- crux_api: CrUX record.collectionPeriod (rolling 28 days, inclusive).
-- psi_lab: the UTC day of the Lighthouse run (start = end).
-- psi_field: NULL = PageSpeed Insights does not report the period.
ALTER TABLE performance_checks ADD COLUMN date_range_start TEXT;
ALTER TABLE performance_checks ADD COLUMN date_range_end TEXT;

-- Back-fill the CrUX period for existing crux_api rows where the stored
-- metrics recorded it (metrics_json.record.collectionPeriod).
UPDATE performance_checks
   SET date_range_start = json_extract(metrics_json, '$.record.collectionPeriod.firstDate'),
       date_range_end = json_extract(metrics_json, '$.record.collectionPeriod.lastDate')
 WHERE source = 'crux_api' AND json_valid(metrics_json)
   AND json_type(metrics_json, '$.record.collectionPeriod.firstDate') = 'text';
