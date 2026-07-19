import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOAD_DIR = path.resolve(__dirname, '../../uploads');

// STORAGE_PROVIDER: 'local' (default) | 's3' | 'r2'
const PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();

let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set when STORAGE_PROVIDER is s3 or r2');
  }
  _s3 = new S3Client({
    region: process.env.AWS_REGION || 'auto',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    // Cloudflare R2 (and any S3-compatible endpoint) needs explicit endpoint + path-style
    ...(process.env.AWS_S3_ENDPOINT && {
      endpoint: process.env.AWS_S3_ENDPOINT,
      forcePathStyle: true,
    }),
  });
  return _s3;
}

function safeFilename(original) {
  const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const base = path.basename(original, path.extname(original))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
  return `${Date.now()}_${base}${ext}`;
}

/**
 * Upload a file buffer. Returns a URL:
 *   - S3/R2: full https:// URL (served from bucket or STORAGE_BASE_URL)
 *   - local: /uploads/<filename> (served by Express static middleware)
 */
export async function uploadFile(buffer, originalFilename, mimeType) {
  const filename = safeFilename(originalFilename);

  if (PROVIDER === 's3' || PROVIDER === 'r2') {
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) throw new Error('AWS_BUCKET_NAME must be set when STORAGE_PROVIDER is s3 or r2');

    await getS3().send(new PutObjectCommand({
      Bucket: bucket,
      Key: filename,
      Body: buffer,
      ContentType: mimeType,
    }));

    const base = (process.env.STORAGE_BASE_URL || '')
      .replace(/\/$/, '')
      || `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
    return `${base}/${filename}`;
  }

  // Local disk fallback — safe for development and single-instance deploys
  await fsp.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await fsp.writeFile(path.join(LOCAL_UPLOAD_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

/**
 * Delete a previously uploaded file. Non-fatal — logs a warning on failure.
 */
export async function deleteFile(fileUrl) {
  if (!fileUrl) return;

  if (PROVIDER === 's3' || PROVIDER === 'r2') {
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) return;
    const key = path.basename(new URL(fileUrl).pathname);
    try {
      await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      console.warn('[StorageService] delete failed:', fileUrl, err.message);
    }
    return;
  }

  if (fileUrl.startsWith('/uploads/')) {
    const p = path.join(LOCAL_UPLOAD_DIR, path.basename(fileUrl));
    try {
      await fsp.unlink(p);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[StorageService] local delete failed:', p, err.message);
    }
  }
}
