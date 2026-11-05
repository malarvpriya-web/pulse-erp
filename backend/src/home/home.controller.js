import * as homeService from "./home.service.js";
import { pipeline } from "node:stream/promises";
import { companyOf } from "../shared/scope.js";
import { rolesOf } from "../middlewares/auth.middleware.js";
import { openDocument, contentDisposition, DocumentDownloadError } from "./documentDownload.js";

// Who is looking, for the announcement-backed feeds (company + audience).
const viewerOf = (req) => ({
  companyId:  companyOf(req),
  userId:     req.user?.userId ?? req.user?.id ?? null,
  employeeId: req.user?.employee_id ?? null,
});

export const getAnnouncements = async (req, res) => {
  try {
    const announcements = await homeService.getActiveAnnouncements(viewerOf(req));
    res.json(announcements);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getUpcomingEvents = async (req, res) => {
  try {
    const events = await homeService.getUpcomingEvents(viewerOf(req));
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getCelebrations = async (req, res) => {
  try {
    const celebrations = await homeService.getTodaysCelebrations();
    res.json(celebrations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getPolicies = async (req, res) => {
  try {
    const policies = await homeService.getActivePolicies(companyOf(req));
    res.json(policies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// hr_downloads (HR Documents) are per-company forms. Without a company the
// service's `($1::int IS NULL OR …)` filter would list every company's (§208).
export const getResources = async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(403).json({ error: 'No company context for this login' });
    const resources = await homeService.getResources(cid);
    res.json(resources);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getHolidays = async (req, res) => {
  try {
    const holidays = await homeService.getHolidays(req.scope?.company_id ?? null);
    res.json(holidays);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getAllHolidays = async (req, res) => {
  try {
    const holidays = await homeService.getAllHolidays(req.scope?.company_id ?? null);
    res.json(holidays);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Home Dashboard payload — identical shape for every role, company-scoped via
// req.scope.company_id throughout.
export const getHomeSummary = async (req, res) => {
  try {
    const summary = await homeService.getHomeSummary(req.user, req.scope, req);
    res.json(summary);
  } catch (err) {
    console.error("getHomeSummary error:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /home/documents/:kind/:id/download — the file behind a Home Policies or
// Brand Vault tile, as an attachment. The row is looked up with the SAME
// visibility rules the panel uses (company, active, company-wide audience,
// Brand Vault role restriction), so an id the caller cannot see on Home is a
// 404 here too, never a way round it.
const DOWNLOAD_STATUS = { NO_FILE: 404, DRIVE_NOT_FOUND: 404, NOT_SHARED: 502, UPSTREAM: 502 };

export const downloadDocument = async (req, res) => {
  const { kind } = req.params;
  const id = Number(req.params.id);
  if (!['policy', 'brand'].includes(kind) || !Number.isInteger(id) || id < 1) {
    return res.status(404).json({ code: 'NOT_FOUND', error: 'Document not found.' });
  }
  let file;
  try {
    const doc = kind === 'policy'
      ? await homeService.findHomePolicy(id, companyOf(req))
      : await homeService.findBrandAsset(id, companyOf(req), rolesOf(req));
    if (!doc) return res.status(404).json({ code: 'NOT_FOUND', error: 'Document not found.' });
    file = await openDocument(doc.source_url, { title: doc.title });
  } catch (err) {
    if (err instanceof DocumentDownloadError) {
      return res.status(DOWNLOAD_STATUS[err.code] || 502).json({ code: err.code, error: err.message });
    }
    console.error("downloadDocument error:", err);
    return res.status(500).json({ code: 'ERROR', error: 'Could not prepare the download.' });
  }

  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(file.filename));
  res.setHeader('Cache-Control', 'private, no-store');
  // The client reads the filename from this header; a cross-origin API needs it exposed.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.size) res.setHeader('Content-Length', String(file.size));
  try {
    await pipeline(file.stream, res);
  } catch (err) {
    // Headers are gone; all that is left is to stop. A client closing the tab
    // mid-download lands here too and is not an error worth logging.
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error("downloadDocument stream error:", err?.message);
    res.destroy();
  }
};
