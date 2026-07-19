/**
 * recruitmentDriveService.js
 *
 * Google Drive resume management for the recruitment module.
 * Folder structure:
 *   <GOOGLE_DRIVE_ROOT_FOLDER_ID>/
 *     Recruitment/
 *       {Job Title} - {Job ID}/
 *         Applied | Screening | 1st Level Interview | 2nd Level Interview |
 *         Offer | Maybe | Future Use | Not Suitable | Rejected | Hired
 *
 * Each job opening stores its folder structure as JSONB in job_openings.gdrive_folder_structure.
 * Each candidate stores their file ID in candidates.resume_gdrive_file_id.
 */

import pool from '../modules/shared/db.js';
import {
  ensureFolder,
  uploadFile as driveUpload,
  moveFile,
  isDriveConfigured,
} from './googleDrive.service.js';

const PIPELINE_STAGES = [
  'Applied',
  'Screening',
  '1st Level Interview',
  '2nd Level Interview',
  'Offer',
  'Maybe',
  'Future Use',
  'Not Suitable',
  'Rejected',
  'Hired',
];

// Maps candidate current_stage values → Drive subfolder names
const STAGE_FOLDER_MAP = {
  applied:       'Applied',
  screening:     'Screening',
  '1st_level':   '1st Level Interview',
  '2nd_level':   '2nd Level Interview',
  offer:         'Offer',
  maybe:         'Maybe',
  future_use:    'Future Use',
  not_suitable:  'Not Suitable',
  rejected:      'Rejected',
  hired:         'Hired',
};

let _recruitmentRootId = null;

async function getRecruitmentRoot() {
  if (_recruitmentRootId) return _recruitmentRootId;
  _recruitmentRootId = await ensureFolder('Recruitment', null);
  return _recruitmentRootId;
}

/**
 * Called when a new job opening is created.
 * Creates the folder tree and stores folder IDs in job_openings.
 */
export async function createJobFolderStructure(jobTitle, jobId) {
  if (!isDriveConfigured()) return null;

  const rootId = await getRecruitmentRoot();
  const jobFolderName = `${jobTitle} - ${jobId}`;
  const jobFolderId = await ensureFolder(jobFolderName, rootId);

  const stageFolderIds = {};
  for (const stage of PIPELINE_STAGES) {
    stageFolderIds[stage] = await ensureFolder(stage, jobFolderId);
  }

  await pool.query(
    `UPDATE job_openings
     SET gdrive_folder_id = $1, gdrive_folder_structure = $2
     WHERE id = $3`,
    [jobFolderId, JSON.stringify(stageFolderIds), jobId]
  );

  return jobFolderId;
}

/**
 * Called when a candidate uploads a resume.
 * Uploads to the Applied subfolder and stores the file ID on the candidate row.
 */
export async function uploadResume(candidateId, jobOpeningId, fileBuffer, fileName, mimeType) {
  if (!isDriveConfigured()) return null;

  const job = await pool.query(
    'SELECT gdrive_folder_structure FROM job_openings WHERE id = $1',
    [jobOpeningId]
  );

  if (!job.rows[0]?.gdrive_folder_structure) {
    // Folder structure not yet created — try to create it on the fly
    const jobRow = await pool.query('SELECT job_title FROM job_openings WHERE id = $1', [jobOpeningId]);
    const title = jobRow.rows[0]?.job_title || 'Unknown Job';
    await createJobFolderStructure(title, jobOpeningId);
    return uploadResume(candidateId, jobOpeningId, fileBuffer, fileName, mimeType);
  }

  const folders = job.rows[0].gdrive_folder_structure;
  const appliedFolderId = folders['Applied'];
  if (!appliedFolderId) return null;

  const result = await driveUpload({
    buffer: fileBuffer,
    originalName: fileName,
    mimeType: mimeType || 'application/pdf',
    moduleType: 'hr',
    entityLabel: null,
  });

  // Move to Applied folder (driveUpload puts it under hr root by default)
  await moveFile(result.drive_file_id, appliedFolderId);

  await pool.query(
    `UPDATE candidates
     SET resume_gdrive_file_id = $1,
         resume_gdrive_url = $2,
         current_resume_folder = 'Applied'
     WHERE id = $3`,
    [result.drive_file_id, result.drive_link, candidateId]
  );

  return result.drive_file_id;
}

/**
 * Called on every pipeline stage change.
 * Moves the candidate's resume to the matching subfolder.
 */
export async function moveResumeOnStageChange(candidateId, newStage) {
  if (!isDriveConfigured()) return;

  const cand = await pool.query(
    'SELECT resume_gdrive_file_id, applied_job_id FROM candidates WHERE id = $1',
    [candidateId]
  );
  const row = cand.rows[0];
  if (!row?.resume_gdrive_file_id) return;

  const job = await pool.query(
    'SELECT gdrive_folder_structure FROM job_openings WHERE id = $1',
    [row.applied_job_id]
  );
  const folders = job.rows[0]?.gdrive_folder_structure;
  if (!folders) return;

  const folderName = STAGE_FOLDER_MAP[newStage];
  if (!folderName) return;

  const targetFolderId = folders[folderName];
  if (!targetFolderId) return;

  await moveFile(row.resume_gdrive_file_id, targetFolderId);

  await pool.query(
    'UPDATE candidates SET current_resume_folder = $1 WHERE id = $2',
    [folderName, candidateId]
  );
}
