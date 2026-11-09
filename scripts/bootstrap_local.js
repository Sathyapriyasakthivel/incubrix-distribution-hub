import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import logger from '../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function isPlaceholderOrMissing(val, type) {
  if (!val || typeof val !== 'string' || val.trim() === '') {
    return true;
  }
  const clean = val.trim();
  if (clean.includes('placeholder') || clean.includes('your_') || clean.endsWith('...')) {
    return true;
  }
  if (type === 'ghost') {
    if (clean.includes('64f1a2b3c4d5e6f7a8b9c0d1') || clean.includes('0123456789abcdef')) {
      return true;
    }
    const parts = clean.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length !== 24 || parts[1].length !== 64) {
      return true;
    }
  } else if (type === 'lemmy') {
    if (clean.includes('lemmy_local_jwt') || clean.includes('lemmy_mock_jwt')) {
      return true;
    }
    const parts = clean.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      return true;
    }
  }
  return false;
}

export async function checkUrlReachable(url, timeoutMs = 2000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok || resp.status < 500;
  } catch {
    return false;
  }
}

export async function setupGhost(ghostUrl = process.env.GHOST_LOCAL_URL || 'http://localhost:2368') {
  const cleanUrl = ghostUrl.replace(/\/+$/, '');
  logger.info(`Checking Ghost 5 instance at ${cleanUrl}...`);

  const reachable = await checkUrlReachable(`${cleanUrl}/ghost/api/admin/site/`);
  if (!reachable) {
    logger.warn(`Ghost instance at ${cleanUrl} not reachable.`);
    return {
      adminKey: null,
      url: cleanUrl,
      isLive: false
    };
  }

  if (!isPlaceholderOrMissing(process.env.GHOST_ADMIN_KEY, 'ghost')) {
    return {
      adminKey: process.env.GHOST_ADMIN_KEY,
      url: cleanUrl,
      isLive: true
    };
  }

  try {
    // 1. Initial admin user setup if first run
    const setupResp = await fetch(`${cleanUrl}/ghost/api/admin/authentication/setup/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup: [{
          name: 'IncuBrix Admin',
          email: 'admin@incubrix.local',
          password: 'IncuBrixAdminPassword123!',
          blogTitle: 'IncuBrix Distribution Node'
        }]
      })
    }).catch(() => null);

    // 2. Authenticate to establish session
    const sessionResp = await fetch(`${cleanUrl}/ghost/api/admin/authentication/session/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin@incubrix.local',
        password: 'IncuBrixAdminPassword123!'
      })
    }).catch(() => null);

    const cookie = sessionResp ? sessionResp.headers.get('set-cookie') : null;

    // 3. Create Custom Integration to obtain Admin API Key
    if (cookie) {
      const integResp = await fetch(`${cleanUrl}/ghost/api/admin/integrations/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie
        },
        body: JSON.stringify({
          integrations: [{
            name: 'IncuBrix Distribution Engine',
            type: 'custom'
          }]
        })
      });

      if (integResp.ok) {
        const body = await integResp.json();
        const integration = body.integrations?.[0];
        const adminApiKeyObj = integration?.api_keys?.find(k => k.type === 'admin');
        if (adminApiKeyObj) {
          const adminKey = `${adminApiKeyObj.id}:${adminApiKeyObj.secret}`;
          logger.info(`Ghost Custom Integration created! Admin API Key: ${adminKey}`);
          return { adminKey, url: cleanUrl, isLive: true };
        }
      }
    }
  } catch (err) {
    logger.warn(`Ghost setup API interaction failed: ${err.message}`);
  }

  return { adminKey: null, url: cleanUrl, isLive: true };
}

export async function setupLemmy(lemmyUrl = process.env.LEMMY_LOCAL_URL || 'http://localhost:8536') {
  const cleanUrl = lemmyUrl.replace(/\/+$/, '');
  logger.info(`Checking Lemmy 0.19.x instance at ${cleanUrl}...`);

  const reachable = await checkUrlReachable(`${cleanUrl}/api/v3/site`);
  if (!reachable) {
    logger.warn(`Lemmy instance at ${cleanUrl} not reachable.`);
    return {
      jwt: null,
      communityId: null,
      url: cleanUrl,
      isLive: false
    };
  }

  let jwt = !isPlaceholderOrMissing(process.env.LEMMY_JWT_TOKEN, 'lemmy')
    ? process.env.LEMMY_JWT_TOKEN
    : null;

  try {
    if (!jwt) {
      // Login with setup credentials defined in config/lemmy.hjson
      const loginResp = await fetch(`${cleanUrl}/api/v3/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username_or_email: 'incubrix_admin',
          password: 'incubrix_secure_password_123'
        })
      });

      if (loginResp.ok) {
        const loginBody = await loginResp.json();
        jwt = loginBody.jwt;
        logger.info('Lemmy admin login succeeded; retrieved JWT session.');
      }
    }

    if (jwt) {
      let communityId = null;
      if (process.env.LEMMY_COMMUNITY_ID && !isNaN(parseInt(process.env.LEMMY_COMMUNITY_ID, 10)) && parseInt(process.env.LEMMY_COMMUNITY_ID, 10) > 0) {
        communityId = parseInt(process.env.LEMMY_COMMUNITY_ID, 10);
      }

      if (!communityId) {
        // Create community 'incubrix_tech' using Authorization header only
        const commResp = await fetch(`${cleanUrl}/api/v3/community`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`
          },
          body: JSON.stringify({
            name: 'incubrix_tech',
            title: 'IncuBrix Tech Distribution Community'
          })
        });

        if (commResp.ok) {
          const commBody = await commResp.json();
          communityId = commBody.community_view?.community?.id;
          if (communityId) {
            logger.info(`Created Lemmy community 'incubrix_tech' (id: ${communityId})`);
          }
        } else {
          // May already exist; fetch community ID using Authorization header only
          const getCommResp = await fetch(`${cleanUrl}/api/v3/community?name=incubrix_tech`, {
            headers: {
              Authorization: `Bearer ${jwt}`
            }
          });
          if (getCommResp.ok) {
            const existingComm = await getCommResp.json();
            communityId = existingComm.community_view?.community?.id;
            if (communityId) {
              logger.info(`Found existing Lemmy community 'incubrix_tech' (id: ${communityId})`);
            }
          }
        }
      }

      if (!communityId) {
        throw new Error(`Failed to create or lookup Lemmy community 'incubrix_tech' at ${cleanUrl}. Lemmy requires a valid community for posting.`);
      }

      return { jwt, communityId, url: cleanUrl, isLive: true };
    }
  } catch (err) {
    logger.warn(`Lemmy API setup interaction failed: ${err.message}`);
    throw err;
  }

  return {
    jwt: null,
    communityId: null,
    url: cleanUrl,
    isLive: true
  };
}

export function updateEnvFile(updates) {
  const envPath = path.join(rootDir, '.env');
  const envExamplePath = path.join(rootDir, '.env.example');

  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else if (fs.existsSync(envExamplePath)) {
    content = fs.readFileSync(envExamplePath, 'utf8');
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }

  fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
  logger.info(`Updated .env file with local test configuration.`);
}

export function seedLocalDestinations(db = getDatabase(), config) {
  runMigrations(db);
  const now = new Date().toISOString();

  // 1. Seed local-ghost destination with simulation_mode = 0 and secret_ref
  db.run(`
    INSERT OR REPLACE INTO destinations (
      id, name, url, platform_key, surface, category, audience_tags,
      language, geo, est_audience, rules_url, frequency_cap,
      self_promo_allowed, link_policy, disclosure_required, automation_allowed,
      connector_key, relevance_score, relevance_reason, level,
      is_enabled, simulation_mode, status, secret_ref, created_at, updated_at
    ) VALUES (
      'local-ghost', 'Local Ghost CMS Instance', ?, 'ghost', 'article',
      'Publishing & CMS', '["CMS","Publishing","Creators"]', 'en', 'global', 1000,
      ?, '10/24h', 1, 'allowed', 0, 1, 'ghost', 5,
      'Local Ghost 5 CMS instance with SQLite for live integration testing.',
      'L0', 1, 0, 'catalogued', 'GHOST_ADMIN_KEY', ?, ?
    )
  `, config.ghostUrl, `${config.ghostUrl}/rules`, now, now);

  db.run(`
    INSERT OR REPLACE INTO auth_configs (id, destination_id, auth_type, credentials, secret_ref, expires_at, created_at)
    VALUES (?, 'local-ghost', 'admin_key', ?, 'GHOST_ADMIN_KEY', NULL, ?)
  `, 'auth_local_ghost', JSON.stringify({ base_url: config.ghostUrl, admin_key: config.ghostAdminKey }), now);

  logger.info(`Seeded local-ghost destination with simulation_mode = 0.`);

  // 2. Seed local-lemmy destination with simulation_mode = 0 and secret_ref
  db.run(`
    INSERT OR REPLACE INTO destinations (
      id, name, url, platform_key, surface, category, audience_tags,
      language, geo, est_audience, rules_url, frequency_cap,
      self_promo_allowed, link_policy, disclosure_required, automation_allowed,
      connector_key, relevance_score, relevance_reason, level,
      is_enabled, simulation_mode, status, secret_ref, created_at, updated_at
    ) VALUES (
      'local-lemmy', 'Local Lemmy Instance (incubrix_tech)', ?, 'lemmy', 'post',
      'Federated Community', '["Tech","OpenSource","Federation"]', 'en', 'global', 500,
      ?, '10/24h', 1, 'allowed', 1, 1, 'lemmy', 5,
      'Local Lemmy 0.19.x federated community for live integration testing.',
      'L0', 1, 0, 'catalogued', 'LEMMY_JWT_TOKEN', ?, ?
    )
  `, config.lemmyUrl, `${config.lemmyUrl}/rules`, now, now);

  db.run(`
    INSERT OR REPLACE INTO auth_configs (id, destination_id, auth_type, credentials, secret_ref, expires_at, created_at)
    VALUES (?, 'local-lemmy', 'jwt', ?, 'LEMMY_JWT_TOKEN', NULL, ?)
  `, 'auth_local_lemmy', JSON.stringify({ base_url: config.lemmyUrl, community_id: config.lemmyCommunityId, jwt: config.lemmyJwt }), now);

  logger.info(`Seeded local-lemmy destination with simulation_mode = 0.`);
}

export async function bootstrapLocal() {
  console.log('====================================================');
  console.log('      IncuBrix Local Test Instances Bootstrapper    ');
  console.log('====================================================');

  const ghostUrl = process.env.GHOST_LOCAL_URL || 'http://localhost:2368';
  const lemmyUrl = process.env.LEMMY_LOCAL_URL || 'http://localhost:8536';

  const ghostAdminKey = process.env.GHOST_ADMIN_KEY;
  const lemmyJwtToken = process.env.LEMMY_JWT_TOKEN;

  const ghostMissing = isPlaceholderOrMissing(ghostAdminKey, 'ghost');
  const lemmyMissing = isPlaceholderOrMissing(lemmyJwtToken, 'lemmy');

  if (ghostMissing || lemmyMissing) {
    console.error('\n========================================================================');
    console.error('[ERROR] Missing or placeholder credentials for local test instances in .env');
    console.error('bootstrap_local.js must never invent fake credentials.');
    if (ghostMissing) {
      console.error('\nGHOST_ADMIN_KEY is missing or invalid:');
      console.error('  1. Start Ghost (e.g. `docker compose up -d ghost`)');
      console.error('  2. Open http://localhost:2368/ghost and finish admin setup');
      console.error('  3. In Ghost Admin, navigate to Settings -> Integrations -> Add custom integration');
      console.error('  4. Copy the Admin API Key and set in .env:');
      console.error('     GHOST_ADMIN_KEY=<id>:<secret>');
    }
    if (lemmyMissing) {
      console.error('\nLEMMY_JWT_TOKEN is missing or invalid:');
      console.error('  1. Start Lemmy & Postgres (e.g. `docker compose up -d lemmy`)');
      console.error('  2. Log in using admin credentials defined in config/lemmy.hjson:');
      console.error('     curl -s -X POST http://localhost:8536/api/v3/user/login \\');
      console.error('       -H "Content-Type: application/json" \\');
      console.error('       -d \'{"username_or_email":"incubrix_admin","password":"incubrix_secure_password_123"}\'');
      console.error('  3. Copy the "jwt" field from the response and set in .env:');
      console.error('     LEMMY_JWT_TOKEN=<jwt>');
      console.error('     LEMMY_COMMUNITY_ID=1');
    }
    console.error('========================================================================\n');
    process.exit(1);
  }

  // Real credentials exist in .env: never invent or overwrite credentials in .env.
  let lemmyCommunityId = null;
  if (process.env.LEMMY_COMMUNITY_ID && !isNaN(parseInt(process.env.LEMMY_COMMUNITY_ID, 10)) && parseInt(process.env.LEMMY_COMMUNITY_ID, 10) > 0) {
    lemmyCommunityId = parseInt(process.env.LEMMY_COMMUNITY_ID, 10);
  }

  if (!lemmyCommunityId) {
    const lemmyResult = await setupLemmy(lemmyUrl);
    if (!lemmyResult.communityId) {
      throw new Error(`Failed to resolve community id for Lemmy instance at ${lemmyUrl}`);
    }
    lemmyCommunityId = lemmyResult.communityId;
  }

  // Real values are present! Never overwrite them in .env.
  const db = getDatabase();
  seedLocalDestinations(db, {
    ghostUrl,
    ghostAdminKey,
    lemmyUrl,
    lemmyJwt: lemmyJwtToken,
    lemmyCommunityId
  });

  console.log('\nBootstrap Complete!');
  console.log('----------------------------------------------------');
  console.log(`Ghost URL:       ${ghostUrl}`);
  console.log(`Ghost Admin Key: ${ghostAdminKey.slice(0, 10)}... (real)`);
  console.log(`Lemmy URL:       ${lemmyUrl}`);
  console.log(`Lemmy JWT Token: ${lemmyJwtToken.slice(0, 20)}... (real)`);
  console.log(`Lemmy Community: ${lemmyCommunityId}`);
  console.log('Destinations Seeded: local-ghost, local-lemmy (simulation_mode = 0)');
  console.log('====================================================\n');

  return {
    ghost: { url: ghostUrl, adminKey: ghostAdminKey, isLive: true },
    lemmy: { url: lemmyUrl, jwt: lemmyJwtToken, communityId: lemmyCommunityId, isLive: true }
  };
}

if (process.argv[1] && process.argv[1].endsWith('bootstrap_local.js')) {
  bootstrapLocal()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Bootstrap failed:', err);
      process.exit(1);
    });
}

export default bootstrapLocal;
