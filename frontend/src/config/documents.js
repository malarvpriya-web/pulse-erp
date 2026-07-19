// Central document storage config.
// Change VITE_DOCUMENTS_BASE_URL in .env to switch from Google Drive to NAS or S3 — no code changes needed.

export const DOCUMENTS_BASE_URL =
  import.meta.env.VITE_DOCUMENTS_BASE_URL ||
  "https://drive.google.com/drive/folders/1SeJEpixtJTrFiqtVSYhk24iS_YpfzgYH";

export const POLICY_FOLDER    = `${DOCUMENTS_BASE_URL}?subfolder=policies`;
export const TEMPLATES_FOLDER = `${DOCUMENTS_BASE_URL}?subfolder=templates`;
export const LOGO_URL         = `${DOCUMENTS_BASE_URL}?file=logo.png`;
