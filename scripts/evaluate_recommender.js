import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { sampleDestinations } from '../src/database/seeds/destinationsData.js';
import catalogueService from '../src/services/catalogue/catalogueService.js';
import tailoringRecommender from '../src/services/ai/tailoringRecommender.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../');

export function evaluateRecommender(db = null, customDataset = null, options = {}) {
  const database = db || getDatabase();
  tailoringRecommender.db = database;
  catalogueService.db = database;

  const includeUncertified = Boolean(
    options.includeUncertified || (typeof process !== 'undefined' && process.argv && process.argv.includes('--include-uncertified'))
  );

  // Ensure destinations exist in the database with their natural status (DO NOT force-certify!)
  const totalCount = database.prepare('SELECT COUNT(*) as count FROM destinations').get()?.count || 0;
  if (totalCount === 0) {
    runMigrations(database);
    for (const d of sampleDestinations) {
      try {
        catalogueService.createDestination(d);
      } catch {}
    }
  }

  const datasetPath = path.join(projectRoot, 'data/labelled_recommender_set.json');
  const dataset = customDataset || JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const items = dataset.items || [];
  const results = [];
  let totalPrecision10 = 0;
  let totalRecall = 0;
  let totalHits = 0;

  for (const item of items) {
    const recommendations = tailoringRecommender.recommendDestinations(item, 10, { includeUncertified });
    const top10 = recommendations.top_recommendations || [];

    // Match exact destination IDs from verified catalogue
    const hits = top10.filter((rec) => {
      return (item.relevant_destinations || []).includes(rec.destination_id);
    }).length;

    const precisionAt10 = hits / 10;
    const relevantTotal = item.relevant_destinations?.length || 0;
    const recall = relevantTotal > 0 ? hits / relevantTotal : 0;
    const maxPossibleHits = Math.min(10, relevantTotal || 1);
    const relevantCoverage = hits / maxPossibleHits;

    totalPrecision10 += precisionAt10;
    totalRecall += recall;
    totalHits += hits;

    results.push({
      item_id: item.id,
      title: item.title,
      relevant_count: relevantTotal,
      hits_in_top_10: hits,
      precision_at_10: Number(precisionAt10.toFixed(2)),
      recall: Number(recall.toFixed(2)),
      coverage_rate: Number(relevantCoverage.toFixed(2)),
      top_recommendations: top10.slice(0, 3).map(r => r.name)
    });
  }

  const averagePrecisionAt10 = items.length > 0 ? totalPrecision10 / items.length : 0;
  const averageRecall = items.length > 0 ? totalRecall / items.length : 0;
  const averageHitsPerQuery = items.length > 0 ? totalHits / items.length : 0;

  return {
    evaluated_at: new Date().toISOString(),
    dataset_notice: dataset._metadata?.notice || 'DRAFT - NEEDS HUMAN REVIEW',
    include_uncertified: includeUncertified,
    total_items_evaluated: items.length,
    average_precision_at_10: Number(averagePrecisionAt10.toFixed(4)),
    average_recall: Number(averageRecall.toFixed(4)),
    average_hits_in_top_10: Number(averageHitsPerQuery.toFixed(2)),
    results
  };
}

// Execute directly if run via node CLI
if (process.argv[1] && process.argv[1].endsWith('evaluate_recommender.js')) {
  const includeUncert = process.argv.includes('--include-uncertified');
  console.log(`--- IncuBrix Recommender Offline Evaluation (includeUncertified: ${includeUncert}) ---`);
  const report = evaluateRecommender(null, null, { includeUncertified: includeUncert });
  console.log(`Evaluated ${report.total_items_evaluated} content items against ${includeUncert ? 'entire catalogue (including uncertified)' : 'certified catalogue'}.`);
  console.log(`Average Precision@10: ${report.average_precision_at_10}`);
  console.log(`Average Recall: ${report.average_recall}`);
  console.log(`Average Relevant Hits in Top 10: ${report.average_hits_in_top_10}`);
  console.log(`Ground-Truth Status: ${report.dataset_notice}`);
  console.log('\nTop 5 Breakdown:');
  console.table(report.results.slice(0, 5).map(r => ({
    id: r.item_id,
    hits: r.hits_in_top_10,
    p10: r.precision_at_10,
    recall: r.recall,
    title: r.title.slice(0, 45) + '...'
  })));
  process.exit(0);
}

export default evaluateRecommender;
