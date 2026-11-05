/**
 * resumeParser.service.js — pull text and structured fields out of a résumé.
 *
 * The audit's Section 3: every candidate field was typed by hand, because the
 * repo had no text-extraction library at all (`pdf-lib` and `pdfkit` generate
 * PDFs, they do not read them).
 *
 * ── WHAT THIS IS, AND IS NOT ────────────────────────────────────────────────
 * This is a DETERMINISTIC extractor: regular expressions and a small keyword
 * lexicon over the résumé's plain text. It is not a model and it does not guess.
 * That is a deliberate choice for the first version:
 *
 *   - it is explainable — every field can be traced to the line it came from,
 *     which matters when a recruiter asks why a number is wrong;
 *   - it costs nothing per résumé and needs no third-party data processor,
 *     which is a real consideration for candidate PII;
 *   - it degrades honestly. A field it cannot find comes back `null`, never a
 *     plausible-looking invention.
 *
 * Everything here is a SUGGESTION. `parseResume()` returns fields plus a
 * per-field confidence, and the caller is expected to present them as an
 * editable draft a human confirms. Nothing in this file should ever write to a
 * candidate record on its own — see the note on the route that uses it.
 *
 * ── WHAT IT WILL NOT EXTRACT ────────────────────────────────────────────────
 * Nothing that could feed a discriminatory filter: no age or date of birth, no
 * gender, no marital status, no photograph, no nationality. Résumés in India
 * routinely carry all of them. They are ignored on purpose, and a future
 * matching feature therefore cannot learn from them by accident.
 */

import mammoth from 'mammoth';

/* ── DOM shims ──────────────────────────────────────────────────────────────
 * pdfjs touches DOMMatrix / ImageData / Path2D at module initialisation even
 * when only text is being extracted, and Node has none of them. The real
 * implementations matter for RENDERING; text extraction never calls through
 * them, so a structurally-correct stub is enough and avoids a native canvas
 * dependency that would have to compile on every deploy target.
 */
function installPdfShims() {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const a = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
        [this.a, this.b, this.c, this.d, this.e, this.f] = a;
      }
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      inverse() { return this; }
      transformPoint(p) { return p; }
    };
  }
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData {
      constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(0); }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};
}

/* ── Text extraction ────────────────────────────────────────────────────── */

export async function extractText(buffer, mimeType, filename = '') {
  const type = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();

  if (type.includes('pdf') || name.endsWith('.pdf')) {
    installPdfShims();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,   // never eval content from an uploaded file
      useSystemFonts: false,
    }).promise;

    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items));
    }
    await doc.destroy?.();
    return pages.join('\n');
  }

  if (type.includes('word') || type.includes('officedocument') || name.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value || '';
  }

  // Legacy .doc is a binary format mammoth does not read. Saying so beats
  // returning empty text that looks like a résumé with nothing in it.
  if (name.endsWith('.doc')) {
    throw Object.assign(
      new Error('Old .doc files cannot be read automatically — please upload a PDF or .docx.'),
      { statusCode: 415 }
    );
  }

  throw Object.assign(new Error('Unsupported file type for parsing.'), { statusCode: 415 });
}

/**
 * Rebuild LINES from pdfjs text items.
 *
 * Joining every item with a space — the obvious first implementation — collapses
 * the whole page into one line, and a résumé parsed that way loses the structure
 * that actually carries meaning. "Senior Embedded Engineer, Bosch, 2021 -
 * Present" is only recognisable as a current-role line while it IS a line; once
 * the page is one string, the heuristic matches the entire document and returns
 * the candidate's own name as their employer.
 *
 * Items carry their position in `transform[5]` (the y baseline), so a change in y
 * beyond a small tolerance is a new line. `hasEOL` is honoured where pdfjs sets
 * it. The tolerance absorbs sub/superscripts and minor baseline jitter within a
 * line without merging genuinely separate ones.
 */
function itemsToLines(items) {
  const lines = [];
  let current = [];
  let lastY = null;

  for (const it of items) {
    const str = it.str ?? '';
    const y = Array.isArray(it.transform) ? it.transform[5] : null;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.5) {
      lines.push(current.join('').trim());
      current = [];
    }
    current.push(str);
    if (it.hasEOL) {
      lines.push(current.join('').trim());
      current = [];
      lastY = null;
      continue;
    }
    if (y !== null) lastY = y;
  }
  if (current.length) lines.push(current.join('').trim());
  return lines.filter(l => l !== '').join('\n');
}

/* ── Field extraction ───────────────────────────────────────────────────── */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Indian mobile numbers with or without +91, written with or without spaces or
// hyphens between groups ("+91 90000 12345" is how people actually type them),
// plus a generic international form.
//
// Deliberately narrow. A loose "any long digit run" pattern matches PIN codes,
// graduation years, employee numbers and CTC figures, and a confidently wrong
// phone number is worse than a blank one a recruiter fills in.
const PHONE_RE = /(?:(?:\+|00)?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\d{3,5}[\s-]?\d{4,8}\b/g;

const DEGREES = [
  { re: /\b(b\.?\s?e\.?|b\.?\s?tech)\b/i,            value: 'BE/BTech',  level: 'bachelors' },
  { re: /\b(m\.?\s?e\.?|m\.?\s?tech)\b/i,            value: 'ME/MTech',  level: 'masters'   },
  { re: /\bm\.?\s?b\.?\s?a\b/i,                      value: 'MBA',       level: 'masters'   },
  { re: /\bm\.?\s?c\.?\s?a\b/i,                      value: 'MCA',       level: 'masters'   },
  { re: /\bb\.?\s?c\.?\s?a\b/i,                      value: 'BCA',       level: 'bachelors' },
  { re: /\bb\.?\s?sc\b/i,                            value: 'BSc',       level: 'bachelors' },
  { re: /\bm\.?\s?sc\b/i,                            value: 'MSc',       level: 'masters'   },
  { re: /\bb\.?\s?com\b/i,                           value: 'BCom',      level: 'bachelors' },
  { re: /\bph\.?\s?d\b/i,                            value: 'PhD',       level: 'doctorate' },
  { re: /\bdiploma\b/i,                              value: 'Diploma',   level: 'diploma'   },
];

const SPECIALISATIONS = [
  { re: /\belectrical\b/i,                       value: 'Electrical Engineering' },
  { re: /\belectronics?(\s*(&|and)\s*communication)?\b/i, value: 'Electronics' },
  { re: /\bmechanical\b/i,                       value: 'Mechanical Engineering' },
  { re: /\b(computer science|cse|computer engineering)\b/i, value: 'Computer Science' },
  { re: /\b(information technology|\bit\b)\b/i,  value: 'Information Technology' },
  { re: /\bcivil\b/i,                            value: 'Civil Engineering' },
  { re: /\b(instrumentation|e&i)\b/i,            value: 'Instrumentation' },
  { re: /\bchemical\b/i,                         value: 'Chemical Engineering' },
];

// The lexicon is intentionally small and industrial — this is a manufacturing
// ERP, so the skills that matter are not a generic web-developer list. Extend it
// from the skills recruiters actually search for.
const SKILLS = [
  'Power Electronics', 'Embedded C', 'Embedded Systems', 'RTOS', 'CAN', 'Modbus', 'PLC', 'SCADA',
  'MATLAB', 'Simulink', 'Altium', 'OrCAD', 'KiCad', 'PCB Design', 'AutoCAD', 'SolidWorks',
  'CATIA', 'Creo', 'ANSYS', 'LabVIEW', 'VHDL', 'Verilog', 'FPGA', 'ARM', 'STM32', 'Arduino',
  'Motor Control', 'Inverter', 'Converter', 'BMS', 'EV', 'Six Sigma', 'Lean', 'Kaizen', '5S',
  'ISO 9001', 'GD&T', 'FMEA', 'APQP', 'PPAP', 'SAP', 'Oracle ERP', 'Tally',
  'Python', 'Java', 'JavaScript', 'TypeScript', 'React', 'Node', 'SQL', 'PostgreSQL', 'MongoDB',
  'C++', 'C#', '.NET', 'Git', 'Docker', 'Kubernetes', 'AWS', 'Azure', 'Linux',
];

const CURRENT_YEAR = new Date().getFullYear();

const clean = (t) => String(t || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return p;
  }
  return null;
}

/**
 * The candidate's name.
 *
 * Heuristic and openly fallible: the first short line of a résumé that is not an
 * email, a phone number, a heading or an address is almost always the name.
 * Returned with low confidence precisely because "almost always" is not always.
 */
function guessName(text, email) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12);
  const SKIP = /(curriculum\s*vitae|resume|r[ée]sum[ée]|profile|objective|summary|contact|address|phone|email|mobile|linkedin|github)/i;

  for (const line of lines) {
    if (line.length < 3 || line.length > 48) continue;
    if (SKIP.test(line)) continue;
    if (EMAIL_RE.test(line)) { EMAIL_RE.lastIndex = 0; continue; }
    EMAIL_RE.lastIndex = 0;
    if (/\d{4,}/.test(line)) continue;                 // phone, PIN, year
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    // Names are words, not sentences or bullet fragments.
    if (!/^[A-Za-z][A-Za-z.\-' ]+$/.test(line)) continue;
    return line.replace(/\s+/g, ' ');
  }

  // Fall back to the local part of the email — "anjali.rao@…" → "Anjali Rao".
  if (email) {
    const local = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
    if (local.split(/\s+/).length >= 2) {
      return local.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return null;
}

/** Total years of experience, stated explicitly or inferred from a date range. */
function guessExperience(text) {
  // "4 years of experience", "4+ yrs experience", "experience: 4 years"
  const stated = text.match(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?:\s*(?:of)?\s*(?:total\s*)?experience)/i)
              || text.match(/(?:total\s*)?experience\s*[:\-–]?\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)/i);
  if (stated) {
    const n = parseFloat(stated[1]);
    if (n >= 0 && n <= 60) return { value: n, confidence: 'high' };
  }

  // Otherwise infer from the earliest plausible employment year mentioned
  // alongside a "present"/"current" marker.
  if (/\b(present|current|till date|to date)\b/i.test(text)) {
    const years = [...text.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)]
      .map(m => parseInt(m[1], 10))
      .filter(y => y >= 1980 && y <= CURRENT_YEAR);
    if (years.length) {
      const earliest = Math.min(...years);
      const span = CURRENT_YEAR - earliest;
      // A graduation year would inflate this, so it is low confidence and
      // capped at something a human would not laugh at.
      if (span > 0 && span <= 45) return { value: span, confidence: 'low' };
    }
  }
  return { value: null, confidence: null };
}

function guessNoticePeriod(text) {
  const days = text.match(/notice\s*(?:period)?\s*[:\-–]?\s*(\d{1,3})\s*days?/i);
  if (days) return parseInt(days[1], 10);
  const months = text.match(/notice\s*(?:period)?\s*[:\-–]?\s*(\d{1,2})\s*months?/i);
  if (months) return parseInt(months[1], 10) * 30;
  if (/\bimmediate(?:ly)?\s*(?:joiner|available)?\b/i.test(text)) return 0;
  return null;
}

/** Expected salary. Handles "12 LPA", "₹12,00,000", "12 lakhs". */
function guessExpectedCtc(text) {
  const window = text.match(/(?:expected|expecting)[^\n]{0,60}/i)?.[0] || '';
  const source = window || text;

  const lpa = source.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:lpa|lakhs?\s*(?:per\s*annum)?|lacs?)/i);
  if (lpa) {
    const n = parseFloat(lpa[1]);
    if (n > 0 && n <= 500) return Math.round(n * 100000);
  }
  if (window) {
    const rupees = window.match(/(?:₹|rs\.?|inr)\s*([\d,]{5,})/i);
    if (rupees) {
      const n = parseInt(rupees[1].replace(/,/g, ''), 10);
      if (n >= 50000 && n <= 100000000) return n;
    }
  }
  return null;
}

function guessGraduationYear(text) {
  const near = text.match(/(?:graduat|passing|passed|batch|class of)[^\n]{0,40}?\b(19[89]\d|20[0-4]\d)\b/i);
  if (near) return parseInt(near[1], 10);
  // A year sitting next to a recognised degree token is the next best signal.
  const withDegree = text.match(/\b(?:b\.?\s?e|b\.?\s?tech|m\.?\s?tech|mba|mca|b\.?\s?sc|diploma)\b[^\n]{0,60}?\b(19[89]\d|20[0-4]\d)\b/i);
  if (withDegree) return parseInt(withDegree[1], 10);
  return null;
}

function guessInstitution(text) {
  const m = text.match(/\b([A-Z][A-Za-z.&'\- ]{3,60}?(?:University|Institute of Technology|Institute|College|Polytechnic|School of Engineering))\b/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function guessSkills(text) {
  const found = [];
  for (const skill of SKILLS) {
    // Escape the lexicon entries — several contain regex metacharacters
    // (C++, .NET, GD&T), and an unescaped "C++" is a syntax error.
    const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9+#.])${esc}([^A-Za-z0-9+#.]|$)`, 'i');
    if (re.test(text)) found.push(skill);
  }
  return found;
}

function guessLocation(text) {
  const CITIES = ['Bengaluru', 'Bangalore', 'Chennai', 'Hyderabad', 'Mumbai', 'Pune', 'Delhi',
                  'Noida', 'Gurgaon', 'Gurugram', 'Kolkata', 'Ahmedabad', 'Coimbatore',
                  'Kochi', 'Trivandrum', 'Jaipur', 'Indore', 'Nagpur', 'Vadodara', 'Surat',
                  'Mysuru', 'Mysore', 'Salem', 'Madurai', 'Trichy', 'Vizag', 'Visakhapatnam'];
  for (const city of CITIES) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(text)) return city;
  }
  return null;
}

/** Current employer and title, from a "present"/"current" employment line. */
function guessCurrentRole(text) {
  // A line, not the document. Capped in length and required to look like an
  // employment entry rather than a section heading that happens to contain the
  // word "current".
  const line = text.split('\n')
    .map(l => l.trim())
    .find(l =>
      l.length > 8 && l.length < 160 &&
      /\b(present|current|till date|to date)\b/i.test(l) &&
      /\b(19[89]\d|20[0-4]\d)\b/.test(l)          // an employment line carries a year
    );
  if (!line) return { company: null, designation: null };

  // "Embedded Engineer, Bosch, 2021 - Present" / "Bosch — Embedded Engineer"
  const parts = line.split(/[,|–—\-·]/).map(p => p.trim()).filter(Boolean)
    .filter(p => !/\b(present|current|till date|to date)\b/i.test(p))
    // Drop bare years and year ranges — "2021", "2018 2021" are dates, not employers.
    .filter(p => !/^\d{4}(\s+\d{4})?$/.test(p))
    .filter(p => p.length > 1 && p.length < 60);

  if (!parts.length) return { company: null, designation: null };
  const TITLE = /\b(engineer|manager|lead|developer|analyst|executive|officer|consultant|designer|architect|specialist|supervisor|technician|intern|head|director)\b/i;
  const designation = parts.find(p => TITLE.test(p)) || null;
  const company = parts.find(p => p !== designation) || null;
  return { company, designation };
}

/**
 * Parse a résumé buffer into suggested candidate fields.
 *
 * @returns {{ text, fields, confidence, warnings }}
 *   `fields` are SUGGESTIONS for a human to confirm. `confidence` is per-field
 *   ('high' | 'medium' | 'low') so the UI can mark which ones deserve a look.
 */
export async function parseResume(buffer, mimeType, filename = '') {
  const raw = await extractText(buffer, mimeType, filename);
  const text = clean(raw);
  const warnings = [];

  if (text.trim().length < 40) {
    warnings.push('Very little text was found — this may be a scanned image, which cannot be read automatically.');
  }

  const emails = [...new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()))];
  EMAIL_RE.lastIndex = 0;
  const phones = [...new Set((text.match(PHONE_RE) || []).map(p => p.replace(/[\s-]/g, '')))];

  const degree = firstMatch(text, DEGREES);
  const spec   = firstMatch(text, SPECIALISATIONS);
  const exp    = guessExperience(text);
  const role   = guessCurrentRole(text);
  const email  = emails[0] || null;
  const name   = guessName(text, email);
  const skills = guessSkills(text);

  if (!email)  warnings.push('No email address found — it is required to create a candidate.');
  if (!name)   warnings.push('Could not identify a name with confidence — please check it.');
  if (!skills.length) warnings.push('No known skills matched. The skill list is a fixed vocabulary; add them by hand.');

  const fields = {
    full_name:           name,
    email,
    phone:               phones[0] || null,
    location:            guessLocation(text),
    current_company:     role.company,
    current_designation: role.designation,
    experience_years:    exp.value,
    notice_period_days:  guessNoticePeriod(text),
    expected_ctc:        guessExpectedCtc(text),
    skills,
    qualification:       degree?.value || null,
    specialisation:      spec?.value || null,
    institution:         guessInstitution(text),
    graduation_year:     guessGraduationYear(text),
  };

  const confidence = {
    full_name:           name ? 'low' : null,          // always worth a human glance
    email:               email ? 'high' : null,
    phone:               fields.phone ? 'high' : null,
    location:            fields.location ? 'medium' : null,
    current_company:     fields.current_company ? 'low' : null,
    current_designation: fields.current_designation ? 'low' : null,
    experience_years:    exp.confidence,
    notice_period_days:  fields.notice_period_days != null ? 'medium' : null,
    expected_ctc:        fields.expected_ctc != null ? 'medium' : null,
    skills:              skills.length ? 'high' : null,
    qualification:       fields.qualification ? 'high' : null,
    specialisation:      fields.specialisation ? 'medium' : null,
    institution:         fields.institution ? 'medium' : null,
    graduation_year:     fields.graduation_year ? 'medium' : null,
  };

  return { text, fields, confidence, warnings };
}

export default { parseResume, extractText };
