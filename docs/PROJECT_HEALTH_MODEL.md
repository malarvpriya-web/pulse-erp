# Project Health Model

## Dimensions (7 scores, each 0–100)

### Schedule Score (weight 25%)
- Start: 100
- -40 pts proportional to overdue milestones / total milestones
- -30 pts proportional to overdue tasks / total tasks
- -20 pts if project end_date passed and status ≠ completed

### Budget Score (weight 20%)
- Start: 100
- -40 pts if cost > 90% of revenue
- -20 pts if cost > 75% of revenue
- -20 pts if burn rate exceeds completion % by 20%+

### Quality Score (weight 15%)
- Start: 100
- -15 pts per open NCR (capped at -50)
- -20 pts if FAT records exist but none passed

### Procurement Score (weight 15%)
- Start: 100
- -40 pts proportional to pending POs / total POs

### Production Score (weight 10%)
- = (completed production orders / total) × 100
- Default 80 if no production orders

### Commissioning Score (weight 10%)
- 100 if commissioning completed
- 40 if commissioning started but not completed
- 70 if commissioning not yet started

### Service Score (weight 5%)
- Start: 100
- -40 pts if > 5 open tickets
- -20 pts if > 2 open tickets
- -10 pts if > 0 open tickets

## Overall Health

```
Overall = Schedule×0.25 + Budget×0.20 + Quality×0.15
        + Procurement×0.15 + Production×0.10
        + Commissioning×0.10 + Service×0.05
```

## Labels

| Score | Label     | Color   |
|-------|-----------|---------|
| 85–100 | Excellent | Green  |
| 70–84  | Good      | Blue   |
| 50–69  | Watchlist | Amber  |
| 0–49   | Critical  | Red    |
