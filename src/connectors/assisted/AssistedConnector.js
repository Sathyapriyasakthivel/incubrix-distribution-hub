import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import config from '../../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AssistedConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  async buildAssistPack(rendition, destination, idempotencyKey = null) {
    // Deterministic ID generation for idempotent regeneration
    const hashBasis = idempotencyKey || `${destination.id || destination.name}_${rendition.title}_${rendition.body}`;
    const hash = crypto.createHash('sha256').update(String(hashBasis)).digest('hex').slice(0, 12);
    const packId = `pack_${hash}`;

    const storageDir = path.join(config.paths.storage, 'assisted');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const mdFilePath = path.join(storageDir, `${packId}.md`);
    const jsonFilePath = path.join(storageDir, `${packId}.json`);

    // Prepare checklist according to destination policies
    const checklist = [
      {
        step: 1,
        title: 'Community Rules Verification',
        detail: `Review community guidelines at ${destination.rules_url || destination.url}. Confirm self-promotion is allowed (${destination.self_promo_allowed ? 'Allowed' : 'Strictly Prohibited'}).`
      },
      {
        step: 2,
        title: 'AI Disclosure Notice',
        detail: destination.disclosure_required || rendition.is_ai_generated
          ? 'Mandatory: Include the AI disclosure statement in your post body or preface.'
          : 'Optional: AI disclosure not strictly enforced by this destination.'
      },
      {
        step: 3,
        title: 'Content & Link Compliance',
        detail: `Verify links follow destination policy (${destination.link_policy || 'allowed'}). Ensure canonical URL is preserved.`
      },
      {
        step: 4,
        title: 'Manual Submission',
        detail: `Click destination link, open composer, paste formatted body, and publish.`
      },
      {
        step: 5,
        title: 'Record Confirmation',
        detail: 'After publishing, copy the resulting public link and register it back in IncuBrix.'
      }
    ];

    const disclosureText = '*[AI Disclosure: Portions of this content were generated or assisted with AI]*';

    // Build formatted caption / body
    let formattedBody = rendition.body || '';
    if (rendition.is_ai_generated || destination.disclosure_required) {
      if (!formattedBody.includes(disclosureText)) {
        formattedBody = `${disclosureText}\n\n${formattedBody}`;
      }
    }
    if (rendition.canonical_url && !formattedBody.includes(rendition.canonical_url)) {
      formattedBody += `\n\nCanonical link: ${rendition.canonical_url}`;
    }

    const caption = `${rendition.title || ''}\n\n${formattedBody}`;
    const tags = Array.isArray(rendition.tags) ? rendition.tags : [];

    const destinationRules = {
      rules_url: destination.rules_url || destination.url || null,
      frequency_cap: destination.frequency_cap || '1/7d',
      self_promo_allowed: destination.self_promo_allowed !== undefined ? destination.self_promo_allowed : 1,
      link_policy: destination.link_policy || 'allowed',
      disclosure_required: Boolean(destination.disclosure_required),
      automation_allowed: destination.automation_allowed !== undefined ? destination.automation_allowed : 0
    };

    // Write Markdown pack file
    const mdContent = `# IncuBrix Ready-to-Post Pack: ${destination.name || destination.id}
**Destination URL:** ${destination.url || 'N/A'}  
**Platform:** ${destination.platform_key || 'assisted'}  
**Frequency Cap:** ${destinationRules.frequency_cap}  
**Self-Promotion Policy:** ${destinationRules.self_promo_allowed ? 'Permitted' : 'Banned'}  
**Rules URL:** ${destinationRules.rules_url || 'N/A'}  

---

## Content Preview

### Title
\`\`\`
${rendition.title || ''}
\`\`\`

### Formatted Body
\`\`\`markdown
${formattedBody}
\`\`\`

### Canonical URL
${rendition.canonical_url || 'N/A'}

### Tags
${tags.length > 0 ? tags.map(t => `#${t}`).join(' ') : 'None'}

### Disclosure Notice
${disclosureText}

### Media Attachments
${(rendition.media_urls || []).length > 0 ? (rendition.media_urls || []).join('\n') : 'None'}

---

## Operator Posting Instructions
${checklist.map(c => `${c.step}. **${c.title}**: ${c.detail}`).join('\n')}
`;

    fs.writeFileSync(mdFilePath, mdContent, 'utf8');

    const packJson = {
      pack_id: packId,
      destination: {
        id: destination.id,
        name: destination.name,
        url: destination.url,
        platform_key: destination.platform_key
      },
      title: rendition.title || '',
      body: formattedBody,
      tags,
      destination_rules: destinationRules,
      posting_instructions: checklist,
      deep_link: destination.url || '',
      disclosure_text: disclosureText,
      rendition: {
        title: rendition.title,
        body: formattedBody,
        tags,
        canonical_url: rendition.canonical_url,
        media_urls: rendition.media_urls || [],
        is_ai_generated: Boolean(rendition.is_ai_generated),
        is_promotional: Boolean(rendition.is_promotional)
      },
      checklist,
      created_at: new Date().toISOString()
    };
    fs.writeFileSync(jsonFilePath, JSON.stringify(packJson, null, 2), 'utf8');

    const downloadBase = `${config.appUrl}/api/v1/storage/assisted`;

    return {
      pack_id: packId,
      title: rendition.title || '',
      body: formattedBody,
      tags,
      destination_rules: destinationRules,
      posting_instructions: checklist,
      deep_link: destination.url || '',
      disclosure_text: disclosureText,
      caption,
      checklist,
      files: [
        {
          name: `${packId}.md`,
          type: 'text/markdown',
          download_url: `${downloadBase}/${packId}.md`
        },
        {
          name: `${packId}.json`,
          type: 'application/json',
          download_url: `${downloadBase}/${packId}.json`
        }
      ]
    };
  }

  async publish(rendition, destination, connection = {}, idempotencyKey = null) {
    const pack = await this.buildAssistPack(rendition, destination, idempotencyKey);
    return {
      platform_post_id: pack.pack_id,
      live_url: pack.deep_link,
      status: 'assisted_pack_ready',
      pack
    };
  }

  async getStatus(platformPostId, connection = {}) {
    const storageDir = path.join(config.paths.storage, 'assisted');
    const jsonPath = path.join(storageDir, `${platformPostId}.json`);

    if (fs.existsSync(jsonPath)) {
      return {
        status: 'assisted_pack_ready',
        live_url: `${config.appUrl}/api/v1/storage/assisted/${platformPostId}.json`
      };
    }

    return {
      status: 'not_found',
      live_url: null
    };
  }

  async delete(platformPostId, connection = {}) {
    const storageDir = path.join(config.paths.storage, 'assisted');
    const mdPath = path.join(storageDir, `${platformPostId}.md`);
    const jsonPath = path.join(storageDir, `${platformPostId}.json`);

    let removed = false;
    if (fs.existsSync(mdPath)) {
      fs.unlinkSync(mdPath);
      removed = true;
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      removed = true;
    }

    return { deleted: true, removed_files: removed };
  }
}

export default AssistedConnector;
