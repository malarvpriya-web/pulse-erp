/**
 * Upload rules shared by the Internships routers: the same type allowlist and
 * 5 MB cap the intern form uses (and server.js applies to employee uploads).
 * The bytes go to StorageService.uploadFile(); /api/files serves them.
 */
import multer from 'multer';

export const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const notAllowed = (file) =>
  Object.assign(new Error(`"${file.originalname}" is not allowed. Upload an image, PDF or Word document.`), { status: 415 });

/** A multer error as a 4xx, never a 500. */
export function answerUploadError(res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Each file must be 5 MB or smaller.' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Unexpected upload field "${err.field}".` });
  return res.status(err.status || 400).json({ error: err.message });
}

/** Middleware accepting ONE optional file in `field`, into req.file. */
export function singleFileUpload(field) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES },
    fileFilter: (_req, file, cb) => (ALLOWED_MIME.has(file.mimetype) ? cb(null, true) : cb(notAllowed(file))),
  }).single(field);
  return (req, res, next) => upload(req, res, (err) => (err ? answerUploadError(res, err) : next()));
}
