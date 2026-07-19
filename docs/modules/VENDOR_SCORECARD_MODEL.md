# Vendor Scorecard Model

## Overview
Vendors are scored 0–100 using a weighted 5-dimension model. Scores are either manually entered by a procurement manager or automatically computed from live transactional data.

---

## Scoring Formula

```
Overall Score = (Quality × 0.30) + (Delivery × 0.25) + (Cost × 0.15) + (Support × 0.15) + (Compliance × 0.15)
```

| Dimension  | Weight | Signal Source |
|------------|--------|--------------|
| Quality    | 30%    | IQC inspection pass rate – (open NCRs × 5) – (critical NCRs × 10) |
| Delivery   | 25%    | On-time GRN% (on_time_count / total_grns × 100) |
| Cost       | 15%    | 80 – (outstanding / total_spend × 30); capped 0–100 |
| Support    | 15%    | Default 70 when no direct signal |
| Compliance | 15%    | CAPA closure% – (critical NCRs × 5); capped 0–100 |

---

## Classification Bands

| Band       | Score Range | Icon | Procurement Treatment |
|------------|-------------|------|----------------------|
| Preferred  | ≥ 80        | 🌟   | Top-tier; preferred for all new orders |
| Approved   | 60–79       | ✅   | Standard procurement; no restrictions |
| Watchlist  | 40–59       | ⚠️   | Requires manager sign-off on new POs |
| Blocked    | < 40        | 🚫   | No new orders without Director approval |

---

## Score Sources

### `source: 'stored'`
Saved manually via `POST /vendor-360/:id/scorecard`.
- Stored in `vendor_scorecards` table (`procurement` schema)
- Fields: `quality_score`, `delivery_score`, `cost_score`, `support_score`, `compliance_score`, `notes`, `scored_by`, `scored_at`
- `overall_score = avg of 5 dimensions` (see note below)
- `classification` string also persisted

> Note: The current save formula uses a simple average of all 5 raw scores, not the weighted formula. This will be corrected in Phase 50 to use the weighted formula for persistence as well.

### `source: 'computed'`
Auto-computed from live data when no stored scorecard exists. Recalculated on every `GET /vendor-360/:id` call.

---

## Database Table: `vendor_scorecards`

```sql
CREATE TABLE IF NOT EXISTS vendor_scorecards (
  id               SERIAL PRIMARY KEY,
  vendor_id        INTEGER NOT NULL REFERENCES vendors(id),
  company_id       INTEGER NOT NULL,
  quality_score    NUMERIC(5,2)  DEFAULT 0,
  delivery_score   NUMERIC(5,2)  DEFAULT 0,
  cost_score       NUMERIC(5,2)  DEFAULT 0,
  support_score    NUMERIC(5,2)  DEFAULT 0,
  compliance_score NUMERIC(5,2)  DEFAULT 0,
  overall_score    NUMERIC(5,2)  DEFAULT 0,
  classification   VARCHAR(20)   DEFAULT 'Approved',
  notes            TEXT,
  scored_by        INTEGER REFERENCES employees(id),
  scored_at        TIMESTAMPTZ   DEFAULT NOW(),
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);
```

---

## API

### GET /vendor-360/:id/scorecard
Returns the current scorecard (stored if exists, else computed).

**Response shape:**
```json
{
  "quality_score":    85.0,
  "delivery_score":   78.5,
  "cost_score":       72.0,
  "support_score":    70.0,
  "compliance_score": 90.0,
  "overall_score":    80.1,
  "classification":   "Preferred",
  "source":           "stored",
  "scored_at":        "2026-05-15T10:30:00Z"
}
```

### POST /vendor-360/:id/scorecard
Saves a new scorecard entry.

**Request body:**
```json
{
  "quality_score":    85,
  "delivery_score":   78,
  "cost_score":       72,
  "support_score":    70,
  "compliance_score": 90,
  "notes":            "Vendor improved on delivery Q1 2026"
}
```

---

## UI: Score Form (ScoreForm component)
- 5 numeric inputs (0–100, step 5)
- Live overall score preview with classification
- Notes field (optional)
- Saves via POST; triggers full vendor reload on success
- Accessible from header "Score Vendor" button and Scorecard tab empty state

## UI: Scorecard Tab Display
1. Classification banner (color-coded, with description)
2. 5 SVG circle gauges (one per dimension)
3. Recharts RadarChart (spider web profile)
4. Weighted breakdown table (dimension → weight → raw → weighted pts → bar)
5. Formula footnote
