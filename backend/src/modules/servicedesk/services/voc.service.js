// backend/src/modules/servicedesk/services/voc.service.js
//
// One rule for turning customer feedback into a sentiment band, shared by every
// path that records a response.
//
// WHY THIS EXISTS
// ---------------
// The 2026-09-11 SCA audit's follow-up verification found the Voice-of-Customer
// module fully built — surveys, responses, NPS bands, classification, action
// tracking, a dashboard — and wired to four genuine triggers: commissioning
// sign-off, field-visit completion, project closure, and the customer portal.
//
// But the three AUTOMATIC triggers wrote only `rating` and `suggestions`. They
// never set `nps_score`, `sentiment` or `classification`. The dashboard counts
// promoters and detractors off `nps_score`, so every automatically-collected
// response — which is to say almost all of them — was invisible to the NPS
// figure, the sentiment breakdown, the classification breakdown, and the
// top-complaints list that filters on `sentiment = 'detractor'`.
//
// Feedback was being collected diligently and then not counted.
//
// TWO SCALES, ONE BAND
// --------------------
// The portal survey asks the NPS question (0-10). The commissioning and
// field-visit forms capture a 1-5 star rating, because that is what someone
// signs off on a tablet in a substation. Both are legitimate; they are different
// instruments, not one instrument used wrongly.
//
// So sentiment — not nps_score — is the common currency, and the dashboard bands
// off sentiment. A 1-5 rating is NOT converted into a fake 0-10 NPS score: that
// would invent a precision the instrument never had and pollute avg_nps with
// numbers nobody gave. The rating maps straight to a band and leaves nps_score
// NULL, so avg_nps stays an average of actual NPS answers.
//
//   NPS 0-10   >= 9 promoter · 7-8 passive · <= 6 detractor   (standard)
//   Rating 1-5    5 promoter ·   4 passive ·  <= 3 detractor   (top-box)

export const SENTIMENTS = ['promoter', 'passive', 'detractor'];

/**
 * Band a response from whichever instrument produced it.
 * @param {{nps_score?: number|null, rating?: number|null}} input
 * @returns {'promoter'|'passive'|'detractor'|null} null when neither was answered
 */
export function deriveSentiment({ nps_score, rating } = {}) {
  const nps = nps_score === null || nps_score === undefined || nps_score === '' ? null : Number(nps_score);
  if (nps !== null && Number.isFinite(nps)) {
    if (nps >= 9) return 'promoter';
    if (nps >= 7) return 'passive';
    return 'detractor';
  }
  const r = rating === null || rating === undefined || rating === '' ? null : Number(rating);
  if (r !== null && Number.isFinite(r)) {
    if (r >= 5) return 'promoter';
    if (r >= 4) return 'passive';
    return 'detractor';
  }
  return null;
}

/**
 * Route free-text feedback to the team that owns it.
 *
 * Keyword classification, deliberately: it is inspectable, needs no training
 * data, and a planner can see why a comment landed where it did. The order
 * matters — a comment mentioning both a relay and the engineer who fitted it is
 * about the product.
 */
export function classifyFeedback(suggestions, improvements, features) {
  const text = `${suggestions || ''} ${improvements || ''} ${features || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/product|panel|equipment|relay|transformer|busbar|enclosure|quality|defect/.test(text)) return 'Product';
  if (/service|engineer|technician|support|response|visit|time|delay/.test(text)) return 'Service';
  if (/manual|document|drawing|report|certificate|invoice/.test(text)) return 'Documentation';
  if (/training|guide|tutorial|how to|demo/.test(text)) return 'Training';
  if (/app|portal|software|feature|button|system|login/.test(text)) return 'Software';
  return 'General';
}

/**
 * Everything a voc_responses insert needs derived, from whatever was captured.
 * Callers spread this over their own columns so there is exactly one place the
 * banding rule lives.
 */
export function deriveResponseFields({ nps_score, rating, category, suggestions, improvement_ideas, new_feature_requests } = {}) {
  return {
    sentiment: deriveSentiment({ nps_score, rating }),
    classification: category || classifyFeedback(suggestions, improvement_ideas, new_feature_requests),
  };
}

export default { SENTIMENTS, deriveSentiment, classifyFeedback, deriveResponseFields };
