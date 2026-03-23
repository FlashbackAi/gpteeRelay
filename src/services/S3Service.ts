import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AWS_CONFIG } from '../config/aws';

/**
 * S3 Service for Image Analysis System
 *
 * Handles:
 * - Presigned URL generation for workers to download images
 * - Listing images in bucket for bulk task submission
 */
export class S3Service {
  private client: S3Client;
  private readonly bucket: string;

  constructor(bucket: string = AWS_CONFIG.s3.bucket) {
    this.bucket = bucket;
    this.client = new S3Client({
      region: AWS_CONFIG.region,
    });
  }

  /**
   * Generate presigned URL for image download
   * @param s3Key - S3 object key (e.g., 'photo1.jpg')
   * @param expiresIn - URL expiration in seconds (default: 30 minutes)
   */
  async generatePresignedUrl(s3Key: string, expiresIn: number = 1800): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });
    return url;
  }

  /**
   * List all images in bucket
   * @param prefix - Optional prefix to filter (e.g., 'batch-001/')
   * @param maxKeys - Maximum number of keys to return
   */
  async listImages(prefix?: string, maxKeys: number = 1000): Promise<
    Array<{
      key: string;
      size: number;
      lastModified: Date;
    }>
  > {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
    });

    const response = await this.client.send(command);

    if (!response.Contents) {
      return [];
    }

    // Filter only image files
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    return response.Contents.filter((obj) => {
      const key = obj.Key || '';
      return imageExtensions.some((ext) => key.toLowerCase().endsWith(ext));
    }).map((obj) => ({
      key: obj.Key!,
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date(),
    }));
  }

  /**
   * Get bucket name
   */
  getBucket(): string {
    return this.bucket;
  }
}

// Singleton instance
let s3ServiceInstance: S3Service | null = null;

export function getS3Service(bucket?: string): S3Service {
  if (!s3ServiceInstance) {
    s3ServiceInstance = new S3Service(bucket);
  }
  return s3ServiceInstance;
}
