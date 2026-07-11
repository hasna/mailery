export interface S3PullTarget {
  sourceId?: string;
  bucket: string;
  prefix?: string;
  region: string;
  providerId?: string;
}

export function buildS3PullTargets(input: {
  liveSources: Array<{
    id: string;
    bucket: string;
    prefix?: string;
    region: string;
    provider_id?: string;
  }>;
  buckets: Array<{
    bucket: string;
    region: string;
    providerId?: string;
  }>;
  inboundPrefix?: string;
}): S3PullTarget[] {
  const sourceBuckets = new Set(input.liveSources.map((source) => source.bucket));
  return [
    ...input.liveSources.map((source) => ({
      sourceId: source.id,
      bucket: source.bucket,
      prefix: source.prefix,
      region: source.region,
      providerId: source.provider_id,
    })),
    ...input.buckets
      .filter((bucket) => !sourceBuckets.has(bucket.bucket))
      .map((bucket) => ({
        bucket: bucket.bucket,
        prefix: input.inboundPrefix,
        region: bucket.region,
        providerId: bucket.providerId,
      })),
  ];
}
