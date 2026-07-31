const { BigQuery } = require('@google-cloud/bigquery');
const monitoring = require('@google-cloud/monitoring');

const PROJECT_ID = 'yeschef-c572a';
const TABLE = '`yeschef-c572a.billing_export.gcp_billing_export_v1_01C227_F4CE93_C7189F`';

const bq = new BigQuery({ projectId: PROJECT_ID });
const metricClient = new monitoring.MetricServiceClient();

// Writes yesterday's GROSS spend (SUM(cost), i.e. list cost BEFORE credits/discounts) broken out
// PER SERVICE, so the dashboard shows how spend splits across Compute Engine, Artifact Registry,
// etc. — matching the Cloud Billing report. Net-of-credit cost is ~$0 here (free-tier/credits),
// which is why we chart gross. One point per service per day, tagged with the `service` label.
exports.billingDailyCost = async (req, res) => {
  const [rows] = await bq.query({
    query: `
      SELECT DATE(usage_start_time) AS d, service.description AS service, SUM(cost) AS cost
      FROM ${TABLE}
      WHERE DATE(usage_start_time) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      GROUP BY d, service
      HAVING cost > 0
      ORDER BY cost DESC
    `,
  });

  if (!rows.length) {
    console.log('No billing rows yet for yesterday — export likely still backfilling.');
    res.status(200).send('no data yet');
    return;
  }

  const dateStr = (rows[0].d.value || rows[0].d);
  const endSeconds = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000) + 86400;
  const point = (type, labels, cost) => ({
    metric: { type, labels },
    resource: { type: 'global', labels: { project_id: PROJECT_ID } },
    points: [{ interval: { endTime: { seconds: endSeconds } }, value: { doubleValue: Number(cost) || 0 } }],
  });

  // Per-service breakdown (for the "how am I charged" view) AND the running daily TOTAL (the
  // historical daily_cost_usd series — keep writing it so its multi-day history keeps growing;
  // do NOT drop it, the dashboard's Daily/Monthly cost tiles depend on it).
  const perService = rows.map((r) => point('custom.googleapis.com/billing/cost_by_service_usd', { service: r.service || 'Other' }, r.cost));
  const total = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  // The dashboard splits cost per app by FILTERING cost_by_service_usd on the `service` label
  // (Compute Engine = yeschef-llm, everything else = yeschef) — no separate per-app metric.
  const timeSeries = [...perService, point('custom.googleapis.com/billing/daily_cost_usd', {}, total)];

  await metricClient.createTimeSeries({
    name: metricClient.projectPath(PROJECT_ID),
    timeSeries,
  });

  console.log(`Wrote total $${total.toFixed(2)} + ${perService.length} per-service point(s) for ${dateStr}`);
  res.status(200).send(`wrote ${timeSeries.length} points`);
};
