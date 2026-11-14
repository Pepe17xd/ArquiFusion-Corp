import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { OriginalFileStore } from "./contracts";

export class S3OriginalFileStore implements OriginalFileStore {
  private readonly client = new S3Client({});

  constructor(private readonly bucket: string) {}

  async saveOriginal(input: { content: string; contentType: string; extension: string; sha256: string }): Promise<string> {
    const key = `imports/${input.sha256}.${input.extension}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: input.content, ContentType: input.contentType,
      Metadata: { sha256: input.sha256 }, ServerSideEncryption: "AES256",
    }));
    return `s3://${this.bucket}/${key}`;
  }
}
