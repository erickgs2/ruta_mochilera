import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeKey, type StorageProvider, type StoredObject } from './storage-provider';

/** True when the SDK reports a missing object, false for any other failure (network, auth, …). */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404;
}

/** S3-backed storage. Used in qa and production, where the API runs on EC2. */
export class S3Storage implements StorageProvider {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    private readonly baseUrl: string
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })
    );
    return { key, contentType, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) {
      throw new Error(`Storage object has no body: ${key}`);
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  publicUrl(key: string): string {
    assertSafeKey(key);
    return `${this.baseUrl.replace(/\/$/, '')}/${key}`;
  }
}
