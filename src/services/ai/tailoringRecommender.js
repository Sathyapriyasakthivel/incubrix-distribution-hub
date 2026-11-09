import { getDatabase } from '../../database/db.js';

export function truncateAtWordBoundary(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const targetLength = Math.max(1, maxChars - 3);
  const truncated = text.slice(0, targetLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

export class TailoringRecommenderService {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Tailor title and body for destination platform culture, format limits, and community rules
   */
  tailorContent(content, destination) {
    let tailoredTitle = content.title || '';
    let tailoredBody = content.body || '';
    const warnings = [];

    const platform = destination.platform_key;
    const maxTitle = destination.max_title_chars || (platform === 'lemmy' ? 200 : (platform === 'devto' ? 128 : 255));
    const maxBody = destination.max_body_chars || 32000;

    // 1. Automatic AI Disclosure
    if (destination.disclosure_required || content.is_ai_generated) {
      if (!tailoredBody.includes('[AI-Generated') && !tailoredBody.includes('[AI-Assisted')) {
        tailoredBody = `[AI-Generated Content: Disclosed in accordance with community guidelines]\n\n${tailoredBody}`;
        warnings.push('Added automatic AI content disclosure notice required by destination policy');
      }
    }

    // 2. Platform Culture Framing & Canonical URL
    switch (platform) {
      case 'discourse': {
        // Discussion-first framing for forums
        if (!tailoredTitle.startsWith('Discussion:') && !tailoredTitle.endsWith('?')) {
          tailoredTitle = `Discussion: ${tailoredTitle}`;
          warnings.push('Applied discussion-first title framing for forum culture');
        }
        if (!tailoredBody.includes('What are your thoughts')) {
          tailoredBody = `${tailoredBody}\n\nWhat are your thoughts on this approach? Looking forward to hearing how others in the community tackle this.`;
          warnings.push('Appended discussion-starter prompt to encourage community dialogue');
        }
        break;
      }

      case 'lemmy': {
        // Fediverse concise style + canonical link
        if (tailoredTitle.startsWith('Discussion:')) {
          tailoredTitle = tailoredTitle.replace(/^Discussion:\s*/i, '');
          warnings.push('Removed forum-style prefix for Fediverse concise standard');
        }
        if (content.canonical_url && !tailoredBody.includes(content.canonical_url)) {
          tailoredBody = `${tailoredBody}\n\n🔗 ${content.canonical_url}`;
          warnings.push('Appended canonical reference link for Fediverse community');
        }
        break;
      }

      case 'devto': {
        // Developer technical tutorial framing + canonical attribution
        if (!tailoredBody.includes('Originally published at') && content.canonical_url) {
          tailoredBody = `# ${content.title}\n\n${tailoredBody}\n\n---\n*Originally published at [${content.canonical_url}](${content.canonical_url})*`;
          warnings.push('Formatted developer tutorial structure and embedded canonical URL attribution');
        }
        break;
      }

      case 'hashnode': {
        if (!tailoredBody.includes('Originally published at') && content.canonical_url) {
          tailoredBody = `${tailoredBody}\n\n---\n*Originally published at [${content.canonical_url}](${content.canonical_url})*`;
          warnings.push('Appended canonical URL attribution to article body');
        }
        break;
      }

      case 'ghost': {
        // Clean editorial publication
        if (!tailoredBody.startsWith('<p>')) {
          tailoredBody = `<p>${tailoredBody.replace(/\n\n/g, '</p><p>')}</p>`;
          warnings.push('Formatted markdown into clean HTML paragraphs for Ghost editorial publication');
        }
        break;
      }

      default:
        break;
    }

    // 3. Hashtag/Tag formatting per platform style
    if (content.tags && Array.isArray(content.tags) && content.tags.length > 0) {
      if (platform === 'devto') {
        const formattedTags = content.tags.slice(0, 4).map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ''));
        warnings.push(`Formatted tags for Dev.to platform (lowercase without #, max 4): ${formattedTags.join(', ')}`);
      } else if (platform === 'lemmy' || platform === 'discourse') {
        const formattedHashtags = content.tags.map(t => `#${t.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
        warnings.push(`Formatted hashtags for community tagging: ${formattedHashtags.join(' ')}`);
      }
    }

    // 4. Truncation at word boundary
    if (tailoredTitle.length > maxTitle) {
      tailoredTitle = truncateAtWordBoundary(tailoredTitle, maxTitle);
      warnings.push(`Truncated title at word boundary to fit platform max limit (${maxTitle} chars)`);
    }
    if (tailoredBody.length > maxBody) {
      tailoredBody = truncateAtWordBoundary(tailoredBody, maxBody);
      warnings.push(`Truncated body at word boundary to fit platform max limit (${maxBody} chars)`);
    }

    return {
      title: tailoredTitle,
      body: tailoredBody,
      canonical_url: content.canonical_url || null,
      destination_id: destination.id,
      platform_key: destination.platform_key,
      warnings
    };
  }

  /**
   * Recommender: Rank destinations by fit (audience, rules, past results)
   * Evaluates top 10 precision on labelled test set
   */
  /**
   * Recommender: Rank destinations by fit (audience, rules, past results)
   * Evaluates top 10 precision on labelled test set
   */
  recommendDestinations(contentItem, limit = 10, options = {}) {
    const onlyCertified = options?.onlyCertified === true;
    const sql = onlyCertified
      ? `SELECT * FROM destinations WHERE is_enabled = 1 AND status = 'certified' ORDER BY relevance_score DESC, est_audience DESC`
      : `SELECT * FROM destinations WHERE is_enabled = 1 AND status != 'demoted' ORDER BY relevance_score DESC, est_audience DESC`;

    const destinations = this.db.query(sql);

    const titleLower = (contentItem.title || '').toLowerCase();
    const bodyLower = (contentItem.body || '').toLowerCase();
    const itemTags = (contentItem.tags || []).map(t => String(t).toLowerCase());
    const targetCats = (contentItem.target_categories || []).map(c => String(c).toLowerCase());
    const textToMatch = `${titleLower} ${bodyLower} ${itemTags.join(' ')} ${targetCats.join(' ')}`;
    const contentLang = (contentItem.language || 'en').toLowerCase();

    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasWord = (t, w) => new RegExp(`(^|[^a-z0-9])${escapeRegex(w)}($|[^a-z0-9])`, 'i').test(t);
    const hasAnyWord = (t, words) => words.some(w => hasWord(t, w));

    // High-signal topic keyword sets with word-boundary awareness
    const aiKeywords = ['ai', 'llm', 'gpt', 'rag', 'lora', 'finetuning', 'fine-tuning', 'transformers', 'prompt', 'prompts', 'agent', 'agents', 'machine learning', 'deep learning', 'pytorch', 'onnx', 'langchain', 'hugging face', 'huggingface', 'vector search', 'vectorsearch'];
    const saasKeywords = ['saas', 'analytics', 'founder', 'founders', 'b2b', 'mrr', 'churn', 'retention', 'activation', 'onboarding', 'funnel', 'pricing', 'freemium', 'paywall'];
    const systemsKeywords = ['rust', 'cargo', 'embedded', 'tokio', 'concurrency', 'wasm', 'kernel', 'allocator', 'linux', 'low-level', 'c++', 'hypervisor', 'kvm'];
    const videoKeywords = ['video', 'blender', 'cinema4d', 'render', 'rendering', 'vfx', 'animation', 'animators', 'davinci', 'color grading', 'creators', 'filmmaking', 'motion', 'unreal', 'three.js', 'threejs', '3d', 'webgl', 'cad', 'freecad', 'shaders'];

    const contentHasAi = hasAnyWord(textToMatch, aiKeywords);
    const contentHasSaas = hasAnyWord(textToMatch, saasKeywords);
    const contentHasSystems = hasAnyWord(textToMatch, systemsKeywords);
    const contentHasVideo = hasAnyWord(textToMatch, videoKeywords);

    const scored = destinations.map((d) => {
      let score = (d.relevance_score || 3) * 5; // base 5-25 points
      const reasons = [];

      const destLang = (d.language || 'en').toLowerCase();
      const destNameLower = (d.name || '').toLowerCase();
      const destCategoryLower = (d.category || '').toLowerCase();
      const destReasonLower = (d.relevance_reason || '').toLowerCase();

      // 1. Language affinity
      if (contentLang === destLang) {
        score += 20;
        reasons.push(`Language match (${destLang})`);
      } else {
        if (contentLang !== 'en' && destLang !== contentLang) {
          score -= 80; // Heavy penalty for non-matching regional language
        } else if (contentLang === 'en' && destLang !== 'en') {
          score -= 60; // English content should not route to non-English regional forum
        }
      }

      // 2. Audience tags alignment
      let audienceTags = [];
      try { audienceTags = JSON.parse(d.audience_tags || '[]'); } catch { audienceTags = []; }
      const audienceTagsLower = audienceTags.map(t => String(t).toLowerCase());

      const matchingTags = audienceTagsLower.filter(t => itemTags.includes(t));
      if (matchingTags.length > 0) {
        score += matchingTags.length * 15;
        reasons.push(`Direct audience tag match: ${matchingTags.slice(0, 3).join(', ')}`);
      }

      // 3. Category & Target Categories overlap
      const categoryMatches = targetCats.filter(cat => destCategoryLower.includes(cat) || audienceTagsLower.some(at => at.includes(cat)));
      if (categoryMatches.length > 0) {
        score += 25;
        reasons.push(`Target category match: ${categoryMatches.join(', ')}`);
      }

      // 4. Topic cluster alignment with word boundaries
      const destCombined = `${destNameLower} ${destCategoryLower} ${destReasonLower} ${audienceTagsLower.join(' ')}`;
      
      const destIsAi = hasAnyWord(destCombined, ['ai', 'machine learning', 'deep learning', 'neural', 'artificial intelligence', 'llm', 'nlp', 'data science', 'hugging face', 'openai', 'pytorch']);
      const destIsSaas = hasAnyWord(destCombined, ['saas', 'product analytics', 'founders', 'growth', 'startups', 'entrepreneurship', 'b2b', 'posthog']);
      const destIsSystems = hasAnyWord(destCombined, ['systems', 'rust', 'kernel', 'embedded', 'linux', 'hardware', 'c++', 'infrastructure', 'virtualization', 'arch', 'debian', 'proxmox']);
      const destIsVideo = hasAnyWord(destCombined, ['3d', 'animation', 'video', 'vfx', 'rendering', 'cad', 'creators', 'filmmaking', 'blender', 'webgl', 'three.js', 'threejs', 'graphics', 'rhino', 'godot']);

      if (contentHasAi && destIsAi) {
        score += 35;
        reasons.push('High topic overlap with AI engineering');
      } else if (contentHasAi && !destIsAi && (destIsVideo || destIsSaas)) {
        score -= 20; // Topic mismatch penalty
      }

      if (contentHasSaas && destIsSaas) {
        score += 35;
        reasons.push('Matches SaaS founders and product audience');
      } else if (contentHasSaas && !destIsSaas && (destIsVideo || destIsSystems)) {
        score -= 20;
      }

      if (contentHasSystems && destIsSystems) {
        score += 35;
        reasons.push('Fits systems and low-level engineering');
      } else if (contentHasSystems && !destIsSystems && (destIsVideo || destIsSaas)) {
        score -= 20;
      }

      if (contentHasVideo && destIsVideo) {
        score += 35;
        reasons.push('Fits video and 3D creator demographic');
      } else if (contentHasVideo && !destIsVideo && (destIsAi || destIsSaas || destIsSystems)) {
        score -= 20;
      }

      // 5. Named entity direct affinity (e.g. OpenAI forum for OpenAI article, HuggingFace, Nextcloud, etc.)
      const destTokens = destNameLower.split(/[^a-z0-9]+/).filter(tok => tok.length >= 4 && !['forum', 'community', 'hub', 'official', 'discussions'].includes(tok));
      const directEntityMatch = destTokens.some(tok => textToMatch.includes(tok));
      if (directEntityMatch) {
        score += 20;
        reasons.push('Direct brand/platform entity affinity');
      }

      // 6. Check self-promotion rules compatibility
      if (!d.self_promo_allowed && contentItem.is_promotional) {
        score -= 35;
        reasons.push('Penalized: Destination strictly bans self-promotion');
      }

      // 7. Check link policy
      if (d.link_policy === 'no_links' && contentItem.canonical_url) {
        score -= 15;
        reasons.push('Warning: Destination prohibits external links');
      }

      // 8. Status and Level boost
      if (d.status === 'certified') {
        score += 15;
        reasons.push('Certified and verified operational');
      }
      if (d.level === 'L3') score += 10;
      else if (d.level === 'L2') score += 6;
      else if (d.level === 'L1') score += 3;

      // 9. Past results (success rate from publications)
      const pastStats = this.db.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status IN ('succeeded', 'published') THEN 1 ELSE 0 END) as successful
        FROM publications
        WHERE destination_id = ?
      `, d.id);
      if (pastStats && pastStats.total > 0) {
        const successRate = Math.round((pastStats.successful / pastStats.total) * 100);
        if (successRate >= 80) {
          score += 15;
          reasons.push(`High historical publication success rate (${successRate}%)`);
        } else if (successRate < 50) {
          score -= 20;
          reasons.push(`Low historical publication success rate (${successRate}%)`);
        }
      }

      const finalScore = Math.min(100, Math.max(5, score));

      return {
        destination_id: d.id,
        name: d.name,
        platform_key: d.platform_key,
        category: d.category,
        url: d.url,
        match_score: finalScore,
        reasons: reasons.length > 0 ? reasons : ['General audience reach based on category fit'],
        self_promo_allowed: Boolean(d.self_promo_allowed),
        status: d.status
      };
    });

    scored.sort((a, b) => {
      const aCert = a.status === 'certified' ? 1 : 0;
      const bCert = b.status === 'certified' ? 1 : 0;
      if (aCert !== bCert) return bCert - aCert;
      return b.match_score - a.match_score;
    });
    const topRanked = scored.slice(0, limit).map((item, idx) => ({
      rank: idx + 1,
      ...item
    }));

    return {
      total_evaluated: destinations.length,
      top_recommendations: topRanked
    };
  }

  /**
   * Rules capture: AI step reads community rules page and proposes posting rules.
   * Uses real RulesCaptureAdapter.
   */
  async captureRulesFromUrl(rulesUrl, platformKey) {
    const { default: rulesCaptureAdapter } = await import('./rulesCaptureAdapter.js');
    return await rulesCaptureAdapter.captureRules(rulesUrl);
  }
}

export const tailoringRecommender = new TailoringRecommenderService();
export default tailoringRecommender;

