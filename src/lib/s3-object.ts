import type { S3Client } from "@aws-sdk/client-s3";

type S3Sdk = typeof import("@aws-sdk/client-s3");

let s3SdkPromise: Promise<S3Sdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

export interface ParsedS3ObjectUrl {
  bucket: string;
  key: string;
}

export interface ReadS3ObjectBytesOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3Client;
}

export interface ReadS3ObjectBytesResult extends ParsedS3ObjectUrl {
  url: string;
  body: Buffer;
  contentType?: string;
  contentLength?: number;
  etag?: string;
}

export function s3ObjectUrl(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export function parseS3ObjectUrl(url: string): ParsedS3ObjectUrl {
  const trimmed = url.trim();
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (!match) throw new Error(`Invalid S3 object URL: ${url}`);
  return { bucket: match[1]!, key: match[2]! };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported S3 object body stream");
}

export async function readS3ObjectBytes(
  url: string,
  opts: ReadS3ObjectBytesOptions = {},
): Promise<ReadS3ObjectBytesResult> {
  const { bucket, key } = parseS3ObjectUrl(url);
  const sdk = await loadS3Sdk();
  const { GetObjectCommand, S3Client: S3ClientCtor } = sdk;
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  const client = opts.client ?? new S3ClientCtor({
    region: opts.region ?? process.env["AWS_REGION"] ?? "us-east-1",
    credentials,
  });
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    url,
    bucket,
    key,
    body: await streamToBuffer(res.Body),
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    etag: res.ETag,
  };
}
