import { describe, expect, it } from "bun:test";
import { buildS3PullTargets } from "./autopull-targets.js";

describe("buildS3PullTargets", () => {
  it("pulls registered live S3 sources even without legacy inbound bucket config", () => {
    const targets = buildS3PullTargets({
      liveSources: [{
        id: "s3-registered-source",
        bucket: "registered-bucket",
        prefix: "inbound/example.com/",
        region: "us-east-1",
        provider_id: "provider-1",
      }],
      buckets: [],
    });

    expect(targets).toEqual([{
      sourceId: "s3-registered-source",
      bucket: "registered-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });

  it("skips bucket-root scans when registered sources cover the same bucket", () => {
    const targets = buildS3PullTargets({
      liveSources: [{
        id: "s3-prefix-source",
        bucket: "shared-bucket",
        prefix: "inbound/example.com/",
        region: "us-east-1",
        provider_id: "provider-1",
      }],
      buckets: [{ bucket: "shared-bucket", region: "us-east-1", providerId: "provider-1" }],
    });

    expect(targets).toEqual([{
      sourceId: "s3-prefix-source",
      bucket: "shared-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });

  it("still supports legacy inbound bucket config when no registered source exists", () => {
    const targets = buildS3PullTargets({
      liveSources: [],
      buckets: [{ bucket: "legacy-bucket", region: "us-east-1", providerId: "provider-1" }],
      inboundPrefix: "inbound/",
    });

    expect(targets).toEqual([{
      bucket: "legacy-bucket",
      prefix: "inbound/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });
});
