import * as homeService from "./home.service.js";

export const getAnnouncements = async (req, res) => {
  try {
    const announcements = await homeService.getActiveAnnouncements();
    res.json(announcements);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getUpcomingEvents = async (req, res) => {
  try {
    const events = await homeService.getUpcomingEvents();
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
    const policies = await homeService.getActivePolicies();
    res.json(policies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getResources = async (req, res) => {
  try {
    const resources = await homeService.getResources();
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

// Single role-aware Home Dashboard payload. Shape varies by req.user.role and
// is company-scoped via req.scope.company_id throughout.
export const getHomeSummary = async (req, res) => {
  try {
    const summary = await homeService.getHomeSummary(req.user, req.scope);
    res.json(summary);
  } catch (err) {
    console.error("getHomeSummary error:", err);
    res.status(500).json({ error: err.message });
  }
};
